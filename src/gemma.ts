import { Client, GatewayIntentBits, Partials, ActivityType, REST, Routes, type Message } from 'discord.js'
import path from 'path'
import os from 'os'
import dotenv from 'dotenv'
import { AccessManager } from './access.ts'
import { PersonaLoader } from './persona.ts'
import { buildContextHistory, stripBotMetadata } from './history.ts'
import { processAttachments, processYouTubeUrls, type InputAttachment } from './attachments.ts'
import { GeminiClient, stripDuplicateCodeBlocks, GeminiRequestRejected, formatGroundingSources, parseResponse, formatSystemPrompt, type ParsedResponse } from './gemini.ts'
import { respondViaAgy, warmAgy } from './agy-chat.ts'
import { chunk } from './chunk.ts'
import { geminiCommand, executeGeminiCommand } from './commands.ts'
import { addVoiceGroup, executeVoiceCommand } from './voice-commands.ts'
import { VoiceManager } from './voice.ts'
import { insertMessage } from './db.ts'
import { shouldEmbed } from './embed-throttle.ts'
import { buildDefaultRegistry } from './tools/index.ts'
import { PendingEditsStore } from './reactions/pending-edits.ts'
import { applyLifecycle } from './reactions/lifecycle.ts'
import type { LifecycleEvent, ToolCall, CodeExecArtifact } from './gemini.ts'
import { PinnedFactsStore } from './pinned-facts.ts'
import { handleReaction } from './reactions/handler.ts'
import { SummaryStore } from './summarization/store.ts'
import { SummarizationScheduler } from './summarization/scheduler.ts'
import { fetchMessagesSince } from './db.ts'

const STATE_DIR = process.env.DISCORD_STATE_DIR || path.join(os.homedir(), '.gemini', 'channels', 'discord')
dotenv.config({ path: path.join(STATE_DIR, '.env') })

// Send a plain channel message instead of a Discord reply-reference.
//
// Why: message.reply() attaches a reply-reference, which Discord renders as a
// "↰ replying to @user" header on EVERY message — so Gemma visibly @-tags the
// user on each turn, unlike the Claude --channels bots which send plain
// channel messages. allowedMentions:{repliedUser:false} only suppresses the
// notification ping, not the header. Sending to message.channel directly drops
// the reference entirely, matching the Claude bots. Same return contract as
// message.reply().catch(()=>null) so call sites are a drop-in swap.
async function sendReply(message: Message, content: string): Promise<Message | null> {
  const channel = message.channel as any
  return channel.send({ content, allowedMentions: { repliedUser: false } }).catch((err: unknown) => {
    console.error('[discord] send failed:', err)
    return null
  }) as Promise<Message | null>
}

async function replaceActiveMessage(
  message: Message,
  activeMessages: Message[],
  index: number,
  content: string,
  label: string
): Promise<void> {
  const existing = activeMessages[index]
  if (existing) {
    if (existing.content === content) return
    try {
      await existing.edit(content)
      return
    } catch (err) {
      console.error(`[discord] ${label} edit failed for chunk ${index}; sending replacement:`, err)
      await existing.delete().catch(() => {})
    }
  }

  const msg = await sendReply(message, content)
  if (msg) activeMessages[index] = msg as Message
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
    .map(line => line.trim() === '' ? '>' : `> ${line}`)
    .join('\n')
}

function renderThoughtBlock(header: string, body: string): string {
  const trimmed = body.trim()
  return trimmed ? `${header}\n${quoteBlock(trimmed)}` : ''
}

const MODEL_NAME = process.env.GEMINI_MODEL || 'gemini-3-flash-preview'
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
      if (s.length > maxLen) {
        if (maxLen <= 1) return maxLen > 0 ? '…' : ''
        s = s.slice(0, maxLen - 1) + '…'
      }
      return s
    }
  }
  let s: string
  try { s = JSON.stringify(args) } catch { s = String(args) }
  s = s.replace(/\n/g, ' ')
  if (s.length > maxLen) {
    if (maxLen <= 1) return maxLen > 0 ? '…' : ''
    s = s.slice(0, maxLen - 1) + '…'
  }
  return s
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

