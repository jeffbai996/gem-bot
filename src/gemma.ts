import { Client, GatewayIntentBits, Partials, ActivityType, REST, Routes, type Message } from 'discord.js'
import path from 'path'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import os from 'os'
import dotenv from 'dotenv'
import { AccessManager } from './access.ts'
import { isAddressedToAnotherBot } from './mention-gate.ts'
import { PersonaLoader } from './persona.ts'
import { buildContextHistory, stripBotMetadata } from './history.ts'
import { processAttachments, processYouTubeUrls, type InputAttachment } from './attachments.ts'
import { GeminiClient, stripDuplicateCodeBlocks, GeminiRequestRejected, formatGroundingSources, parseResponse, formatSystemPrompt, type ParsedResponse } from './gemini.ts'
import { respondViaAgy, warmAgy } from './agy-chat.ts'
import { composeLiveThinkingCard, composeThinkingCard } from './live-headline.ts'
import {
  DEFAULT_AGY_MODEL,
  DEFAULT_GEMINI_MODEL,
  friendlyModelName,
  modelEffort,
} from './models.ts'
import { reformatUnifiedDiffs } from './diff-format.ts'
import { chunk } from './chunk.ts'
import { stripToolTraceCard } from './render-cleanup.ts'
import { geminiCommand, executeGeminiCommand } from './commands.ts'
import { addVoiceGroup, executeVoiceCommand } from './voice-commands.ts'
import { VoiceManager } from './voice.ts'
import { insertMessage } from './db.ts'
import { shouldEmbed } from './embed-throttle.ts'
import { buildDefaultRegistry } from './tools/index.ts'
import { PendingEditsStore } from './reactions/pending-edits.ts'
import { applyLifecycle } from './reactions/lifecycle.ts'
import { activeTurns } from './active-turns.ts'
import { ChannelTurnRunner } from './channel-turns.ts'
import { FAST_FORWARD_REACTION, LatestQueueMarker } from './queue-marker.ts'
import { renderSteeredMessage } from './steering.ts'
import { isHardStopMessage } from './stop-command.ts'
import type { LifecycleEvent, ToolCall, CodeExecArtifact } from './gemini.ts'
import { PinnedFactsStore } from './pinned-facts.ts'
import { handleReaction } from './reactions/handler.ts'
import { SummaryStore } from './summarization/store.ts'
import { SummarizationScheduler } from './summarization/scheduler.ts'
import { fetchMessagesSince, recordInFlightTurn, clearInFlightTurn, getAllInFlightTurns } from './db.ts'
import { DeferredActions } from './deferred-actions.ts'
import { LiveProgressBuffer, resolveLiveUpdateInterval } from './live-update.ts'
import {
  DEFAULT_LIVE_END_LINGER_MS,
  formatAggregateTraceMarker,
  TRACE_RESULT_PAYLOAD_MAX,
  TRACE_ROW_MAX,
  truncateDigest,
  truncateDisplayWidth,
  truncateDisplayWidthClean,
} from './tool-trace.ts'
import { extractPresenceDirective, normalizePresenceText } from './presence.ts'
import { GemStats } from './stats.ts'
import { editImages, isImageEditRequest } from './image-generation.ts'

const STATE_DIR = process.env.DISCORD_STATE_DIR || path.join(os.homedir(), '.gemini', 'channels', 'discord')
dotenv.config({ path: path.join(STATE_DIR, '.env') })
const LIVE_UPDATE_INTERVAL_MS = resolveLiveUpdateInterval(process.env.GEM_LIVE_UPDATE_INTERVAL_MS)
const deferredActions = new DeferredActions(path.join(STATE_DIR, 'deferred-actions.json'))
const stats = new GemStats(path.join(STATE_DIR, 'global-stats.json'))
const SKIP_REASON_LABELS: Record<string, string> = {
  too_large: 'too large',
  unsupported_type: 'unsupported file type',
  download_failed: 'download failed',
  processing_timeout: 'processing timed out',
  ytdlp_failed: 'YouTube import failed',
  ytdlp_timeout: 'YouTube import timed out',
}

export function formatSkippedAttachments(
  skipped: Array<{ name: string, reason: string }>,
  duringFallback = false,
): string {
  const title = duringFallback ? '📎 Some files couldn’t survive API fallback' : '📎 Some files weren’t attached'
  const rows = skipped.map(({ name, reason }) =>
    `> **${name.replaceAll('*', '\\*')}** · ${SKIP_REASON_LABELS[reason] ?? reason.replaceAll('_', ' ')}`
  )
  return [title, ...rows].join('\n')
}
const PRESENCE_FILE = path.join(STATE_DIR, 'presence.json')
const DEFAULT_PRESENCE_TEXT = '📡 waiting on gemini 4'

function loadPresenceText(): string {
  try {
    const parsed = JSON.parse(readFileSync(PRESENCE_FILE, 'utf8'))
    const text = typeof parsed?.text === 'string' ? normalizePresenceText(parsed.text) : ''
    return text || DEFAULT_PRESENCE_TEXT
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') console.error('[presence] load failed:', error)
    return DEFAULT_PRESENCE_TEXT
  }
}

// Send a plain channel message instead of a Discord reply-reference.
//
// Why: message.reply() attaches a reply-reference, which Discord renders as a
// "↰ replying to @user" header on EVERY message — so Gemma visibly @-tags the
// user on each turn, unlike the Claude --channels bots which send plain
// channel messages. allowedMentions:{repliedUser:false} only suppresses the
// notification ping, not the header. Sending to message.channel directly drops
// the reference entirely, matching the Claude bots. Same return contract as
// message.reply().catch(()=>null) so call sites are a drop-in swap.
async function sendReply(message: Message, content: string, files?: string[]): Promise<Message | null> {
  return sendChannelMessage(message, stripToolTraceCard(content), files)
}

async function sendRawMessage(message: Message, content: string, files?: string[]): Promise<Message | null> {
  return sendChannelMessage(message, content, files)
}

async function sendChannelMessage(message: Message, content: string, files?: string[]): Promise<Message | null> {
  const channel = message.channel as any
  const payload: any = { content, allowedMentions: { repliedUser: false } }
  if (files && files.length) payload.files = files
  return channel.send(payload).catch((err: unknown) => {
    console.error('[discord] send failed:', err)
    return null
  }) as Promise<Message | null>
}

// Files agy wrote this turn that are safe to attach: must still exist (the
// agent's workspace can be transient), be a plain file, non-empty, and under
// Discord's ~25MB non-Nitro cap (24MB margin). Capped to 8 so one chatty turn
// can't spam a message with attachments.
const MAX_ATTACH_BYTES = 24 * 1024 * 1024
const MAX_ATTACH_FILES = 8
function pickAttachableFiles(paths: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of paths) {
    if (!p || seen.has(p)) continue
    seen.add(p)
    try {
      const st = statSync(p)
      if (st.isFile() && st.size > 0 && st.size <= MAX_ATTACH_BYTES) out.push(p)
    } catch {
      // gone/unreadable by the time we check — skip, don't fail the turn over it
    }
    if (out.length >= MAX_ATTACH_FILES) break
  }
  return out
}

