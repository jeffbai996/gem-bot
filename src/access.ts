import fs from 'fs/promises'
import path from 'path'
import os from 'os'

export type ThinkingMode = 'always' | 'auto' | 'never' | 'collapse'

// Chat engine for a channel. 'api' = the metered Gemini API (full tools +
// grounding + trace). 'agy' = route text turns through the Antigravity CLI
// (flat Google sub, no visible tool-trace). Media turns always use 'api'
// regardless — agy -p is text-only.
export type ChatEngine = 'agy' | 'api'

// Footer counter mode. off = no footer; token = elapsed time + tokens-if-
// available (degrades to time-only on the agy engine, which emits no token
// counts); both = token + cached-prefix detail when a cache hit occurred.
// Split out of the old `verbose` flag (2026-06-28) — verbose used to gate BOTH
// the footer and the 🧠 native-reasoning block; the footer now lives here and
// the reasoning block rides the `thinking` mode.
export type CounterMode = 'off' | 'token' | 'both'

// Tool-trace card mode. off = no dedicated trace card (default — opt-in, like
// gpt-bot); on = post a 🔧 **Tool trace** card ABOVE the reply and keep it;
// collapse = post it live then delete after the reply lands. Distinct from the
// `showCode` artifact dump — this is the gpt-bot-style dedicated diff-fence card.
export type TraceMode = 'off' | 'on' | 'collapse'

export interface ChannelConfig {
  enabled: boolean
  requireMention: boolean
  thinking?: ThinkingMode  // default "auto" — Gemma decides per message
  showCode?: boolean       // default true — render code-exec artifacts + tool calls
  trace?: TraceMode        // default "off" — gpt-bot-style 🔧 Tool-trace card (off | on | collapse)
  counter?: CounterMode    // default "token" — usage/timing footer (off | token | both)
  cache?: boolean          // default true — cache the stable system-prompt prefix server-side
  cacheTtlSec?: number     // optional — override the cache TTL (seconds). Falls back to manager default when unset
  engine?: ChatEngine      // optional — per-channel chat engine. UNSET = fall back to the GEMMA_AGY_CHAT env default
}

export interface ChannelFlags {
  thinking: ThinkingMode
  showCode: boolean
  trace: TraceMode
  counter: CounterMode
  cache: boolean
  cacheTtlSec: number | null
  // null = no per-channel choice — the gemma.ts callsite falls back to the
  // GEMMA_AGY_CHAT env default. 'agy' | 'api' = an explicit per-channel pick.
  engine: ChatEngine | null
  // requireMention isn't a "rendering" flag like the others — it sits at the
  // top of ChannelConfig — but exposing it through ChannelFlags lets the
  // /gemini set unified setter touch it without a separate command path.
  requireMention?: boolean
}

export interface AccessFile {
  users: Record<string, { allowed: boolean }>
  channels: Record<string, ChannelConfig>
}

export interface CanHandleInput {
  channelId: string
  userId: string
  isMention: boolean
}

const EMPTY: AccessFile = { users: {}, channels: {} }
const VALID_THINKING_MODES: ThinkingMode[] = ['always', 'auto', 'never', 'collapse']
const VALID_ENGINES: ChatEngine[] = ['agy', 'api']
const VALID_COUNTER_MODES: CounterMode[] = ['off', 'token', 'both']
const VALID_TRACE_MODES: TraceMode[] = ['off', 'on', 'collapse']

// Default rendering/behavior flags applied when a channel is first configured
// without explicit flag overrides, and when channelFlags() is asked about an
// unknown channel. showCode/cache default true — more transparent output +
// cheaper bills. thinking stays "auto" since "always" is too verbose for
// casual chat. counter defaults to "token" — preserves the prior effective
// behavior (verbose defaulted true, i.e. footer ON with tokens-if-available)
// after the 2026-06-28 verbose→counter split, so existing channels don't
// silently lose their footer. The optInReply gate was removed 2026-05-02.
const DEFAULT_FLAGS = {
  thinking: 'auto' as ThinkingMode,
  showCode: true,
  // trace defaults OFF — matches gpt-bot. The dedicated 🔧 Tool-trace card is
  // opt-in so enabling the feature doesn't suddenly spam every channel; the
  // inline showCode tool dump remains the always-on surface.
  trace: 'off' as TraceMode,
  counter: 'token' as CounterMode,
  cache: true,
}