function buildTraceLines(toolCalls: ToolCall[]): string[] {
  const lines: string[] = []
  // Edits (with diffs) first: the diff is the payload and must not get starved by
  // a long list of shell rows below it, which the card's length cap then truncates
  // to a couple lines (gpt-bot's ordering). Order within each group preserved.
  const ordered = [...toolCalls.filter(c => c.diff), ...toolCalls.filter(c => !c.diff)]
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
    const name = shortToolName(call.name)

    const hasArgs = call.args && typeof call.args === 'object' && Object.keys(call.args).length > 0
    let argPart = ''
    if (hasArgs) {
      // HEADER_LINE_MAX 84 (Jeff 2026-06-30): cap lines at ~84 so a long row never
      // wraps/overflows the Discord trace card. Raised from the old 79 to expose a
      // bit more command/arg, but kept tight — 84 is the practical max before wrap.
      // prefix 4 + name + () 2 + tailStr → digest gets the rest of 84.
      const budget = 84 - 4 - name.length - 2 - tailStr.length
      const digest = argDigest(call.args, budget)
      argPart = digest ? `(${digest})` : ''
    }

    lines.push(`${prefix}${name}${argPart}${tailStr}`)
    if (call.diff) {
      // File edit: a `⎿ [+N, -M]` summary line then the changed lines (red '-' /
      // green '+'), redacted, capped at 24 body lines. The body lines keep their
      // own +/- markers so Discord's diff highlighter colors them.
      const { badge, body } = formatDiff(call.diff)
      lines.push(`  ⎿ ${badge}`)
      for (const b of body.slice(0, 24)) {
        let line = b
        if (line.length > 84) line = line.slice(0, 83) + '…'
        lines.push(line)
      }
      if (body.length > 24) lines.push(`... (${body.length - 24} more lines)`)
    } else if (call.resultPreview) {
      let rp = call.resultPreview.replace(/\n/g, ' ')
      // result preview capped at 84 to match the header budget (no card overflow).
      if (rp.length > 84) rp = rp.slice(0, 83) + '…'
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
    // Total line budget 79. Prefix "+ ● Web search(" is 15. Closing ")" is 1. Total 16.
    // So max length of query is 79 - 16 = 63.
    if (d.length > 63) d = d.slice(0, 62) + '…'
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
      // Output line limit is 84. Prefix "  ⎿ " is 4 chars. Max out is 80.
      if (out.length > 80) out = out.slice(0, 79) + '…'
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
  ]
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
  console.error('SIGHUP received — reloading access.json and persona.md')
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

client.once('ready', async () => {
  console.error(`Gem online as ${client.user?.tag} (${client.user?.id})`)
  warmAgy()
  client.user?.setPresence({
    status: 'online',
    activities: [{ name: '🗄️ indexing the rubble', type: ActivityType.Custom, state: '🗄️ indexing the rubble' }]
  })

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
  const stopThinkingAnim = () => { if (thinkingAnim) { clearInterval(thinkingAnim); thinkingAnim = null } }
  // Deferred-placeholder timer (option 3): posts the 💭 bubble only if the turn
  // is still working after a delay. Hoisted so catch/finally can cancel a
  // pending one — else a timer that fires after an error/return would post an
  // orphan "Thinking…" bubble with no turn behind it.
  let placeholderTimer: ReturnType<typeof setTimeout> | null = null

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
        GEMINI_API_KEY
      ),
      processYouTubeUrls(message.id, message.content, GEMINI_API_KEY)
    ])

    // Observability (Jeff 2026-06-29): surface how much context this turn got.
    // gem-bot doesn't have gpt/llm's silent-catch amnesia (a buildContextHistory
    // throw propagates to the turn's outer catch → visible error, not silent
    // empty history) — but logging the count makes a thin-context turn diagnosable
    // and confirms history is flowing.
    console.error(`[history] ch=${message.channelId} contextMsgs=${history.length}`)

    const allParts = [...attachmentResult.parts, ...ytResult.parts]
    const allSkipped = [...attachmentResult.skipped, ...ytResult.skipped]

    if (allSkipped.length > 0) {
      const notes = allSkipped.map(s => `- ${s.name}: ${s.reason}`).join('\n')
      await sendReply(message, `skipped some attachments:\n${notes}`)
    }

    const flags = access.channelFlags(message.channelId)

    const envDefaultEngine = process.env.GEMMA_AGY_CHAT === '1' ? 'agy' : 'api'
    const resolvedEngine = flags.engine ?? envDefaultEngine
    // Media ALWAYS forces the native API — agy -p can't consume image/audio.
    const useAgy = resolvedEngine === 'agy' && allParts.length === 0

    const getFriendlyModelName = () => {
      if (useAgy) {
        return process.env.GEMMA_AGY_MODEL || 'Gemini 3.5 Flash (Medium)'
      }
      const id = process.env.GEMINI_MODEL || 'gemini-3-flash-preview'
      if (id === 'gemini-3-pro-preview') return 'Gemini 3 Pro'
      if (id === 'gemini-3.5-flash') return 'Gemini 3.5 Flash'
      if (id === 'gemini-3-flash-preview') return 'Gemini 3 Flash'
      if (id === 'gemini-3.1-flash-lite-preview') return 'Gemini 3.1 Flash Lite'
      return id
    }
    const modelFriendly = getFriendlyModelName()
    const effort = (modelFriendly.match(/\(([^)]+)\)/)?.[1] ?? '').toLowerCase()
    const thinkingLabel = effort ? `Thinking with [${effort}] effort` : `Thinking with ${modelFriendly}`

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
        target.edit(`💭 ${sp} ${thinkingLabel}${d}`).catch(() => {})
      }, 1500)
    }

    // Post the placeholder bubble + start the spinner, once. No-op if a message
    // already occupies activeMessages[0] (timer + flushStream may both call it).
    const postPlaceholder = async () => {
      if (placeholderTimer) { clearTimeout(placeholderTimer); placeholderTimer = null }
      if (activeMessages.length > 0) { startSpinner(); return }
      const initialMsg = await sendReply(message, `💭 ${thinkingLabel}…`)
      if (initialMsg) activeMessages.push(initialMsg as Message)
      startSpinner()
    }

    if (opts.editTarget) {
      // Regenerate: reuse the existing bot message immediately, spinner on.
      activeMessages.push(opts.editTarget)
      await opts.editTarget.edit(`💭 ${thinkingLabel}…`).catch(() => {})
      startSpinner()
    } else if (flags.thinking === 'collapse') {
      // Collapse mode: post placeholder immediately so we see the spinner and "Thinking with..."
      await postPlaceholder()
    } else {
      // Normal turn: dots now, placeholder only if still working after the delay.
      placeholderTimer = setTimeout(() => { postPlaceholder().catch(() => {}) }, PLACEHOLDER_DELAY_MS)
    }

    let isFlushing = false
    const flushStream = async () => {
      if (isFlushing) return
      isFlushing = true
      try {
        let fullReply = ''
        const showLiveTools = flags.trace !== 'off' && liveToolCalls.length > 0
        if (showLiveTools) {
          const lines = liveToolCalls.map(c => {
            const prefix = c.failed ? '- ● ' : '+ ● '
            const suffix = c.running ? '...' : (c.failed ? ' FAILED' : '')
            return `${prefix}${shortToolName(c.name)}${suffix}`
          })
          fullReply += '🔧 **Tool trace**\n```diff\n' + lines.join('\n') + '\n```' + '\n\n'
        }
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
        if (flags.thinking !== 'collapse') {
          stopThinkingAnim()
        }

        if (fullReply === lastFlushedFullReply) return
        lastFlushedFullReply = fullReply

        const pieces = chunk(fullReply, 2000, 'newline')
        const offset = flags.thinking === 'collapse' ? 1 : 0
        
        for (let i = 0; i < pieces.length; i++) {
          await replaceActiveMessage(message, activeMessages, i + offset, pieces[i], 'stream')
        }
      } finally {
        isFlushing = false
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
      latestParsed = partial
    }, onLifecycleEvent, turnSignal)

    // OPTIONAL agy chat engine: route text turns through the Antigravity CLI
    // (flat Google sub) instead of the metered Gemini API. Mirrors gpt-bot's
    // /gpt engine swap. On throw we fall back to the API so the bot never goes
    // dark. Skipped when the turn carries media (agy -p is text-only).
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
    if (useAgy) {
      try {
        ({ parsed, meta } = await respondViaAgy({
          systemPrompt: fullSystemPrompt,
          history,
          userMessageText: userText,
          userName: message.author.username,
          channelId: message.channelId,
          onEvent: onLifecycleEvent,
        }, parseResponse))
      } catch (e) {
        // agy failed (timeout / empty / exec error) — fall back to the metered
        // API so the user still gets an answer, but FLAG it: the API path can't
        // shell/read files, so this turn quietly lost those capabilities.
        console.error('[agy] chat engine failed, falling back to API:', e instanceof Error ? e.message : e)
        agyFellBack = true
        ;({ parsed, meta } = await apiRespond())
      }
    } else {
      ({ parsed, meta } = await apiRespond())
    }
    const respondElapsedMs = Date.now() - respondT0

    if (streamInterval) {
      clearInterval(streamInterval)
      streamInterval = null
    }
    // Kill the spinner before final rendering so it can't edit a message we're
    // about to overwrite/delete (flushStream stops it on first content, but a
    // silent/empty turn may never have streamed any — stop it unconditionally).
    stopThinkingAnim()
    // One last flush to ensure we haven't missed anything before final rendering
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
    // code-execution as ONE card (Jeff 2026-06-29 — folded in the old show_code
    // content so they don't double-render or fragment into separate blocks).
    // STAYS WITH THE REPLY (top of finalFullReply). Renders for BOTH engines:
    // native gemini populates meta.toolCalls/searchQueries/codeArtifacts at its
    // dispatch site; agy materializes trajectory tool names into meta.toolCalls
    // post-hoc. 'collapse' renders inline then strips after a linger; 'on' keeps it.
    const traceExtras = { searchQueries: meta.searchQueries, codeArtifacts: meta.codeArtifacts }
    const showTrace = flags.trace !== 'off'
      && (meta.toolCalls.length > 0 || meta.searchQueries.length > 0 || meta.codeArtifacts.length > 0)
    if (showTrace) {
      finalFullReply += renderTraceCard(meta.toolCalls, traceExtras) + '\n\n'
    }

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
    if (flags.thinking !== 'off' && meta.nativeThoughts) {
      thinkingMessage += renderThoughtBlock('🧠 **Reasoning:**', meta.nativeThoughts) + '\n\n'
    }

    const showThinkingFinal = flags.thinking === 'collapse' || (flags.thinking === 'on' && !!parsed.thinking)
    if (showThinkingFinal) {
      const thoughtSecs = Math.round(respondElapsedMs / 1000)
      const header = `💭 ✓ **Thought for ${thoughtSecs}s**`
      if (parsed.thinking) {
        thinkingMessage += renderThoughtBlock(header, parsed.thinking) + '\n\n'
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
      ? headingsToBold(stripBotMetadata(stripDuplicateCodeBlocks(parsed.reply, meta.codeArtifacts)))
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

    // Engine-fallback badge (Jeff 2026-06-29). When an agy turn degraded to the
    // API engine, say so — the API path has no shell/filesystem, so the user
    // should know this reply came from the limited engine (and that agy is
    // having trouble). Shown regardless of the counter flag: a capability
    // degrade is not optional bookkeeping. Appended on its own line so it reads
    // as a distinct status note, not part of the token footer.
    if (agyFellBack) {
      finalFullReply = finalFullReply.replace(/\s+$/, '')
      finalFullReply += `\n\n-# ↩️ agy unavailable — answered on the API engine (no shell/files this turn)`
    }

    if (meta.finishReason === 'MAX_TOKENS') {
      finalFullReply += '\n\n-# ⚠️ response hit max-tokens limit (reply may be truncated)'
    } else if (meta.finishReason === 'SAFETY') {
      finalFullReply = '⚠️ response blocked by Gemini safety filter. ' + (finalFullReply || '(no content)')
    }

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
      const thinkingPieces = thinkingMessage ? chunk(thinkingMessage, 2000, 'newline').filter(p => p.trim() !== '') : []
      const replyPieces = finalFullReply ? chunk(finalFullReply, 2000, 'newline').filter(p => p.trim() !== '') : []
      const pieces = [...thinkingPieces, ...replyPieces]
      // Index in activeMessages where the reply (vs thinking) begins. Used by the
      // trace-collapse strip (operates on the reply's first chunk) and by the
      // thinking-collapse delete (removes the leading thinking messages).
      const replyStart = thinkingPieces.length

      for (let i = 0; i < pieces.length; i++) {
        await replaceActiveMessage(message, activeMessages, i, pieces[i], 'final')
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
      //   • thinking:collapse → DELETE the separate thinking message(s) entirely
      //     (indices 0..replyStart-1), leaving just the reply below. No more
      //     regex-stripping a combined string — the thought is its own message now,
      //     so we just remove it.
      //   • trace:collapse → strip the 🔧 trace card from the reply's first chunk,
      //     which now lives at activeMessages[replyStart] (the trace card stayed
      //     with the reply, not the thinking message).
      // Snapshot the messages we touch so a later turn mutating activeMessages
      // can't make the deferred callback hit the wrong message.
      const collapsingThinking = flags.thinking === 'collapse' && replyStart > 0
      const collapsingTrace = flags.trace === 'collapse' && showTrace
      const lingerMs = flags.thinking === 'collapse' ? 30_000 : (Number(process.env.GEMINI_THOUGHT_LINGER_MS) || 60_000)
      let thinkingSpliced = 0   // how many leading thinking msgs we removed (for traceIdx)

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
          thinkingSpliced = deleteCount
          setTimeout(() => {
            for (const m of thoughtMsgs) m.delete().catch(() => {})
          }, lingerMs)
        }
      }

      if (collapsingTrace) {
        // Calculate the collapsed reply pieces eagerly so we don't have to deal
        // with partial/split trace cards in individual chunks later.
        const collapsedReply = finalFullReply
          .replace(/(?:> )?🔧 \*\*Tool trace\*\*\n(?:> )?```diff\n[\s\S]*?\n(?:> )?```\n*/, '')
          .replace(/^\s+/, '')
        const collapsedPieces = chunk(collapsedReply, 2000, 'newline').filter(p => p.trim() !== '')
        const traceIdx = replyStart - thinkingSpliced
        
        setTimeout(async () => {
          try {
            const replyMessages = activeMessages.slice(traceIdx)
            if (replyMessages.length === 0) return

            for (let i = 0; i < collapsedPieces.length; i++) {
              const piece = collapsedPieces[i]
              if (i < replyMessages.length) {
                if (replyMessages[i].content !== piece) {
                  await replyMessages[i].edit(piece).catch(() => {})
                }
              } else {
                const msg = await sendReply(message, piece)
                if (msg) activeMessages.push(msg as Message)
              }
            }
            
            if (collapsedPieces.length < replyMessages.length) {
              const excess = replyMessages.slice(collapsedPieces.length)
              for (const m of excess) {
                await m.delete().catch(() => {})
                const idx = activeMessages.indexOf(m)
                if (idx !== -1) activeMessages.splice(idx, 1)
              }
            }
          } catch (err) {
            console.error('Failed to collapse trace card:', err)
          }
        }, lingerMs)
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
      // Honor thinking:collapse here too — delete the thought message(s) after the
      // linger, same as the main path.
      if (flags.thinking === 'collapse') {
        const thoughtMsgs = activeMessages.splice(0)
        const lingerMs = flags.thinking === 'collapse' ? 30_000 : (Number(process.env.GEMINI_THOUGHT_LINGER_MS) || 60_000)
        setTimeout(() => { for (const m of thoughtMsgs) m.delete().catch(() => {}) }, lingerMs)
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
      stopThinkingAnim()
      applyLifecycle(message, 'silenced').catch(() => {})
      for (const m of activeMessages) await m.delete().catch(() => {})
      activeMessages = []
      return
    }
    stopThinkingAnim()
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
      } else {
        await sendReply(message, msg)
      }
    } catch { /* nothing to do */ }
  } finally {
    stopThinkingAnim()
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
const channelTurns = new Map<string, { running: boolean; queue: Message[] }>()

async function runChannelTurn(message: Message, opts: HandleOpts = {}): Promise<void> {
  // Embed (always, for allowed messages) + gate. A gated-OUT message never
  // produces a placeholder, so it must not be queued or batched — just embed
  // it (done inside ingestAndGate) and drop it. Only gated-IN messages flow
  // into the serializer below.
  if (!ingestAndGate(message)) return

  const cid = message.channelId
  let st = channelTurns.get(cid)
  if (!st) { st = { running: false, queue: [] }; channelTurns.set(cid, st) }
  if (st.running) {
    // A turn is already generating for this channel — queue this message and
    // mark it seen. It'll be batched into the follow-up turn below.
    st.queue.push(message)
    void message.react('\u{1F557}').catch(() => {})
    return
  }
  st.running = true
  try {
    await handleUserMessage(message, opts)
    while (st.queue.length) {
      const batch = st.queue.splice(0, st.queue.length)
      // Carrier = the message whose attachments get processed. Default to the
      // LAST message, but if an EARLIER batched message carried attachments
      // (image/file) and the last didn't, prefer the one WITH attachments — else
      // a "[image]" then "what is this?" pair would silently drop the image
      // (only the carrier's attachments are ingested). Picks the last message
      // that has attachments; falls back to the final message.
      const withAtt = [...batch].reverse().find(m => m.attachments.size > 0)
      const carrier = withAtt ?? batch[batch.length - 1]
      const combined = batch.map(m => m.content).filter(Boolean).join('\n')
      const botId = client.user?.id
      if (botId) for (const m of batch) {
        void m.reactions.cache.get('\u{1F557}')?.users.remove(botId).catch(() => {})
      }
      await handleUserMessage(carrier, { combinedText: combined || undefined })
    }
  } finally {
    st.running = false
    if (!st.queue.length) channelTurns.delete(cid)
  }
}

client.on('messageCreate', async (message: Message) => {
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