// agy sometimes writes a file then cites it in prose as a local file:// path or
// raw filesystem path — useless to a Discord user on another machine. The file
// itself gets attached via pickAttachableFiles/sendReply instead, so strip the
// dead link/path rather than leaving it dangling in the reply text.
function stripFileLinks(t: string): string {
  return t
    .replace(/\[([^\]]+)\]\(file:\/\/[^)]*\)/g, '\$1')
    .replace(/`?file:\/\/\S+`?/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

async function replaceActiveMessage(
  message: Message,
  activeMessages: Message[],
  index: number,
  content: string,
  label: string,
  files?: string[]
): Promise<void> {
  content = stripToolTraceCard(content)
  const existing = activeMessages[index]
  if (existing) {
    if (existing.content === content && !files?.length) return
    try {
      await existing.edit(files?.length ? { content, files } : content)
      return
    } catch (err) {
      console.error(`[discord] ${label} edit failed for chunk ${index}; sending replacement:`, err)
      await existing.delete().catch(() => {})
    }
  }

  const msg = await sendReply(message, content, files)
  if (msg) {
    activeMessages[index] = msg as Message
    if (index === 0) recordInFlightTurn(message.channelId, msg.id, message.id)
  }
}

function headingsToBold(t: string): string {
  const lines = t.split('\n')
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^[ \t]*#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/)
    if (m) {
      out.push(`**${m[1]}**`)
      while (i + 1 < lines.length && lines[i + 1].trim() === '') i++
    } else {
      // strip a stray leading '>' caret that gem sometimes leaks onto a fresh
      // output line (it bleeds the quote syntax into plain prose). Only a caret
      // that's clearly spurious — a line that is JUST '>' or '> text' with no
      // intentional blockquote context here (the reply is never a quote).
      out.push(lines[i].replace(/^[ \t]*>[ \t]?/, ''))
    }
  }
  // enforce single-blank-line spacing: collapse any run of 2+ blank lines to ONE
  // (Jeff 2026-06-30 — headers/paragraphs were drifting apart by multiple lines).
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

function quoteBlock(t: string): string {
  return t
    .replace(/\s+$/, '')
    .split('\n')
    .map(line => line.trim() === '' ? '' : `> ${line}`)
    .join('\n')
}

function renderThoughtBlock(header: string, body: string): string {
  const trimmed = body.trim()
  return trimmed ? `${header}\n${quoteBlock(trimmed)}` : ''
}

const MODEL_NAME = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL
// Cap conversation history sent per turn. 80k tokens is generous for chat
// (~60k words of prior context) while keeping per-turn input cost bounded
// on flash-class models. Old default was 200k, which meant every turn
// re-sent up to 200k tokens of history on a chatty channel — a major
// hidden cost per the audit. Override via MAX_HISTORY_TOKENS=<n>.
const MAX_HISTORY_TOKENS = parseInt(process.env.MAX_HISTORY_TOKENS ?? '80000', 10)

if (!process.env.DISCORD_BOT_TOKEN) {
  console.error(`FATAL: DISCORD_BOT_TOKEN missing. Set in ${path.join(STATE_DIR, '.env')}`)
  process.exit(1)
}
if (!process.env.GEMINI_API_KEY) {
  console.error(`FATAL: GEMINI_API_KEY missing. Set in ${path.join(STATE_DIR, '.env')}`)
  process.exit(1)
}

// Narrowed to string after the env-presence guards above. Using bare strings
// here lets downstream consumers skip non-null assertions.
const DISCORD_TOKEN: string = process.env.DISCORD_BOT_TOKEN
const GEMINI_API_KEY: string = process.env.GEMINI_API_KEY

const access = new AccessManager()
const persona = new PersonaLoader()
const toolRegistry = await buildDefaultRegistry()
const gemini = new GeminiClient(GEMINI_API_KEY, MODEL_NAME, toolRegistry)
const pendingEdits = new PendingEditsStore()
const pinnedFacts = new PinnedFactsStore(path.join(STATE_DIR, 'pinned-facts.md'))
persona.setPinnedFactsStore(pinnedFacts)

const summaryStore = new SummaryStore()
persona.setSummaryStore(summaryStore)
const SUMMARIZATION_THRESHOLD = parseInt(process.env.MAX_UNSUMMARIZED_MESSAGES ?? '50', 10)
const SUMMARIZATION_BATCH_LIMIT = parseInt(process.env.SUMMARIZATION_BATCH_LIMIT ?? '500', 10)
const summarizer = new SummarizationScheduler({
  store: summaryStore,
  fetchSinceForSummarization: async (channelId, since, limit) => {
    const rows = fetchMessagesSince(channelId, since, limit)
    return rows.map(r => ({
      authorName: r.author_name,
      content: r.content,
      timestamp: r.timestamp,
      messageId: r.id
    }))
  },
  gemini,
  threshold: SUMMARIZATION_THRESHOLD,
  batchLimit: SUMMARIZATION_BATCH_LIMIT
})

await access.load()
await persona.load()

// Token count formatter — thousands-separated decimal (e.g. 14,200 not
// 14.2K). Easier to compare against per-call cost calculations.
function formatTokenCount(n: number): string {
  return n.toLocaleString('en-US')
}

// cc-discord-kit tool-trace parity (ported from tool_watcher.py). Tool calls
// render inside a ```diff``` fence as `+ ● ToolName(digest) [Nms]` — the `+`
// makes Discord's diff highlighter color the line GREEN; a failed call uses
// `- ● ... FAILED` (RED). The `●` dot marks "this is a tool invocation."
const _ARG_DIGEST_PREFERENCE = [
  'file_path', 'notebook_path', 'pattern', 'command', 'url',
  'symbols', 'symbol', 'ticker', 'query',
]

// Single-line, ID-shaped arg digest, <= maxLen chars. Mirrors _arg_digest.
function argDigest(args: Record<string, unknown>, maxLen = 84): string {
  if (!args || typeof args !== 'object') return ''
  // Empty args (e.g. agy's post-hoc trace carries no per-call args) → '' so the
  // caller can omit the parens entirely instead of printing a useless `({})`.
  if (Object.keys(args).length === 0) return ''
  for (const key of _ARG_DIGEST_PREFERENCE) {
    const v = (args as Record<string, unknown>)[key]
    if (typeof v === 'string') {
      let s = v.trim().replace(/\n/g, ' ')
      return truncateDigest(s, maxLen)
    }
  }
  let s: string
  try { s = JSON.stringify(args) } catch { s = String(args) }
  s = s.replace(/\n/g, ' ')
  return truncateDigest(s, maxLen)
}

// mcp__server__ns__tool -> tool (last segment). Mirrors _ticker_line's shortener.
function shortToolName(name: string): string {
  if (name.startsWith('mcp__')) {
    const parts = name.split('__')
    if (parts.length >= 3) return parts[parts.length - 1]
  }
  return name
}

// Redact credential-looking runs before a trace hits Discord. A file-edit diff
// can contain the contents of an env/auth file, so a 32+ char id-shaped token in
// a diff body could otherwise leak a key. Same SECRET_RE as gpt-bot.
const SECRET_RE = /[A-Za-z0-9_\-]{32,256}/g
function redactSecrets(text: string): string { return text.replace(SECRET_RE, '<REDACTED>') }

// Unified diff -> Claude-style: a [+adds, -dels] badge + the changed lines
// (red '-' / green '+', context plain), minus the git '@@' / file-header noise.
// Ported from gpt-bot/src/gpt.ts so the trace card can render file-edit diffs.
function formatDiff(unified: string): { badge: string; body: string[] } {
  let adds = 0, dels = 0
  const body: string[] = []
  for (const l of unified.replace(/\n+$/, '').split('\n')) {
    if (l.startsWith('@@') || l.startsWith('+++') || l.startsWith('---')) continue
    if (l.startsWith('+')) adds++
    else if (l.startsWith('-')) dels++
    body.push(l)
  }
  return { badge: `[+${adds}, -${dels}]`, body }
}

// --- Dedicated 🔧 Tool-trace card (ported from gpt-bot) ---------------------
// gpt-bot has a per-channel `/gpt trace off|on|collapse` that posts a standalone
// `🔧 **Tool trace**` card ABOVE the reply: a ```diff```-fenced list of tool
// calls, one `+ ● shortName(argDigest) [Nms]` line per call (green via the diff
// `+`), `- ● ... FAILED [Nms]` (red) on failure. It's the SINGLE trace surface:
// tool calls + web-search + code-execution (show_code's old inline blocks were
// folded in here 2026-06-29). Reuses gem's argDigest/shortToolName.
// gem's ToolCall has no diff/resultLines fields (simpler than gpt's), so this is
// the trimmed assembler: header row + optional `⎿ resultPreview` line per call.
const TRACE_BODY_CHAR_BUDGET = 1900
const TRACE_MAX_LINES = 50
// Width of the ⎿ result-preview row. Was chopped to 10 (misread of "reduce ~10"),
// which made every preview useless — restored to a readable width.
const TRACE_RESULT_PREVIEW_MAX = Number(process.env.GEM_OUT_W ?? TRACE_RESULT_PAYLOAD_MAX)
// Cap the number of tool-call rows so a long turn's trace stays a preview, not a
// wall — the last N calls plus a "+N earlier" marker. Parity with gpt/llm-bot.
const MAX_TRACE_CALLS = Number(process.env.GEM_MAX_TRACE_CALLS ?? 11)
const MAX_DIFF_BODY_LINES = Number(process.env.GEM_MAX_DIFF_BODY_LINES ?? 12)

function buildTraceLines(toolCalls: ToolCall[]): string[] {
  const lines: string[] = []
  // Keep the last N calls (most recent = most relevant); note how many were dropped.
  const dropped = Math.max(0, toolCalls.length - MAX_TRACE_CALLS)
  const capped = dropped ? toolCalls.slice(-MAX_TRACE_CALLS) : toolCalls
  if (dropped) lines.push(formatAggregateTraceMarker(dropped))
  // Edits (with diffs) first: the diff is the payload and must not get starved by
  // a long list of shell rows below it, which the card's length cap then truncates
  // to a couple lines (gpt-bot's ordering). Order within each group preserved.
  const ordered = [...capped.filter(c => c.diff), ...capped.filter(c => !c.diff)]
  for (const call of ordered) {
    const prefix = call.failed ? '- ● ' : '+ ● '
    const tail = call.failed ? ' FAILED' : ''
    // Timing badge. Two regimes so we kill the agy noise without losing native
    // precision: native tool calls carry sub-second ms timing that's genuinely
    // useful → show `[Nms]` for anything under 1s. agy's timing is coarse
    // 1s-resolution derived from trajectory timestamps, so its 1-4s rows were
    // just per-row noise (Jeff) → suppress 1000-4999ms. Genuinely slow (≥5s,
    // either engine) → `[Ns]`. 0/unknown → no badge.
    const d = call.durationMs
    const ms = d <= 0 ? ''
      : d < 1000 ? ` [${d}ms]`
      : d < 5000 ? ''
      : ` [${Math.round(d / 1000)}s]`
    const tailStr = tail + ms
    let name = shortToolName(call.name)
    let displayArgs = call.args

    if (call.name === 'call_mcp_tool' && call.args && typeof call.args === 'object') {
      const toolName = String(call.args.ToolName || '')
      name = shortToolName(toolName)
      let innerArgs = call.args.Arguments && typeof call.args.Arguments === 'object'
        ? (call.args.Arguments as Record<string, unknown>)
        : {}
      if (innerArgs.params && typeof innerArgs.params === 'object') {
        innerArgs = innerArgs.params as Record<string, unknown>
      }
      displayArgs = innerArgs
    }

    const hasArgs = displayArgs && typeof displayArgs === 'object' && Object.keys(displayArgs).length > 0
    let argPart = ''
    if (hasArgs) {
      // Budget the whole rendered header, including marker, name, parens, and
      // timing/failure suffix. Discord's diff fence wraps beyond TRACE_ROW_MAX columns.
      const budget = TRACE_ROW_MAX - 4 - name.length - 2 - tailStr.length
      const digest = argDigest(displayArgs, budget)
      argPart = digest ? `(${digest})` : ''
    }

    lines.push(`${prefix}${name}${argPart}${tailStr}`)
    if (call.diff) {
      // File edit: a `⎿ [+N, -M]` summary line then the changed lines (red '-' /
      // green '+'), redacted, capped at 24 body lines. The body lines keep their
      // own +/- markers so Discord's diff highlighter colors them.
      const { badge, body } = formatDiff(call.diff)
      lines.push(`  ⎿ ${badge}`)
      for (const b of body.slice(0, MAX_DIFF_BODY_LINES)) {
        let line = b
        line = truncateDisplayWidth(line, TRACE_ROW_MAX)
        lines.push(line)
      }
      if (body.length > MAX_DIFF_BODY_LINES) {
        lines.push(`... (${body.length - MAX_DIFF_BODY_LINES} more lines)`)
      }
    } else if (call.resultPreview) {
      let rp = call.resultPreview.replace(/\n/g, ' ')
      // Continuation row: keep the second trace line tiny (Jeff: ~10 cells).
      if (rp.length > TRACE_RESULT_PREVIEW_MAX) rp = rp.slice(0, TRACE_RESULT_PREVIEW_MAX - 1) + '…'
      lines.push(`  ⎿ ${rp}`)
    }
  }
  return lines
}

// Assemble the fenced card, dropping whole trailing lines past the line/char
// budget (with a marker) so it never blows the 2000-char Discord message cap.
// Extra trace content folded into the single card (Jeff 2026-06-29): the old
// `show_code` flag rendered web-searches + code-execution as SEPARATE inline
// blocks, and ALSO re-dumped the tool calls — duplicating the trace card. Now
// there's one card. Web searches and code-exec render as `● `-prefixed rows in
// the same Claude-bot tool_watcher format, so everything reads as one trace.
interface TraceExtras {
  searchQueries?: string[]
  codeArtifacts?: CodeExecArtifact[]
}

// Render web-search queries as trace rows: `+ ● Web search(query)`. Server-side
// grounding has no per-call timing, so no [Nms] badge — matches agy's arg-only rows.
function searchTraceLines(queries: string[]): string[] {
  return queries.map(q => {
    let d = q.replace(/\n/g, ' ').trim()
    const queryMax = TRACE_ROW_MAX - '+ ● Web search()'.length
    if (d.length > queryMax) d = d.slice(0, queryMax - 1) + '…'
    return `+ ● Web search(${d})`
  })
}

// Render code-execution as trace rows: `+ ● Code(lang)` header (red `-` on a
// failed outcome) + the output on a `⎿` continuation line, mirroring how a tool
// call shows its resultPreview. The full code body is NOT dumped into the card
// (it'd blow the line budget); the card is a TRACE, not a code listing.
function codeTraceLines(arts: CodeExecArtifact[]): string[] {
  const lines: string[] = []
  for (const a of arts) {
    const failed = a.outcome != null && /FAIL/i.test(a.outcome)
    lines.push(`${failed ? '- ● ' : '+ ● '}Code(${a.language})${failed ? ' FAILED' : ''}`)
    if (a.output) {
      let out = a.output.replace(/\n/g, ' ').trim()
      // Continuation row: keep the second trace line tiny (Jeff: ~10 cells).
      if (out.length > TRACE_RESULT_PREVIEW_MAX) out = out.slice(0, TRACE_RESULT_PREVIEW_MAX - 1) + '…'
      if (out) lines.push(`  ⎿ ${out}`)
    }
  }
  return lines
}

function renderTraceCard(toolCalls: ToolCall[], extras: TraceExtras = {}): string {
  // Order: web-searches → tool calls → code-execution. Searches are usually the
  // first thing the model does (grounding), code-exec the last (compute on what
  // it found), so this reads chronologically enough without per-row timestamps.
  const all = [
    ...searchTraceLines(extras.searchQueries ?? []),
    ...buildTraceLines(toolCalls),
    ...codeTraceLines(extras.codeArtifacts ?? []),
  ].map(line => /^[+-] ● /.test(line)
    ? truncateDisplayWidthClean(line, TRACE_ROW_MAX)
    : truncateDisplayWidth(line, TRACE_ROW_MAX))
  const fitted: string[] = []
  let running = 0
  for (const ln of all.slice(0, TRACE_MAX_LINES)) {
    const cost = ln.length + (fitted.length ? 1 : 0)
    if (running + cost > TRACE_BODY_CHAR_BUDGET) break
    fitted.push(ln); running += cost
  }
  const dropped = all.length - fitted.length
  if (dropped > 0) fitted.push(`... (${dropped} more lines)`)
  // Redact credential-looking runs (a file-edit diff body can carry env/auth
  // contents) before the card hits Discord.
  // NOT quote-blocked (Jeff 2026-06-30): the trace is its own labeled ```diff```
  // card and reads cleaner standing alone — wrapping it in a > quote nested the
  // code fence inside a gray quote bar, which looked broken. Only the 💭 thinking
  // block stays quote-wrapped.
  return '🔧 **Tool trace**\n```diff\n' + redactSecrets(fitted.join('\n')) + '\n```'
}

process.on('SIGHUP', async () => {
  console.error('SIGHUP received — reloading access.json and persona files')
  try {
    await access.load()
    await persona.load()
    console.error('reload complete')
  } catch (e) {
    console.error('reload failed:', e)
  }
})

process.on('unhandledRejection', err => console.error('unhandledRejection:', err))
process.on('uncaughtException', err => console.error('uncaughtException:', err))

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.DirectMessageTyping,
    GatewayIntentBits.DirectMessageReactions,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.User, Partials.Reaction]
})