export class AccessManager {
  private stateDir: string
  private file: string
  private data: AccessFile = { ...EMPTY }

  constructor() {
    this.stateDir = process.env.DISCORD_STATE_DIR || path.join(os.homedir(), '.gemini', 'channels', 'discord')
    this.file = path.join(this.stateDir, 'access.json')
  }

  async load(): Promise<void> {
    await fs.mkdir(this.stateDir, { recursive: true })
    try {
      const raw = await fs.readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw) as Partial<AccessFile>
      this.data = {
        users: parsed.users ?? {},
        channels: parsed.channels ?? {}
      }
    } catch (e: any) {
      if (e.code === 'ENOENT') {
        this.data = { ...EMPTY }
        await fs.writeFile(this.file, JSON.stringify(this.data, null, 2), 'utf8')
      } else {
        throw e
      }
    }
  }

  async save(): Promise<void> {
    await fs.writeFile(this.file, JSON.stringify(this.data, null, 2), 'utf8')
  }

  canHandle({ channelId, userId, isMention }: CanHandleInput): boolean {
    const user = this.data.users[userId]
    if (!user?.allowed) return false

    const channel = this.data.channels[channelId]
    if (!channel?.enabled) return false

    if (channel.requireMention && !isMention) return false

    return true
  }

  // Reactions don't have a mention concept; they only require the user
  // to be allowlisted and the channel to be enabled.
  canReact(userId: string, channelId: string): boolean {
    const user = this.data.users[userId]
    if (!user?.allowed) return false
    const channel = this.data.channels[channelId]
    if (!channel?.enabled) return false
    return true
  }

  // Same predicate as canReact, exposed for the background memory-ingestion
  // path which embeds passive (non-mention) messages from allowed users in
  // enabled channels — independent of canHandle's requireMention gate.
  isAllowedAndEnabled(userId: string, channelId: string): boolean {
    return this.canReact(userId, channelId)
  }

  // Channel-independent user gate. A slash command like /voice isn't tied to a
  // text channel's enabled/requireMention flags — what matters is only whether
  // this person is on the allowlist at all. Reuses the same users map as
  // canHandle so "who can voice" tracks "who can text" automatically.
  isUserAllowed(userId: string): boolean {
    return this.data.users[userId]?.allowed === true
  }

  async allowUser(userId: string): Promise<void> {
    this.data.users[userId] = { allowed: true }
    await this.save()
  }

  async revokeUser(userId: string): Promise<void> {
    this.data.users[userId] = { allowed: false }
    await this.save()
  }

  async setChannel(
    channelId: string,
    enabled: boolean,
    requireMention: boolean,
    flags?: Partial<ChannelFlags>
  ): Promise<void> {
    if (flags?.thinking !== undefined && !VALID_THINKING_MODES.includes(flags.thinking)) {
      throw new Error(`invalid thinking mode "${flags.thinking}" — must be one of: always, auto, never`)
    }
    // Preserve existing flag values when re-running /gemini channel on an
    // already-configured channel. Only enabled+requireMention are mandatory;
    // anything not in the flags patch falls back to the existing value, then
    // the global default. Without this, calling /gemini channel a second time
    // would silently reset thinking/showCode/counter/etc back to defaults.
    const existing = this.data.channels[channelId]
    this.data.channels[channelId] = {
      enabled,
      requireMention,
      thinking: flags?.thinking ?? existing?.thinking ?? DEFAULT_FLAGS.thinking,
      showCode: flags?.showCode ?? existing?.showCode ?? DEFAULT_FLAGS.showCode,
      trace: flags?.trace ?? existing?.trace ?? DEFAULT_FLAGS.trace,
      counter: flags?.counter ?? existing?.counter ?? DEFAULT_FLAGS.counter,
      cache: flags?.cache ?? existing?.cache ?? DEFAULT_FLAGS.cache,
      ...(flags?.cacheTtlSec != null
        ? { cacheTtlSec: flags.cacheTtlSec }
        : existing?.cacheTtlSec != null ? { cacheTtlSec: existing.cacheTtlSec } : {}),
      // engine has no DEFAULT_FLAGS fallback — an unset engine means "use the
      // GEMMA_AGY_CHAT env default", so preserve an existing pick but never
      // invent one here.
      ...(flags?.engine != null
        ? { engine: flags.engine }
        : existing?.engine != null ? { engine: existing.engine } : {})
    }
    await this.save()
  }

  // Update only the rendering flags without touching enabled/requireMention.
  // Throws if the channel isn't configured yet — admins should run /gemini channel first.
  async setChannelFlags(
    channelId: string,
    patch: Partial<ChannelFlags>
  ): Promise<ChannelConfig> {
    const existing = this.data.channels[channelId]
    if (!existing) {
      throw new Error(`channel ${channelId} not configured — run /gemini channel first`)
    }
    if (patch.thinking !== undefined && !VALID_THINKING_MODES.includes(patch.thinking)) {
      throw new Error(`invalid thinking mode "${patch.thinking}" — must be one of: always, auto, never`)
    }
    if (patch.engine != null && !VALID_ENGINES.includes(patch.engine)) {
      throw new Error(`invalid engine "${patch.engine}" — must be one of: agy, api`)
    }
    if (patch.counter !== undefined && !VALID_COUNTER_MODES.includes(patch.counter)) {
      throw new Error(`invalid counter "${patch.counter}" — must be one of: off, token, both`)
    }
    if (patch.trace !== undefined && !VALID_TRACE_MODES.includes(patch.trace)) {
      throw new Error(`invalid trace "${patch.trace}" — must be one of: off, on, collapse`)
    }
    this.data.channels[channelId] = {
      ...existing,
      ...(patch.thinking !== undefined ? { thinking: patch.thinking } : {}),
      ...(patch.showCode !== undefined ? { showCode: patch.showCode } : {}),
      ...(patch.trace !== undefined ? { trace: patch.trace } : {}),
      ...(patch.counter !== undefined ? { counter: patch.counter } : {}),
      ...(patch.cache !== undefined ? { cache: patch.cache } : {}),
      ...(patch.requireMention !== undefined ? { requireMention: patch.requireMention } : {}),
      // null sentinel = clear the override (back to manager default).
      // Skipping the field entirely means "leave existing override alone".
      ...(patch.cacheTtlSec === null
        ? { cacheTtlSec: undefined }
        : patch.cacheTtlSec !== undefined ? { cacheTtlSec: patch.cacheTtlSec } : {}),
      // engine: null sentinel clears the per-channel pick (back to the env
      // default); an explicit 'agy'|'api' sets it; undefined leaves it alone.
      ...(patch.engine === null
        ? { engine: undefined }
        : patch.engine !== undefined ? { engine: patch.engine } : {})
    }
    await this.save()
    return this.data.channels[channelId]
  }

  // Per-channel rendering flags. Returns defaults for unknown channels and
  // for old configs that don't have these fields yet.
  channelFlags(channelId: string): ChannelFlags {
    const channel = this.data.channels[channelId]
    return {
      thinking: channel?.thinking ?? DEFAULT_FLAGS.thinking,
      showCode: channel?.showCode ?? DEFAULT_FLAGS.showCode,
      trace: channel?.trace ?? DEFAULT_FLAGS.trace,
      counter: channel?.counter ?? DEFAULT_FLAGS.counter,
      cache: channel?.cache ?? DEFAULT_FLAGS.cache,
      cacheTtlSec: channel?.cacheTtlSec ?? null,
      // null = no per-channel pick → callsite falls back to GEMMA_AGY_CHAT.
      engine: channel?.engine ?? null
    }
  }
}