const voiceManager = new VoiceManager(client)
voiceManager.attach()

let shuttingDown = false
function installGracefulShutdown(): void {
  const timeoutMs = Number(process.env.GEMMA_GRACEFUL_SHUTDOWN_MS) || 30 * 60_000
  const shutdown = (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    console.error(`[shutdown] ${signal} received; waiting for active turns to finish`)
    const timer = new Promise<'timeout'>(resolve => {
      const t = setTimeout(() => resolve('timeout'), timeoutMs)
      t.unref?.()
    })
    const idle = Promise.all([activeTurns.waitForIdle(), channelTurns.waitForIdle()])
      .then(() => 'idle' as const)
    Promise.race([idle, timer])
      .then(reason => {
        console.error(`[shutdown] exiting after ${reason}`)
        client.destroy()
        process.exit(0)
      })
      .catch(err => {
        console.error('[shutdown] graceful shutdown failed:', err)
        process.exit(1)
      })
  }
  process.once('SIGTERM', () => shutdown('SIGTERM'))
  process.once('SIGINT', () => shutdown('SIGINT'))
}

installGracefulShutdown()

// Attach `/gemini voice <call|speak|leave|type>` onto the /gemini command
// builder. Voice used to be a standalone /voice — moved under /gemini to
// de-collide with other bots' /voice in shared guilds (Jeff). Must run before
// the client.once('ready') registration below so the JSON carries the group.
addVoiceGroup(geminiCommand)

// Speak-mode barge-in: the in-flight turn's AbortController, keyed by channel.
// When a new /voice speak message arrives while the previous one is still being
// generated or spoken, we abort the old generation and cancel its audio so the
// new message takes over immediately (full barge-in). One entry per speak
// channel — speak mode is single-session, but keying by channel keeps it
// correct if that ever changes.
const speakTurnControllers = new Map<string, AbortController>()

let basePresenceText = loadPresenceText()
function presenceActivity(text: string) {
  return { name: text, type: ActivityType.Custom, state: text }
}

function applyBasePresence(text: string): void {
  const normalized = normalizePresenceText(text)
  if (!normalized) return

  basePresenceText = normalized
  try {
    client.user?.setPresence({
      status: 'online',
      activities: [presenceActivity(basePresenceText)],
    })
    console.error(`[presence] applied "${basePresenceText}"`)
  } catch (error) {
    console.error('[presence] Discord update failed:', error)
  }
  try {
    writeFileSync(PRESENCE_FILE, JSON.stringify({ text: basePresenceText }) + '\n', { mode: 0o600 })
  } catch (error) {
    console.error('[presence] persistence failed:', error)
  }
}

client.once('ready', async () => {
  console.error(`Gem online as ${client.user?.tag} (${client.user?.id})`)
  warmAgy()
  deferredActions.rearm(client)
  applyBasePresence(basePresenceText)

  // Sweep turns left in-flight by the PREVIOUS process (crash, OOM, manual
  // restart mid-turn) — anything still in this table means that process died
  // before reaching its own finally block, so the "Thinking..." placeholder
  // for it is frozen forever with nothing coming back to finish it. Matches
  // gpt-bot/llm-bot's pending-placeholders.ts pattern exactly: bare
  // "✗ **Interrupted**" (no emoji prefix, no extra copy — narrate.py and the
  // other bots don't duplicate the notice either), plus a ❌ react on the
  // user's original message so the interruption is visible even after
  // scrolling past the placeholder. (Jeff 2026-06-30, after a restart killed
  // a live turn mid-tool-call — "match the pattern of the other bots.")
  for (const turn of getAllInFlightTurns()) {
    try {
      const channel = await client.channels.fetch(turn.channel_id)
      if (channel?.isTextBased() && 'messages' in channel) {
        const stuck = await channel.messages.fetch(turn.message_id)
        await stuck.edit('✗ **Interrupted**')
        if (turn.user_message_id) {
          try {
            const userMsg = await channel.messages.fetch(turn.user_message_id)
            await userMsg.react('❌')
          } catch { /* original message gone */ }
        }
      }
    } catch (e) {
      console.error(`[startup] failed to settle orphaned turn (channel=${turn.channel_id} message=${turn.message_id}):`, e)
    } finally {
      clearInFlightTurn(turn.channel_id)
    }
  }

  try {
    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN)
    await rest.put(
      Routes.applicationCommands(client.user!.id),
      // Voice is now a subcommand group ON geminiCommand (see addVoiceGroup
      // above), so only the single /gemini command is registered — the old
      // top-level /voice is gone (de-collided).
      { body: [geminiCommand.toJSON()] }
    )
    console.error('Slash commands registered.')
  } catch (error) {
    console.error('Failed to register slash commands:', error)
  }
})

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return
  if (shuttingDown) {
    await interaction.reply({ content: '⚠️ restarting after the current turn finishes', ephemeral: true }).catch(() => {})
    return
  }

  if (interaction.commandName !== 'gemini') return

  // /gemini voice <call|speak|leave|type> — the voice subcommand group routes
  // to the voice handler. Everything else (incl. the `cache` group) goes to the
  // main /gemini handler. Voice is gated by the same allowlist as text
  // (access.json users), so "who can voice" tracks "who can text". The summoner
  // becomes the gem-voice session owner (it routes audio to whoever this gate
  // admits), so no separate owner-id env needs to agree.
  if (interaction.options.getSubcommandGroup(false) === 'voice') {
    await executeVoiceCommand(
      interaction, voiceManager, persona,
      (uid) => access.isUserAllowed(uid),
      toolRegistry, gemini,
    )
    return
  }

  const adminId = process.env.DISCORD_ADMIN_ID
  await executeGeminiCommand(interaction, access, persona, gemini, adminId, {
    summaryStore,
    summarizer,
    stats,
  })
})

interface HandleOpts {
  // When set, edit this message in place for the *first* reply chunk instead
  // of sending a fresh reply. Additional chunks (rare) still post as new
  // replies after the edited target.
  editTarget?: Message
  // When true, prepend an "expand on previous reply" instruction to the
  // user message text before passing to Gemini.
  expansion?: boolean
  // When set, use this text as the user message fed to Gemini instead of
  // message.content. Used by the per-channel turn queue to fold several
  // rapid-fire messages into ONE batched follow-up turn (one placeholder,
  // one generation) rather than a stack of concurrent "Thinking…" replies.
  combinedText?: string
}

// Appended to Gemma's system prompt when a message is in /voice speak mode, so
// her reply is written to be SPOKEN by TTS (no lists/markdown that sound robotic
// read aloud) rather than typed. The text reply still posts to the channel too.
const SPOKEN_MODE_INSTRUCTION = `

---
🔊 SPOKEN MODE: only your **reply** field is read aloud by text-to-speech — your *thinking* is NEVER spoken. Keep your normal structured output EXACTLY as always (your usual separate thinking and reply fields). Put ALL your reasoning, analysis, and "thinking out loud" in the thinking field; make the **reply** field a clean, direct spoken answer:
- Write the reply the way a person would *say* it: natural, conversational, flowing sentences.
- Answer directly — do NOT narrate your reasoning or think out loud in the reply field.
- NO markdown, NO bullet points, NO numbered lists, NO headers, NO code blocks, NO links, NO emoji.
- If you'd normally make a list, say it as a sentence ("a few things — first X, then Y, and Z").
- Keep it concise and easy on the ear; speak symbols/abbreviations the way you'd say them aloud.`

// Background Memory Ingestion + access gate. Returns whether the message is
// gated-IN (Gemma should generate a reply). Embedding runs for every allowed
// message regardless of the gate (passive learning), so it lives here and is
// called per inbound message BEFORE the turn queue — that way a queued/batched
// message is still embedded even though only the batch carrier reaches the
// generation path in handleUserMessage.
function ingestAndGate(message: Message): boolean {
  if (message.author.bot || !client.user) return false

  const isMention = message.mentions.users.has(client.user.id)
  if (isAddressedToAnotherBot(client.user.id, message.mentions.users.values())) return false
  const gate = access.canHandle({
    channelId: message.channelId,
    userId: message.author.id,
    isMention
  })

  // If the user is allowed to speak in the channel, log the message to SQLite VSS.
  // Independent of `gate` (which requires mention) so the bot learns from passive
  // conversation. Throttle: at most one embed per (channel, user) per
  // GEMINI_EMBED_COOLDOWN_MS (default 3s) to cap cost on a busy channel.
  if (access.isAllowedAndEnabled(message.author.id, message.channelId)
      && message.content.trim()
      && shouldEmbed(message.channelId, message.author.id)) {
    gemini.embed(message.content)
      .then(embedding => {
        insertMessage(
          message.id,
          message.channelId,
          message.author.username,
          message.content,
          message.createdAt.toISOString(),
          embedding
        )
      })
      .catch(e => console.error('Failed to embed message for memory:', e))
  }

  return gate
}

async function handleUserMessage(message: Message, opts: HandleOpts = {}): Promise<void> {
  if (message.author.bot) return
  if (!client.user) return

  // Opt-in reply gate removed 2026-05-02. The two-tier classifier (regex +
  // flash-lite) silenced messages it judged "not for Gemma" — but the UX was
  // confusing in practice (users couldn't tell why Gemma wasn't responding)
  // and the persona-level "default to silent" instruction does the same job
  // at LLM time without an extra API call. requireMention remains the only
  // pre-LLM filter.

  // Lifecycle: 👀 the moment we commit to handling this message. Matches
  // the squad's react_hook lifecycle. 🤔 fires before generate, ✅ on
  // first reply chunk, ❌ on caught error.
  applyLifecycle(message, 'received').catch(() => {})

  let typingInterval: ReturnType<typeof setInterval> | null = null
  let streamInterval: ReturnType<typeof setInterval> | null = null
  // Hoisted out of the try block so the catch path can edit the streaming
  // `💭 Thinking...` placeholder in place rather than leaving it orphaned
  // alongside a new error reply (seen 2026-05-01: thought_signature crash
  // left a dangling Thinking... message above the actual error).
  let activeMessages: Message[] = []
  const liveToolCalls: Array<{ name: string; running: boolean; failed?: boolean }> = []
  // This speak-mode turn's abort signal (set below if we're speaking to a vc).
  // Declared out here so the catch/finally can read it for barge-in cleanup.
  let turnSignal: AbortSignal | undefined
  // Spinner animation handle for the "💭 Thinking…" placeholder. Hoisted out of
  // the try so catch/finally can clear it (mirrors gpt/llm-bot's stopThinkingAnim
  // guard) — a dangling interval would keep editing a deleted message.
  let thinkingAnim: ReturnType<typeof setInterval> | null = null
  // Tracks the spinner's most recent in-flight edit() so stopThinkingAnim can
  // await it. Without this, a spinner tick that fires just before the final
  // content write can have its HTTP PATCH land on Discord AFTER the real
  // content's PATCH (network race, not a JS scheduling issue — clearInterval
  // only stops FUTURE ticks, it can't recall one already in flight) — the
  // message gets permanently stuck showing stale "Thinking…" text forever,
  // since nothing ever re-checks or re-writes it (Jeff 2026-06-30).
  let spinnerEditPromise: Promise<unknown> | null = null
  // Antigravity's current snapshot plus the ordered chunks needed by the
  // explicit full-trace collapse mode.
  let liveAgyThinking = ''
  const liveAgyThinkingTrace: string[] = []
  const liveAgyProgress = new LiveProgressBuffer()
  const liveTraceMessage: { current: Message | null } = { current: null }
  const collapseFailsafed = new Set<string>()
  const collapseFailsafeMs = Math.max(
    60_000,
    Number(process.env.GEMINI_COLLAPSE_FAILSAFE_MS ?? '600000')
  )
  const scheduleCollapseFailsafe = (m: Message | null, kind: 'thinking' | 'trace') => {
    if (!m) return
    if (collapseFailsafed.has(m.id)) return
    collapseFailsafed.add(m.id)
    deferredActions.schedule(client, {
      channelId: m.channelId,
      messageId: m.id,
      action: 'delete',
      dueAt: Date.now() + collapseFailsafeMs,
    })
    console.error(`[cleanup] scheduled ${kind} collapse failsafe message=${m.id} in ${Math.round(collapseFailsafeMs / 1000)}s`)
  }
  const stopThinkingAnim = async () => {
    if (thinkingAnim) { clearInterval(thinkingAnim); thinkingAnim = null }
    if (spinnerEditPromise) { await spinnerEditPromise; spinnerEditPromise = null }
  }
  // Deferred-placeholder timer (option 3): posts the 💭 bubble only if the turn
  // is still working after a delay. Hoisted so catch/finally can cancel a
  // pending one — else a timer that fires after an error/return would post an
  // orphan "Thinking…" bubble with no turn behind it.
  let placeholderTimer: ReturnType<typeof setTimeout> | null = null
  // Register before the first awaited pre-processing call. Stops sent while
  // history/media ingestion is still running must abort this turn before it
  // reaches Gemini/agy, not get queued behind it.
  const stopController = new AbortController()
  activeTurns.register(message.channelId, () => stopController.abort())
  const throwIfStopped = () => {
    if (!stopController.signal.aborted) return
    const abortErr = new Error('gemini turn stopped by user')
    abortErr.name = 'AbortError'
    throw abortErr
  }

  try {
    // Fetch partial DM channels so we can send/read them
    if (message.channel.partial) await message.channel.fetch()
    
    // Start typing heartbeat
    ;(message.channel as any).sendTyping().catch(() => {})
    typingInterval = setInterval(() => {
      ;(message.channel as any).sendTyping().catch(() => {})
    }, 9000)

    const summaryRecord = summaryStore.get(message.channelId)
    const sinceMessageId = summaryRecord?.lastSummarizedMessageId ?? null

    // 📎 Fire ingesting reaction if there's anything non-trivial to process
    // pre-generate (Discord attachments OR YouTube URLs in the message
    // content). Cheap "I see your file/link, I'm working on it" indicator
    // that lasts the few seconds processAttachments / processYouTubeUrls
    // typically take. Per Jeff's request youtube ingestion is grouped under
    // attachment processing rather than getting a separate emoji.
    const hasIngest = message.attachments.size > 0 || /youtu/i.test(message.content)
    if (hasIngest) {
      applyLifecycle(message, 'ingesting').catch(() => {})
    }

    const flags = access.channelFlags(message.channelId)
    const envDefaultEngine = process.env.GEMMA_AGY_CHAT === '1' ? 'agy' : 'api'
    const resolvedEngine = flags.engine ?? envDefaultEngine
    const useAgy = resolvedEngine === 'agy'

    const [history, attachmentResult, ytResult] = await Promise.all([
      buildContextHistory(message.channel as any, message.id, gemini, client.user!.id, MAX_HISTORY_TOKENS, sinceMessageId),
      processAttachments(
        message.id,
        [...message.attachments.values()].map<InputAttachment>(a => ({
          url: a.url,
          name: a.name,
          size: a.size,
          contentType: a.contentType
        })),
        GEMINI_API_KEY,
        { keepLocalFiles: useAgy },
      ),
      processYouTubeUrls(message.id, message.content, GEMINI_API_KEY)
    ])

    // Observability (Jeff 2026-06-29): surface how much context this turn got.
    // gem-bot doesn't have gpt/llm's silent-catch amnesia (a buildContextHistory
    // throw propagates to the turn's outer catch → visible error, not silent
    // empty history) — but logging the count makes a thin-context turn diagnosable
    // and confirms history is flowing.
    console.error(`[history] ch=${message.channelId} contextMsgs=${history.length}`)

    let allParts = [...attachmentResult.parts, ...ytResult.parts]
    const allSkipped = [...attachmentResult.skipped, ...ytResult.skipped]

    if (allSkipped.length > 0) {
      await sendReply(message, formatSkippedAttachments(allSkipped))
    }

    const transientThinking = flags.thinking === 'live' || flags.thinking === 'collapse'

    const activeModel = useAgy
      ? (process.env.GEMMA_AGY_MODEL || DEFAULT_AGY_MODEL)
      : (process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL)
    const modelFriendly = friendlyModelName(activeModel)
    const effort = modelEffort(activeModel)
    const thinkingLabel = effort ? `Thinking with ${effort} effort` : `Thinking with ${modelFriendly}`

    let latestParsed: ParsedResponse = { react: null, thinking: null, reply: null }
    let lastFlushedFullReply = ''

    // Lifecycle: 🤔 — we're about to call the model. Cleans up the prior 👀.
    applyLifecycle(message, 'thinking').catch(() => {})

    // Deferred placeholder (Jeff 2026-06-29, option 3 "both"): show the native
    // "Gemma is typing…" dots first (the sendTyping heartbeat above already
    // fires them), and only post the 💭 placeholder bubble + spinner if we're
    // STILL working after PLACEHOLDER_DELAY_MS. Fast turns then look clean —
    // just dots, then the answer, no transient "Thinking…" message. Slow turns
    // still get the animated placeholder so the user knows it's alive.
    //
    // postPlaceholder() is idempotent and is called either by the timer (slow
    // path) or eagerly by flushStream the instant real content needs a home
    // before the timer fired (so streamed content never has nowhere to land).
    // The editTarget (regenerate / ✏️) path skips the delay: it's reusing an
    // existing bot message, so there are no typing dots to show first.
    const PLACEHOLDER_DELAY_MS = parseInt(process.env.GEMMA_PLACEHOLDER_DELAY_MS ?? '2500', 10)

    // Live replaces one current thought in place. Collapse instead streams the
    // whole trace line by line; both keep Antigravity's public action narration
    // as one separate bounded line.
    const liveThinkingText = (): string =>
      liveAgyThinking || latestParsed.thinking || ''
    const liveThinkingTrace = (): string[] =>
      liveAgyThinkingTrace.length
        ? liveAgyThinkingTrace
        : latestParsed.thinking ? [latestParsed.thinking] : []

    const liveTraceCard = (): string => {
      if (flags.trace === 'off' || liveToolCalls.length === 0) return ''
      const lines = liveToolCalls.map(c => {
        const prefix = c.failed ? '- ● ' : '+ ● '
        const suffix = c.running ? '...' : (c.failed ? ' FAILED' : '')
        return `${prefix}${shortToolName(c.name)}${suffix}`
      })
      return '🔧 **Tool trace**\n```diff\n' + lines.join('\n') + '\n```'
    }

    const flushLiveTrace = async () => {
      const card = liveTraceCard()
      if (!card) return
      if (liveTraceMessage.current) {
        if (liveTraceMessage.current.content !== card) {
          await liveTraceMessage.current.edit(card).catch(() => {})
      }
      return
    }
    liveTraceMessage.current = await sendRawMessage(message, card)
    if (flags.trace === 'collapse') scheduleCollapseFailsafe(liveTraceMessage.current, 'trace')
  }

    const startSpinner = () => {
      if (thinkingAnim) return
      const GLYPHS = ['✻', '✢', '✱', '✶', '✷', '✸']
      const dots = ['.', '..', '…']
      let fi = 1
      thinkingAnim = setInterval(() => {
        const target = activeMessages[0]
        if (!target) return
        const sp = GLYPHS[fi % GLYPHS.length]
        const d = dots[fi % dots.length]
        fi++
        // One render owner, one latest snapshot. Replacing this card in place
        // is the important bit; no stale planner lines queue behind it.
        const live = liveThinkingText()
        spinnerEditPromise = target.edit(composeThinkingCard({
          label: thinkingLabel, glyph: sp, dots: d,
          thinking: flags.thinking === 'off' ? '' : live,
          reasoningTrace: flags.thinking === 'collapse' ? liveThinkingTrace() : [],
          detail: liveAgyProgress.value(),
        })).catch(() => {})
      }, LIVE_UPDATE_INTERVAL_MS)
    }

    // Post the placeholder bubble + start the spinner, once. No-op if a message
    // already occupies activeMessages[0] (timer + flushStream may both call it).
    const postPlaceholder = async () => {
      if (placeholderTimer) { clearTimeout(placeholderTimer); placeholderTimer = null }
      if (activeMessages.length > 0) { startSpinner(); return }
      const initialMsg = await sendReply(message, `💭 **${thinkingLabel}…**`)
      if (initialMsg) {
        activeMessages.push(initialMsg as Message)
        recordInFlightTurn(message.channelId, initialMsg.id, message.id)
        if (transientThinking) scheduleCollapseFailsafe(initialMsg as Message, 'thinking')
      }
      startSpinner()
    }

    if (opts.editTarget) {
      // Regenerate: reuse the existing bot message immediately, spinner on.
      activeMessages.push(opts.editTarget)
      recordInFlightTurn(message.channelId, opts.editTarget.id, message.id)
      await opts.editTarget.edit(`💭 **${thinkingLabel}…**`).catch(() => {})
      startSpinner()
    } else if (transientThinking) {
      // Transient modes reserve the first message for the live thought card.
      await postPlaceholder()
    } else {
      // Normal turn: dots now, placeholder only if still working after the delay.
      placeholderTimer = setTimeout(() => { postPlaceholder().catch(() => {}) }, PLACEHOLDER_DELAY_MS)
    }

    let isFlushing = false
    let currentFlushPromise: Promise<void> | null = null
    const flushStream = async () => {
      if (isFlushing) return currentFlushPromise
      isFlushing = true
      let resolveFlush: () => void = () => {}
      currentFlushPromise = new Promise((resolve) => { resolveFlush = resolve })
      try {
        await flushLiveTrace()
        let fullReply = ''
        if (latestParsed.reply) {
          fullReply += headingsToBold(latestParsed.reply)
        }

        // No real content yet. During the deferred-placeholder window there's
        // no bubble at all (the typing dots are carrying the wait), so just
        // return and let the dots / pending timer continue. If the spinner is
        // already running it owns activeMessages[0] — also return. Only synthesize
        // a static placeholder line if neither dots-window nor spinner applies.
        if (!fullReply) {
          if (placeholderTimer || thinkingAnim) return
          fullReply = '💭 **Thinking…**'
        }

        // Real content has arrived. Cancel the pending placeholder timer (a fast
        // turn beat the delay → no transient bubble) and kill any running spinner
        // so it can't overwrite streamed text on its next 1.5s tick.
        if (placeholderTimer) { clearTimeout(placeholderTimer); placeholderTimer = null }
        if (!transientThinking) {
          await stopThinkingAnim()
        }

        if (fullReply === lastFlushedFullReply) return
        lastFlushedFullReply = fullReply

        const pieces = chunk(fullReply, 2000, 'newline')
        const offset = transientThinking ? 1 : 0
        
        for (let i = 0; i < pieces.length; i++) {
          await replaceActiveMessage(message, activeMessages, i + offset, pieces[i], 'stream')
        }
      } finally {
        isFlushing = false
        const resolve = resolveFlush
        currentFlushPromise = null
        resolve()
      }
    }

    streamInterval = setInterval(() => { flushStream() }, 2000)

    const baseText = opts.combinedText ?? message.content
    const userText = opts.expansion
      ? `[The user wants you to expand on your previous reply with more depth and detail.]\n\n${baseText}`
      : baseText

    const respondT0 = Date.now()
    // Track active in-flight tool calls so we know when 🔧 should drop.
    // gemini.ts emits start/end pairs per dispatch.
    let activeToolCount = 0
    const onLifecycleEvent = (e: LifecycleEvent) => {
      if (activeTurns.stopIfPending(message.channelId)) return
      if (e.type === 'native_thinking') {
        applyLifecycle(message, 'native_thinking').catch(() => {})
      } else if (e.type === 'searching') {
        applyLifecycle(message, 'searching').catch(() => {})
      } else if (e.type === 'tool_call_start') {
        activeToolCount += 1
        applyLifecycle(message, 'tooling').catch(() => {})
        liveToolCalls.push({ name: e.name, running: true })
        flushStream().catch(() => {})
      } else if (e.type === 'tool_call_end') {
        activeToolCount = Math.max(0, activeToolCount - 1)
        const call = liveToolCalls.find(c => c.name === e.name && c.running)
        if (call) {
          call.running = false
          call.failed = e.failed
        }
        flushStream().catch(() => {})
      } else if (e.type === 'agy_progress') {
        // Picked up by the next spinner tick; coalescing here keeps the Discord
        // edit cadence bounded even when the trajectory writes several steps.
        liveAgyThinking = e.thinking || liveAgyThinking
        if (e.thinking && liveAgyThinkingTrace.at(-1) !== e.thinking) {
          liveAgyThinkingTrace.push(e.thinking)
        }
        liveAgyProgress.push(e.detail)
      }
    }
    // Speak-mode FULL BARGE-IN. If this message is being spoken to a vc and a
    // previous turn for this channel is still in flight — generating OR already
    // speaking — preempt it: abort the old generation and cut its audio NOW, so
    // this message takes over instead of waiting behind it. Then arm a fresh
    // AbortController so the NEXT message can barge in on us the same way.
    const speaking = voiceManager.isSpeakingTo(message)
    if (speaking) {
      const prior = speakTurnControllers.get(message.channelId)
      if (prior && !prior.signal.aborted) {
        prior.abort()                       // stop the old generation mid-stream
        await voiceManager.cancelSay()      // cut the old audio + flush playback
      }
      const controller = new AbortController()
      speakTurnControllers.set(message.channelId, controller)
      turnSignal = controller.signal
      // Start the soft "thinking tone" now — the chat model's about to churn for
      // a beat, so fill the vc silence. The real answer's say() cuts it off;
      // gem-voice self-stops after a safety max if no say ever lands.
      voiceManager.startThinking()
    }
    const systemPrompt = persona.buildSystemPrompt(message.channelId, message.guildId)
      + (speaking ? SPOKEN_MODE_INSTRUCTION : '')

    // The full system prompt the API path uses (persona + date + mandatory JSON
    // envelope) — built once so the agy path feeds the model the SAME contract.
    const fullSystemPrompt = formatSystemPrompt(systemPrompt, flags.thinking)

    // Combine speak-mode barge-in signal with the /gemini stop signal.
    const combinedSignal = (() => {
      if (!turnSignal) return stopController.signal
      const ac = new AbortController()
      const abort = () => ac.abort()
      if (turnSignal.aborted || stopController.signal.aborted) {
        abort()
      } else {
        turnSignal.addEventListener('abort', abort, { once: true })
        stopController.signal.addEventListener('abort', abort, { once: true })
      }
      return ac.signal
    })()

    const apiRespond = () => gemini.respond({
      systemPrompt,
      history,
      userMessageText: userText,
      userMediaParts: allParts,
      userName: message.author.username,
      channelId: message.channelId,
      userId: message.author.id,
      thinkingMode: flags.thinking,
      cacheEnabled: flags.cache,
      cacheTtlSec: flags.cacheTtlSec ?? undefined,
    }, (partial) => {
      if (activeTurns.stopIfPending(message.channelId)) return
      const visible = extractPresenceDirective(partial.reply)
      latestParsed = { ...partial, reply: visible.reply }
    }, onLifecycleEvent, combinedSignal)

    // OPTIONAL agy chat engine: route turns through the Antigravity CLI
    // (flat Google sub) instead of the metered Gemini API. Mirrors gpt-bot's
    // /gpt engine swap. On throw we fall back to the API so the bot never goes
    // dark. Current-message attachments are exposed as local inbox paths, and
    // agy reads them through its multimodal view_file tool.
    //
    // Engine resolution, in order:
    //   1. the channel's explicit /gemini engine pick (flags.engine), else
    //   2. the global GEMMA_AGY_CHAT env default ('1' = agy, else api).
    // So a channel can opt in/out independently while the env sets the default
    // for channels that never picked.
    let parsed: typeof latestParsed
    let meta: Awaited<ReturnType<typeof gemini.respond>>['meta']
    // useAgy is resolved earlier
    // Set when an intended agy turn silently degraded to the metered API engine
    // (timeout/empty/exec error). The two engines aren't interchangeable — the
    // API path has NO shell/filesystem — so a fallback changes what gemma can do.
    // Surfaced as a footer badge below so the degrade isn't invisible (Jeff
    // 2026-06-29).
    let agyFellBack = false

    if (isImageEditRequest(userText, allParts)) {
      const generated = await editImages(GEMINI_API_KEY, userText, allParts)
      parsed = { react: null, thinking: null, reply: 'Done — image edit attached.' }
      meta = {
        groundingSources: [],
        codeArtifacts: [],
        usage: null,
        finishReason: 'STOP',
        flaggedSafety: [],
        searchQueries: [],
        nativeThoughts: null,
        toolCalls: [],
        searchEntryPointHtml: null,
        writtenFiles: generated,
      }
    } else if (useAgy) {
      try {
        throwIfStopped();
        ({ parsed, meta } = await respondViaAgy({
          systemPrompt: fullSystemPrompt,
          history,
          userMessageText: userText,
          userName: message.author.username,
          mediaFiles: attachmentResult.localFiles,
          channelId: message.channelId,
          onEvent: onLifecycleEvent,
          signal: combinedSignal,  // /gemini stop → SIGKILLs the agy process group
        }, parseResponse))
      } catch (e) {
        // /gemini stop killed the agy turn — do NOT fall back to the API (that
        // would answer anyway, defeating the stop). Re-throw as an AbortError so
        // it hits the clean-exit handler below (deletes the placeholder, silences
        // the turn) exactly like the API-path abort (Jeff 2026-07-01).
        if (combinedSignal.aborted) {
          const abortErr = new Error('agy turn stopped by user')
          abortErr.name = 'AbortError'
          throw abortErr
        }
        // agy failed (timeout / empty / exec error) — fall back to the metered
        // API so the user still gets an answer, but FLAG it: the API path can't
        // shell/read files, so this turn quietly lost those capabilities.
        console.error('[agy] chat engine failed, falling back to API:', e instanceof Error ? e.message : e)
        agyFellBack = true
        const skippedBeforeFallback = attachmentResult.skipped.length
        await attachmentResult.prepareApiParts()
        allParts = [...attachmentResult.parts, ...ytResult.parts]
        const fallbackSkipped = attachmentResult.skipped.slice(skippedBeforeFallback)
        if (fallbackSkipped.length > 0) {
          await sendReply(message, formatSkippedAttachments(fallbackSkipped, true))
        }
        throwIfStopped();
        ;({ parsed, meta } = await apiRespond())
      }
    } else {
      throwIfStopped();
      ({ parsed, meta } = await apiRespond())
    }
    // Keep flushStream's view in sync with the real result. apiRespond's
    // streaming callback already does this incrementally (line ~917), but the
    // agy path never touches latestParsed at all — it only returns `parsed`
    // once, on completion. Without this, the "one last flush" call below
    // reads a still-null latestParsed.reply, falls into the empty-fallback
    // branch, and briefly overwrites the just-finished reply with a bare
    // "💭 Thinking…" before the real final render corrects it a moment later
    // (Jeff 2026-06-30 — the "Thinking… flash after the reply" bug report).
    const presenceUpdate = extractPresenceDirective(parsed.reply)
    parsed = { ...parsed, reply: presenceUpdate.reply }
    latestParsed = parsed
    if (presenceUpdate.presence) {
      applyBasePresence(presenceUpdate.presence)
    }
    const respondElapsedMs = Date.now() - respondT0
    const actualEngine = useAgy && !agyFellBack ? 'agy' : 'api'
    stats.record({
      engine: actualEngine,
      model: actualEngine === 'agy'
        ? (process.env.GEMMA_AGY_MODEL || DEFAULT_AGY_MODEL)
        : (process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL),
      elapsedMs: respondElapsedMs,
      usage: meta.usage,
    })

    if (streamInterval) {
      clearInterval(streamInterval)
      streamInterval = null
    }
    const progressDwellRemaining = liveAgyProgress.remainingMs()
    if (progressDwellRemaining > 0) {
      await new Promise<void>(resolve => { setTimeout(resolve, progressDwellRemaining) })
    }
    // Kill the spinner before final rendering so it can't edit a message we're
    // about to overwrite/delete (flushStream stops it on first content, but a
    // silent/empty turn may never have streamed any — stop it unconditionally).
    // AWAITED: if a spinner tick's edit() is still in flight, its PATCH could
    // otherwise land on Discord after the final content write below, leaving
    // the message permanently stuck on stale "Thinking…" text.
    await stopThinkingAnim()
    // One last flush to ensure we haven't missed anything before final rendering.
    // If a flush is currently in progress, wait for it to complete first.
    while (currentFlushPromise) {
      await currentFlushPromise
    }
    await flushStream()

    // Usage metadata — one line per turn for cost tracking
    if (meta.usage) {
      const cached = meta.usage.cachedTokens ?? 0
      const cachePct = meta.usage.promptTokens > 0 ? Math.round((cached / meta.usage.promptTokens) * 100) : 0
      console.error(`[usage] channel=${message.channelId} prompt=${meta.usage.promptTokens} cached=${cached} (${cachePct}%) response=${meta.usage.responseTokens} total=${meta.usage.totalTokens}`)
    }
    // Non-STOP finish reasons deserve visibility
    if (meta.finishReason && meta.finishReason !== 'STOP' && meta.finishReason !== 'FINISH_REASON_UNSPECIFIED') {
      console.error(`[finish] channel=${message.channelId} reason=${meta.finishReason}`)
    }
    // Flagged safety categories
    if (meta.flaggedSafety.length > 0) {
      console.error(`[safety] channel=${message.channelId} flagged=${JSON.stringify(meta.flaggedSafety)}`)
    }

    // The persona-driven `parsed.react` field used to fire a single LLM-
    // chosen reaction here. Replaced with the squad lifecycle (👀→🤔→✅)
    // applied at the corresponding handler points. The `parsed.react`
    // value is now ignored — keep parsing it so older persona prompts
    // don't crash, but don't act on it.

    // Silent-exit path. When the model returns a fully-empty response —
    // no reply, no thinking, no native thoughts, no tool output we'd want
    // to surface — the persona has chosen to stay quiet. Match the way
    // Claude bots opt out (just don't post anything): delete the streaming
    // placeholder, strip transient lifecycle reactions, leave nothing
    // behind on either side. Without this the harness was forcing an
    // "(Empty response)" message + ✅ on every silent turn.
    const hasNothingToShow = !parsed.reply
      && !parsed.thinking
      && !meta.nativeThoughts
      && meta.toolCalls.length === 0
      && meta.codeArtifacts.length === 0
      && meta.searchQueries.length === 0
      && meta.finishReason !== 'MAX_TOKENS'
      && meta.finishReason !== 'SAFETY'
    if (hasNothingToShow) {
      console.error(`[silent] channel=${message.channelId} message=${message.id} — model returned nothing, exiting clean`)
      // Strip 👀/🤔/etc without applying any final emoji.
      applyLifecycle(message, 'silenced').catch(() => {})
      // Delete the "💭 **Thinking…**" placeholder — no orphan above the silence.
      for (const m of activeMessages) {
        await m.delete().catch(err => console.error('silent-exit placeholder delete failed:', err))
      }
      activeMessages = []
      // Cleanup attachments we processed for this turn.
      await Promise.all([attachmentResult.cleanup(), ytResult.cleanup()])
      // Still kick the summarizer — silent turns don't change the summary
      // schedule.
      summarizer.scheduleIfNeeded(message.channelId)
      return
    }

    let finalFullReply = ''

    // The 🧠 reasoning + 💭 thinking blocks are assembled into their OWN string
    // and posted as a SEPARATE Discord message ABOVE the reply (Jeff 2026-06-28).
    // Previously they were woven into the top of finalFullReply as `>` quotes, so
    // the reasoning "read as part of the message". Now: thinkingMessage → its own
    // grayed thought-message (the "💭 Thinking…" placeholder is edited to become
    // it); finalFullReply → the clean answer as a separate message below. Same
    // gating as before (`flags.thinking !== 'off'`, collapse/never modes).
    let thinkingMessage = ''

    // 🔧 Tool-trace card — the single per-channel trace surface, gated by the
    // `trace` flag (off|on|collapse). Renders tool calls + web-searches +
    // code-execution as ONE isolated card above the reply, never inside the answer
    // body. Keeping trace out of finalFullReply prevents a partial live card from
    // surviving as a dangling footer when chunking/edit ordering gets weird.
    const traceExtras = { searchQueries: meta.searchQueries, codeArtifacts: meta.codeArtifacts }
    const showTrace = flags.trace !== 'off'
      && (meta.toolCalls.length > 0 || meta.searchQueries.length > 0 || meta.codeArtifacts.length > 0)
    const finalTraceCard = showTrace ? renderTraceCard(meta.toolCalls, traceExtras) : ''

    // Native thinking summaries from gemini-3 thinking models (parts with
    // `thought: true`). Distinct from `parsed.thinking` (our JSON-wrapper
    // CoT prose). Gated by the thinking mode (same as the 💭 block below) —
    // both are reasoning-trace renders. Was gated by `verbose` until the
    // 2026-06-28 split; verbose's footer duty moved to the counter flag and its
    // reasoning-block duty folds into the thinking mode so nothing is orphaned.
    // 'never' suppresses it; any other mode shows it (it floods less than the
    // 💭 block since it's the model's own summary, not our wrapper prose).
    // Header sits at column 0; body blockquoted so the inner content visually
    // indents under the header without doubling up the indent on the title.
    // Goes into thinkingMessage (the separate thought-message), NOT the reply.
    if (flags.thinking !== 'off' && flags.thinking !== 'live' && meta.nativeThoughts) {
      thinkingMessage += renderThoughtBlock('🧠 **Reasoning:**', meta.nativeThoughts) + '\n\n'
    }

    const showThinkingFinal = flags.thinking === 'live'
      || ((flags.thinking === 'on' || flags.thinking === 'collapse') && !!parsed.thinking)
    if (showThinkingFinal) {
      // Single line, no trailing colon (Jeff 2026-06-30). Was two stacked 💭
      // lines — a leftover "Thinking with X effort…" line ABOVE "Thought for
      // Ns:" — which read as the spinner placeholder never clearing, even
      // though it's actually the final header building in both pieces.
      // Effort suffix dropped entirely (Jeff 2026-06-30) — always just
      // "Thought for Ns" regardless of effort/model choice.
      const thoughtSecs = Math.round(respondElapsedMs / 1000)
      const header = `💭 **Thought for ${thoughtSecs}s**`
      const finalThinking = parsed.thinking || meta.nativeThoughts
      if (finalThinking) {
        // Live finishes on the same compact latest headline the user watched.
        // Collapse and on retain the full trace; collapse removes it after the
        // configured linger while on keeps it.
        thinkingMessage += flags.thinking === 'live'
          ? composeLiveThinkingCard(thoughtSecs, finalThinking) + '\n\n'
          : renderThoughtBlock(header, finalThinking) + '\n\n'
      } else {
        thinkingMessage += header + '\n\n'
      }
    }
    thinkingMessage = thinkingMessage.replace(/\s+$/, '')

    // Search queries Gemma typed into Google. Lets the user catch misframed
    // queries without parsing the output. Same gate as code artifacts — same
    // audience that wants "show your work" wants this. Format mirrors
    // ticker-tape's chat.py: header at column 0, query bullets blockquoted
    // for visual indent under the header.
    // (Web-search, inline tool-dump, and code-artifact blocks removed 2026-06-29
    // — that content now renders inside the single 🔧 Tool-trace card above,
    // gated by `trace`. The old show_code flag is retired.)

    // Strip prose-side fenced code blocks that duplicate code we executed — the
    // trace card's Code(lang) row is the canonical surface, so the model echoing
    // the same code in its reply text is redundant. gemini-3-pro-preview does
    // this; strip it whenever there are code artifacts. Also strip any token-
    // footer / sources / metadata pattern the model might hallucinate (learned
    // from past turns where the bot stamped footers).
    const replyText = parsed.reply
      ? reformatUnifiedDiffs(headingsToBold(stripBotMetadata(stripFileLinks(stripDuplicateCodeBlocks(parsed.reply, meta.codeArtifacts)))))
      : null
    if (replyText) {
      finalFullReply += replyText
    }

    // Speak mode (/voice speak): if Gem is parked in a vc and this message's
    // author is co-present in the launch channel, ALSO read the prose reply
    // aloud via gem-voice TTS. Purely additive — the text reply + thinking
    // trace above are unchanged. Fire-and-forget so it doesn't block the render.
    // Barge-in guard: only speak if THIS turn is still the current one for the
    // channel and wasn't aborted — otherwise a newer message already took over
    // and speaking now would talk over it.
    const stillCurrent = !turnSignal
      || (!turnSignal.aborted && speakTurnControllers.get(message.channelId)?.signal === turnSignal)
    if (replyText && speaking && stillCurrent) {
      voiceManager.sayText(replyText).then(r => {
        if (!r.ok) console.error('[voice] speak-mode sayText failed:', r.error)
      }).catch(e => console.error('[voice] speak-mode sayText threw:', e))
    }

    if (meta.groundingSources.length > 0 && parsed.reply) {
      const sourcesBody = formatGroundingSources(meta.groundingSources, 5)
      if (sourcesBody) finalFullReply += '\n\n-# ↳ sources: ' + sourcesBody
    }

    // Verbose ops footer — token usage + response time. Format:
    //   `↑ 14.2K · ↓ 310 · 4.2s`
    // ↑ = prompt tokens (sent up), ↓ = response tokens (came down). Wrapped
    // in backticks so it reads as a discrete data badge, distinct from the
    // bot's prose. Response time replaces total-tokens — wall-clock is more
    // actionable than the sum (you can derive thinking-token spend from
    // total - prompt - response if you need it from the logs).
    if (flags.counter !== 'off') {
      const u = meta.usage
      const respondElapsedSec = (respondElapsedMs / 1000).toFixed(1)
      // Format: ` ↑ N · ↓ N · ◷ Xs ` inside inline-code backticks WITH
      // leading + trailing space padding so iOS doesn't render the box
      // jammed flush against the closing backtick / "(edited)" badge.
      // ◷ (U+25F7, clock face) prefixes the elapsed-time field — geometric
      // glyph, monochrome everywhere, no iOS emoji autopromotion like ⏱ had.
      // Per-message footer is intentionally cache-agnostic — cache details
      // (size, hit count, age, TTL remaining) live behind /gemini cache info
      // so we don't pollute every reply with bookkeeping the user only checks
      // occasionally. Cache hits are still observed via lower bills, just not
      // surfaced inline.
      // No usage block (the agy engine emits no token counts) → show elapsed
      // time alone; the missing token data is assumed, not spelled out. So
      // counter=token|both both degrade to time-only on agy automatically.
      // counter=both additionally appends the cached-prefix portion (⚡ N) when
      // a server-side cache hit billed at the cached rate — only meaningful on
      // the API path where usage carries cachedTokens.
      const cachedStr = u && flags.counter === 'both' && u.cachedTokens > 0
        ? ` · ⚡ ${formatTokenCount(u.cachedTokens)}`
        : ''
      const tokenStr = u
        ? `\` ↑ ${formatTokenCount(u.promptTokens)} · ↓ ${formatTokenCount(u.responseTokens)}${cachedStr} · ◷ ${respondElapsedSec}s \``
        : `\` ◷ ${respondElapsedSec}s \``
      const safetyStr = meta.flaggedSafety.length > 0
        ? ` ⚠️ ${meta.flaggedSafety.map(s => `${s.category.replace('HARM_CATEGORY_', '')}=${s.probability}`).join(',')}`
        : ''
      // Trim trailing whitespace then insert a single blank line before the
      // badge — keeps spacing consistent whether or not there's a main reply
      // body. Reply-less turns (just thinking + token badge) used to render
      // 3 stacked blank lines from the trailing newlines on each upstream
      // block; this normalizes to one.
      finalFullReply = finalFullReply.replace(/\s+$/, '')
      finalFullReply += `\n\n-# ${tokenStr}${safetyStr}`
    }

    // Engine-fallback badge. When an agy turn degrades to the API engine, keep
    // the user-facing notice terse and name both engines plainly.
    if (agyFellBack) {
      finalFullReply = finalFullReply.replace(/\s+$/, '')
      finalFullReply += `\n\n-# ⚠️ antigravity unavailable - used Gemini API to answer`
    }

    if (meta.finishReason === 'MAX_TOKENS') {
      finalFullReply += '\n\n-# ⚠️ response hit max-tokens limit (reply may be truncated)'
    } else if (meta.finishReason === 'SAFETY') {
      finalFullReply = '⚠️ response blocked by Gemini safety filter. ' + (finalFullReply || '(no content)')
    }
    finalFullReply = stripToolTraceCard(finalFullReply)

    if (!finalFullReply && !parsed.react) {
       finalFullReply = '(Empty response)'
    }

    // Lifecycle terminal: pick the right final state based on finishReason.
    // 🛑 SAFETY — reply was blocked / heavily filtered
    // ✂️ MAX_TOKENS — reply hit budget cap, may be cut off mid-thought
    // ✅ everything else (STOP, FINISH_REASON_UNSPECIFIED) — normal commit
    // Fires before the actual edit since the edit is multi-step and we
    // want the indicator to flip the moment the bot is "done thinking".
    let terminalState: 'replied' | 'truncated' | 'blocked' = 'replied'
    if (meta.finishReason === 'SAFETY') terminalState = 'blocked'
    else if (meta.finishReason === 'MAX_TOKENS') terminalState = 'truncated'
    applyLifecycle(message, terminalState).catch(() => {})

    if (finalFullReply) {
      // Two-message render (Jeff 2026-06-28): the 💭/🧠 reasoning becomes its own
      // grayed thought-message ABOVE the reply, then the clean answer below. We
      // build ONE ordered list of pieces — thinking chunks first, reply chunks
      // after — and map it onto activeMessages by index. The "💭 Thinking…"
      // placeholder (activeMessages[0]) thus naturally becomes the first thinking
      // chunk; if there's no thinking, it becomes the first reply chunk instead
      // (identical to the old single-message behavior, no empty thought left).
      //
      // Keeping it one index-mapped list preserves the multi-send dedupe: each
      // streaming message is edited-in-place by index, overflow is sent fresh,
      // and any excess streaming messages are deleted at the end. Splitting into
      // two separate send loops would have re-introduced the duplicate-on-failed-
      // delete bug that the edit-in-place approach exists to prevent.
      if (finalTraceCard) {
        const traceMsg = liveTraceMessage.current
        if (traceMsg) {
          if (traceMsg.content !== finalTraceCard) {
            await traceMsg.edit(finalTraceCard).catch(() => {})
          }
        } else {
          liveTraceMessage.current = await sendRawMessage(message, finalTraceCard)
        }
      } else if (liveTraceMessage.current) {
        const traceMsg = liveTraceMessage.current
        await traceMsg.delete().catch(() => {})
        liveTraceMessage.current = null
      }

      const thinkingPieces = thinkingMessage ? chunk(thinkingMessage, 2000, 'newline').filter(p => p.trim() !== '') : []
      const replyPieces = finalFullReply ? chunk(finalFullReply, 2000, 'newline').filter(p => p.trim() !== '') : []
      const pieces = [...thinkingPieces, ...replyPieces]
      // Index in activeMessages where the reply (vs thinking) begins. Used by the
      // thinking-collapse delete (removes the leading thinking messages).
      const replyStart = thinkingPieces.length
      // Files agy wrote this turn (e.g. a .md report) — attach to the LAST
      // message of the turn instead of leaving a dead file:// link in the text.
      const attachFiles = pickAttachableFiles(meta.writtenFiles ?? [])

      for (let i = 0; i < pieces.length; i++) {
        const isLast = i === pieces.length - 1
        await replaceActiveMessage(message, activeMessages, i, pieces[i], 'final', isLast ? attachFiles : undefined)
      }
      // Delete excess streaming messages if final has fewer chunks than streaming.
      // Delete failure here is cosmetic (stale chunk, not a duplicate) — log instead
      // of swallowing so problems stay visible.
      if (pieces.length < activeMessages.length) {
        const excess = activeMessages.splice(pieces.length)
        for (const m of excess) {
          await m.delete().catch(err => console.error(`excess delete failed (cosmetic):`, err))
        }
      }

      // Collapse (Jeff 2026-06-25, reworked 2026-06-28 for the split). After a
      // linger, best-effort fire-and-forget:
      //   • thinking:live|collapse → DELETE the separate thinking message(s)
      //     entirely
      //     (indices 0..replyStart-1), leaving just the reply below. No more
      //     regex-stripping a combined string — the thought is its own message now,
      //     so we just remove it.
      //   • trace:collapse → DELETE the separate trace card entirely.
      // Snapshot the messages we touch so a later turn mutating activeMessages
      // can't make the deferred callback hit the wrong message.
      const collapsingThinking = transientThinking && replyStart > 0
      const collapsingTrace = flags.trace === 'collapse' && !!liveTraceMessage.current
      const lingerMs = Number(process.env.GEMINI_THOUGHT_LINGER_MS) || DEFAULT_LIVE_END_LINGER_MS

      if (collapsingThinking) {
        // SAFETY: only delete leading messages that are genuinely thinking
        // chunks. If a mid-stream send failed earlier, activeMessages can be
        // SHORTER than `pieces`, so `replyStart` might point into (or past) the
        // reply chunks — a blind splice(0, replyStart) could then delete answer
        // content. Bound the count to messages that actually exist AND are still
        // within the thinking region, and only when at least one reply chunk
        // survived below it (else we'd be deleting the whole message set).
        const replyMsgsPresent = activeMessages.length - replyStart
        const deleteCount = replyMsgsPresent > 0 ? Math.min(replyStart, activeMessages.length) : 0
        if (deleteCount > 0) {
          const thoughtMsgs = activeMessages.slice(0, deleteCount)
          activeMessages.splice(0, deleteCount)
          const dueAt = Date.now() + lingerMs
          for (const m of thoughtMsgs) {
            deferredActions.schedule(client, { channelId: m.channelId, messageId: m.id, action: 'delete', dueAt })
          }
        }
      }

      if (collapsingTrace) {
        const traceMsg = liveTraceMessage.current
        liveTraceMessage.current = null
        if (traceMsg) {
          deferredActions.schedule(client, { channelId: traceMsg.channelId, messageId: traceMsg.id, action: 'delete', dueAt: Date.now() + lingerMs })
        }
      }
    } else if (thinkingMessage) {
      // React-only turn (empty reply) that STILL produced reasoning: don't orphan
      // or drop the thinking. Render thinkingMessage into the placeholder/messages
      // so the thought survives as its own grayed message even with no answer
      // below it. (Previously thinking lived inside finalFullReply, so this case
      // never hit the empty branch; now it can, so we handle it explicitly.)
      const thinkingPieces = chunk(thinkingMessage, 2000, 'newline').filter(p => p.trim() !== '')
      for (let i = 0; i < thinkingPieces.length; i++) {
        await replaceActiveMessage(message, activeMessages, i, thinkingPieces[i], 'thinking-final')
      }
      if (thinkingPieces.length < activeMessages.length) {
        const excess = activeMessages.splice(thinkingPieces.length)
        for (const m of excess) await m.delete().catch(() => {})
      }
      // Honor both transient modes here too — delete the thought message(s)
      // after the linger, same as the main path.
      if (transientThinking) {
        const thoughtMsgs = activeMessages.splice(0)
        const lingerMs = Number(process.env.GEMINI_THOUGHT_LINGER_MS) || DEFAULT_LIVE_END_LINGER_MS
        const dueAt = Date.now() + lingerMs
        for (const m of thoughtMsgs) {
          deferredActions.schedule(client, { channelId: m.channelId, messageId: m.id, action: 'delete', dueAt })
        }
      }
    } else {
      // Truly empty (react-only, no reasoning): delete the placeholder messages.
      for (const m of activeMessages) await m.delete().catch(() => {})
    }

    await Promise.all([attachmentResult.cleanup(), ytResult.cleanup()])

    // Fire-and-forget: kick off conversation summarization if the channel
    // has accumulated enough new messages. Single-flight per channel inside
    // the scheduler — safe to call on every reply.
    summarizer.scheduleIfNeeded(message.channelId)

  } catch (e: any) {
    // Barge-in: this turn was deliberately aborted because a newer /voice speak
    // message arrived. Not an error — exit clean. Strip the transient lifecycle
    // reactions + the "💭 Thinking..." placeholder so no orphan is left behind;
    // the newer turn owns the channel now. No error message, no say().
    if (e?.name === 'AbortError') {
      console.log(`[voice] turn superseded by barge-in (channel=${message.channelId})`)
      await stopThinkingAnim()
      applyLifecycle(message, 'silenced').catch(() => {})
      const steeredAfter = activeTurns.consumeSteered(message.channelId)
      if (steeredAfter !== null && activeMessages.length) {
        const last = activeMessages[activeMessages.length - 1]
        await last.edit(renderSteeredMessage(last.content, steeredAfter)).catch(() => {})
      } else {
        for (const m of activeMessages) await m.delete().catch(() => {})
      }
      if (liveTraceMessage.current) await liveTraceMessage.current.delete().catch(() => {})
      liveTraceMessage.current = null
      activeMessages = []
      return
    }
    await stopThinkingAnim()
    console.error('message handler error:', e)
    // Match explicit rate-limit language only. The naive /rate/i matched
    // "generateContent" in every Gemini URL, causing unrelated 400s to look
    // like rate limits. Anchor on word boundaries + the actual phrase.
    const msgStr = String(e?.message || '')
    const isRateLimit = e?.status === 429
      || /\brate limit\b/i.test(msgStr)
      || /\bquota\b/i.test(msgStr)
      || /\btoo many requests\b/i.test(msgStr)
    // Lifecycle: ⚠️ for rate-limit / quota (denied semantics), ❌ for
    // anything else. Both clean up all transients.
    applyLifecycle(message, isRateLimit ? 'denied' : 'errored').catch(() => {})
    let msg: string
    if (e instanceof GeminiRequestRejected) {
      // Surface the actual rejection reason — usually unsupported mime type
      // or malformed part. User can retry without the offending attachment.
      msg = `⚠️ Gemini rejected the request: ${e.reason}`
    } else if (isRateLimit) {
      msg = "hitting Gemini's rate limit — give me a minute"
    } else {
      msg = "something broke reaching Gemini. check logs."
    }
    try {
      // If a streaming placeholder ("💭 Thinking...") is already up, edit it
      // in place rather than posting a new error message. Avoids the
      // orphaned-placeholder UX where the user sees a frozen Thinking line
      // above the actual error.
      if (activeMessages.length > 0) {
        await activeMessages[0].edit(msg).catch(() => {})
        // Delete any extra streaming chunks beyond the first.
        for (const extra of activeMessages.slice(1)) {
          await extra.delete().catch(() => {})
        }
        if (liveTraceMessage.current) await liveTraceMessage.current.delete().catch(() => {})
        liveTraceMessage.current = null
      } else {
        await sendReply(message, msg)
      }
    } catch { /* nothing to do */ }
  } finally {
    activeTurns.done(message.channelId)
    clearInFlightTurn(message.channelId)
    await stopThinkingAnim()
    if (placeholderTimer) { clearTimeout(placeholderTimer); placeholderTimer = null }
    if (typingInterval) clearInterval(typingInterval)
    if (streamInterval) clearInterval(streamInterval)
    // Drop this turn's barge-in controller, but ONLY if it's still the current
    // one — a newer message may have already replaced it in the map (that turn
    // owns cleanup of its own controller). Guards against a finishing old turn
    // wiping the active turn's abort handle.
    if (turnSignal && speakTurnControllers.get(message.channelId)?.signal === turnSignal) {
      speakTurnControllers.delete(message.channelId)
    }
  }
}

// Per-channel turn serializer. Without this, N Discord messages arriving in
// rapid succession each spawn a concurrent handleUserMessage → a STACK of N
// "💭 Thinking…" placeholders in the same channel (Jeff, 2026-06-28). Mirrors
// llm-bot's channelTurns queue: while a turn is in flight for a channel, later
// messages queue (with a 🕗 react so the user knows they're seen) instead of
// starting their own generation. When the active turn finishes, ALL queued
// messages are folded into ONE batched follow-up turn (their text joined),
// repeated until the queue drains. Result: exactly one thinking indicator per
// active generation per channel. Cross-channel turns still run concurrently.
interface QueuedChannelTurn { message: Message; opts: HandleOpts }
const queueMarker = new LatestQueueMarker(() => client.user?.id)
const QUEUE_SETTLE_MS = Number(process.env.GEM_QUEUE_SETTLE_MS) || 1_000
const channelTurns = new ChannelTurnRunner<QueuedChannelTurn>(
  async (channelId, batch) => {
    const messages = batch.map(item => item.message)
    const withAtt = [...messages].reverse().find(message => message.attachments.size > 0)
    const carrier = withAtt ?? messages[messages.length - 1]
    const carrierItem = batch.find(item => item.message.id === carrier.id) ?? batch[batch.length - 1]
    const combined = messages.map(message => message.content).filter(Boolean).join('\n')
    await queueMarker.clear(channelId)
    await handleUserMessage(
      carrier,
      batch.length === 1
        ? carrierItem.opts
        : { combinedText: combined || undefined },
    )
  },
  channelId => activeTurns.consumeStopped(channelId),
  QUEUE_SETTLE_MS,
)

async function runChannelTurn(message: Message, opts: HandleOpts = {}): Promise<void> {
  // Embed (always, for allowed messages) + gate. A gated-OUT message never
  // produces a placeholder, so it must not be queued or batched — just embed
  // it (done inside ingestAndGate) and drop it. Only gated-IN messages flow
  // into the serializer below.
  if (!ingestAndGate(message)) return

  const cid = message.channelId
  const outcome = await channelTurns.submit(cid, { message, opts })
  if (outcome === 'queued') {
    void queueMarker.mark(cid, message)
  }
}

client.on('messageCreate', async (message: Message) => {
  if (shuttingDown) return
  if (!message.author.bot && access.isAllowedAndEnabled(message.author.id, message.channelId)) {
    // Lone ❌ / X message: hard-kill the in-flight turn and swallow the message.
    // This must run before barge/queue handling, otherwise "X" becomes just
    // another queued prompt and only "works" after the turn finally unwinds.
    if (isHardStopMessage(message.content)) {
      message.delete().catch(() => {})
      const killed = activeTurns.stop(message.channelId)
      if (killed) {
        const ch = message.channel as any
        const m = await ch.send?.('🛑  Stopped. React 🔁 on my last message to retry.')
          .catch(() => null)
        if (m) m.react?.('🔁').catch(() => {})
      }
      return
    }

    // Barge-in (Jeff 2026-07-01/05): a new message takes over, but normal
    // messages defer the stop until Gemma reaches a lifecycle/stream boundary.
    // Explicit X/❌ above remains immediate. Deferring avoids half-rendered
    // thinking/trace edits while still preventing long turns from holding the
    // channel hostage.
    if (channelTurns.isRunning(message.channelId) && activeTurns.canRequestBarge(message.channelId)) {
      if (!ingestAndGate(message)) return
      activeTurns.deferStopFor(message.channelId, { clearQueue: false })
      channelTurns.enqueue(message.channelId, { message, opts: {} })
      void queueMarker.mark(message.channelId, message)
      return
    }
  }

  // Pending-edit check from ✏️ flow: if a bot message is marked as
  // edit-target for this channel, edit it with the user's next reply
  // instead of producing a brand-new reply.
  if (!message.author.bot) {
    const pending = pendingEdits.get(message.channelId)
    if (pending) {
      pendingEdits.clear(message.channelId)
      try {
        const target = await message.channel.messages.fetch(pending) as Message
        await runChannelTurn(message, { editTarget: target })
        return
      } catch (e) {
        console.error('[reactions] edit-target fetch failed, falling through:', e)
      }
    }
  }
  await runChannelTurn(message, {})
})

client.on('messageReactionAdd', async (reaction, user) => {
  if (reaction.partial) {
    try { await reaction.fetch() } catch { return }
  }
  if (user.partial) {
    try { await user.fetch() } catch { return }
  }
  if (reaction.emoji.name === FAST_FORWARD_REACTION && !user.bot
      && reaction.message.author?.id === user.id
      && queueMarker.isLatest(reaction.message.channelId, reaction.message.id)) {
    activeTurns.stopFor(reaction.message.channelId, { clearQueue: false })
    await queueMarker.clear(reaction.message.channelId)
    return
  }
  await handleReaction(reaction, user, {
    client,
    access,
    buildContext: (message, reactor) => ({
      message,
      reactor,
      client,
      gemini,
      access,
      persona,
      pendingEdits,
      pinnedFacts,
      rerunHandler: async (originalUserMessage, targetMessage, expansion) => {
        await handleUserMessage(originalUserMessage, {
          editTarget: targetMessage ?? undefined,
          expansion
        })
      }
    })
  })
})

await client.login(DISCORD_TOKEN)
