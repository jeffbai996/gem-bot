import { Client, GatewayIntentBits, Partials, ActivityType, REST, Routes, type Message } from 'discord.js'
import path from 'path'
import os from 'os'
import dotenv from 'dotenv'
import { AccessManager } from './access.ts'
import { PersonaLoader } from './persona.ts'
import { buildContextHistory, stripBotMetadata } from './history.ts'
import { processAttachments, processYouTubeUrls, type InputAttachment } from './attachments.ts'
import { GeminiClient, stripDuplicateCodeBlocks, GeminiRequestRejected } from './gemini.ts'
import { chunk } from './chunk.ts'
import { geminiCommand, executeGeminiCommand } from './commands.ts'
import { insertMessage } from './db.ts'
import { buildDefaultRegistry } from './tools/index.ts'
import { PendingEditsStore } from './reactions/pending-edits.ts'
import { applyLifecycle } from './reactions/lifecycle.ts'
import type { LifecycleEvent } from './gemini.ts'
import { PinnedFactsStore } from './pinned-facts.ts'
import { handleReaction } from './reactions/handler.ts'
import { SummaryStore } from './summarization/store.ts'
import { SummarizationScheduler } from './summarization/scheduler.ts'
import { fetchMessagesSince } from './db.ts'

const STATE_DIR = process.env.DISCORD_STATE_DIR || path.join(os.homedir(), '.gemini', 'channels', 'discord')
dotenv.config({ path: path.join(STATE_DIR, '.env') })

const MODEL_NAME = process.env.GEMINI_MODEL || 'gemini-2.0-flash'
const MAX_HISTORY_TOKENS = parseInt(process.env.MAX_HISTORY_TOKENS ?? '200000', 10)

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

// Compact display of tool-call args. Strings get quoted + truncated; objects
// get JSON-stringified + truncated. Keeps the inline `tool(arg1, arg2)`
// rendering readable when args are long URLs or big payloads.
function formatToolArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args)
  if (entries.length === 0) return ''
  const formatted = entries.map(([k, v]) => {
    let val: string
    if (typeof v === 'string') {
      val = v.length > 60 ? `"${v.slice(0, 57)}..."` : `"${v}"`
    } else {
      try { val = JSON.stringify(v) } catch { val = String(v) }
      if (val.length > 60) val = val.slice(0, 57) + '...'
    }
    return `${k}=${val}`
  })
  return formatted.join(', ')
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
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel, Partials.Message, Partials.User, Partials.Reaction]
})

client.once('ready', async () => {
  console.error(`Gemma online as ${client.user?.tag} (${client.user?.id})`)
  client.user?.setPresence({
    status: 'online',
    activities: [{ name: '🔮 hallucinating confidently', type: ActivityType.Custom, state: '🔮 hallucinating confidently' }]
  })

  try {
    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN)
    await rest.put(
      Routes.applicationCommands(client.user!.id),
      { body: [geminiCommand.toJSON()] }
    )
    console.error('Slash commands registered.')
  } catch (error) {
    console.error('Failed to register slash commands:', error)
  }
})

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return

  if (interaction.commandName === 'gemini') {
    const adminId = process.env.DISCORD_ADMIN_ID
    await executeGeminiCommand(interaction, access, persona, gemini, adminId, {
      summaryStore,
      summarizer,
    })
  }
})

interface HandleOpts {
  // When set, edit this message in place for the *first* reply chunk instead
  // of sending a fresh reply. Additional chunks (rare) still post as new
  // replies after the edited target.
  editTarget?: Message
  // When true, prepend an "expand on previous reply" instruction to the
  // user message text before passing to Gemini.
  expansion?: boolean
}

async function handleUserMessage(message: Message, opts: HandleOpts = {}): Promise<void> {
  if (message.author.bot) return
  if (!client.user) return

  const isMention = message.mentions.users.has(client.user.id)
  const gate = access.canHandle({
    channelId: message.channelId,
    userId: message.author.id,
    isMention
  })
  
  // Background Memory Ingestion
  // If the user is allowed to speak in the channel, log the message to SQLite VSS.
  // We do this independently of the `gate` (which requires mention) so the bot
  // learns from passive conversation in allowed channels.
  if (access.isAllowedAndEnabled(message.author.id, message.channelId) && message.content.trim()) {
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

  if (!gate) return

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

    const allParts = [...attachmentResult.parts, ...ytResult.parts]
    const allSkipped = [...attachmentResult.skipped, ...ytResult.skipped]

    if (allSkipped.length > 0) {
      const notes = allSkipped.map(s => `- ${s.name}: ${s.reason}`).join('\n')
      await message.reply({
        content: `skipped some attachments:\n${notes}`,
        allowedMentions: { repliedUser: false }
      })
    }

    const flags = access.channelFlags(message.channelId)

    let latestParsed = { react: null as string | null, thinking: null as string | null, reply: null as string | null }
    let lastFlushedFullReply = ''

    // Initial loading message. When opts.editTarget is set, reuse that bot
    // message (regenerate / ✏️ flow) instead of sending a new reply.
    if (opts.editTarget) {
      activeMessages.push(opts.editTarget)
      await opts.editTarget.edit('💭 *Thinking...*').catch(() => {})
    } else {
      const initialMsg = await message.reply({ content: '💭 *Thinking...*', allowedMentions: { repliedUser: false } }).catch(() => null)
      if (initialMsg) activeMessages.push(initialMsg as Message)
    }

    // Lifecycle: 🤔 once the placeholder is up and we're about to call
    // Gemini. Cleans up the prior 👀.
    applyLifecycle(message, 'thinking').catch(() => {})

    let isFlushing = false
    const flushStream = async () => {
      if (isFlushing) return
      isFlushing = true
      try {
        let fullReply = ''
        const showThinking = flags.thinking !== 'never' && !!latestParsed.thinking
        if (showThinking && latestParsed.thinking) {
          const quotedThinking = latestParsed.thinking.split('\n').map(line => `> ${line}`).join('\n')
          fullReply += `💭 **Thinking:**\n${quotedThinking}\n\n`
        }
        if (latestParsed.reply) {
          fullReply += latestParsed.reply
        }
        
        if (!fullReply) fullReply = '💭 *Thinking...*'

        if (fullReply === lastFlushedFullReply) return
        lastFlushedFullReply = fullReply

        const pieces = chunk(fullReply, 2000, 'newline')
        
        for (let i = 0; i < pieces.length; i++) {
          const piece = pieces[i]
          if (i < activeMessages.length) {
            if (activeMessages[i].content !== piece) {
              await activeMessages[i].edit(piece).catch(() => {})
            }
          } else {
            const msg = await message.reply({ content: piece, allowedMentions: { repliedUser: false } }).catch(() => null)
            if (msg) activeMessages.push(msg as Message)
          }
        }
      } finally {
        isFlushing = false
      }
    }

    streamInterval = setInterval(() => { flushStream() }, 2000)

    const userText = opts.expansion
      ? `[The user wants you to expand on your previous reply with more depth and detail.]\n\n${message.content}`
      : message.content

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
      } else if (e.type === 'tool_call_end') {
        activeToolCount = Math.max(0, activeToolCount - 1)
        // We don't actively drop 🔧 when activeToolCount hits 0 — the
        // terminal state (✅ / ❌ / etc) cleans up all transients
        // anyway, and a tool ending mid-turn just means we keep going.
      }
    }
    const { parsed, meta } = await gemini.respond({
      systemPrompt: persona.buildSystemPrompt(message.channelId),
      history,
      userMessageText: userText,
      userMediaParts: allParts,
      userName: message.author.username,
      channelId: message.channelId,
      thinkingMode: flags.thinking,
      cacheEnabled: flags.cache,
      cacheTtlSec: flags.cacheTtlSec ?? undefined,
    }, (partial) => {
      latestParsed = partial
    }, onLifecycleEvent)
    const respondElapsedMs = Date.now() - respondT0

    if (streamInterval) {
      clearInterval(streamInterval)
      streamInterval = null
    }
    // One last flush to ensure we haven't missed anything before final rendering
    await flushStream()

    // Usage metadata — one line per turn for cost tracking
    if (meta.usage) {
      console.error(`[usage] channel=${message.channelId} prompt=${meta.usage.promptTokens} response=${meta.usage.responseTokens} total=${meta.usage.totalTokens}`)
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
      // Delete the "💭 *Thinking...*" placeholder — no orphan above the silence.
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

    // Native thinking summaries from gemini-3 thinking models (parts with
    // `thought: true`). Distinct from `parsed.thinking` (our JSON-wrapper
    // CoT prose). Only render when verbose is on — otherwise this floods the
    // chat with reasoning the user didn't ask for.
    // Header sits at column 0; body blockquoted so the inner content visually
    // indents under the header without doubling up the indent on the title.
    if (flags.verbose && meta.nativeThoughts) {
      const quoted = meta.nativeThoughts.split('\n').map(line => `> ${line}`).join('\n')
      finalFullReply += `🧠 **Reasoning:**\n${quoted}\n\n`
    }

    const showThinkingFinal = flags.thinking !== 'never' && !!parsed.thinking
    if (showThinkingFinal && parsed.thinking) {
      const quotedThinking = parsed.thinking.split('\n').map(line => `> ${line}`).join('\n')
      finalFullReply += `💭 **Thinking:**\n${quotedThinking}\n\n`
    }

    // Search queries Gemma typed into Google. Lets the user catch misframed
    // queries without parsing the output. Same gate as code artifacts — same
    // audience that wants "show your work" wants this. Format mirrors
    // ticker-tape's chat.py: header at column 0, query bullets blockquoted
    // for visual indent under the header.
    if (flags.showCode && meta.searchQueries.length > 0) {
      finalFullReply += `🔍 **Web search**\n`
      for (const q of meta.searchQueries) {
        finalFullReply += `> · ${q}\n`
      }
      finalFullReply += '\n'
    }

    // Tool calls (fetch_url, search_memory, IBKR tools, etc). googleSearch +
    // codeExecution are server-side, surfaced via their own dedicated blocks.
    if (flags.showCode && meta.toolCalls.length > 0) {
      for (const call of meta.toolCalls) {
        const argSummary = formatToolArgs(call.args)
        const failedMark = call.failed ? ' ❌' : ''
        finalFullReply += `🛠️ \`${call.name}(${argSummary})\`${failedMark} *[${call.durationMs}ms]*\n`
        if (call.resultPreview) {
          finalFullReply += `   ↳ \`${call.resultPreview}\`\n`
        }
      }
      finalFullReply += '\n'
    }

    if (flags.showCode && meta.codeArtifacts.length > 0) {
      for (const art of meta.codeArtifacts) {
        finalFullReply += `🛠️ **Code (${art.language}):**\n\`\`\`${art.language}\n${art.code}\n\`\`\`\n`
        if (art.output) {
          finalFullReply += `**Output:**\n\`\`\`\n${art.output.trim()}\n\`\`\`\n`
        }
        finalFullReply += '\n'
      }
    }

    // Strip prose-side fenced code blocks that duplicate an artifact we already
    // rendered above. gemini-3-pro-preview repeats executed code in its reply
    // text; the artifact block is the canonical render.
    // Strip any token-footer / sources / metadata pattern the model might
    // hallucinate inside its own reply text (it learns the pattern from past
    // turns where the bot stamped footers; with stripBotMetadata in
    // history.ts the input is now clean, but belt-and-suspenders.)
    const replyText = parsed.reply
      ? stripBotMetadata(flags.showCode ? stripDuplicateCodeBlocks(parsed.reply, meta.codeArtifacts) : parsed.reply)
      : null
    if (replyText) {
      finalFullReply += replyText
    }

    if (meta.groundingSources.length > 0 && parsed.reply) {
      finalFullReply += '\n\n-# ↳ sources: '
      finalFullReply += meta.groundingSources
        .slice(0, 5)
        .map((s, i) => `[${i + 1}](<${s.uri}>)`)
        .join(' · ')
    }

    // Verbose ops footer — token usage + response time. Format:
    //   `↑ 14.2K · ↓ 310 · 4.2s`
    // ↑ = prompt tokens (sent up), ↓ = response tokens (came down). Wrapped
    // in backticks so it reads as a discrete data badge, distinct from the
    // bot's prose. Response time replaces total-tokens — wall-clock is more
    // actionable than the sum (you can derive thinking-token spend from
    // total - prompt - response if you need it from the logs).
    if (flags.verbose) {
      const u = meta.usage
      const respondElapsedSec = (respondElapsedMs / 1000).toFixed(1)
      // Format: ` ↑ N · ↓ N · » Xs ` inside inline-code backticks WITH
      // leading + trailing space padding so iOS doesn't render the box
      // jammed flush against the closing backtick / "(edited)" badge.
      // » (U+00BB) prefixes the elapsed-time field — clean ASCII glyph,
      // monochrome everywhere, no iOS emoji autopromotion like ⏱ had.
      // Per-message footer is intentionally cache-agnostic — cache details
      // (size, hit count, age, TTL remaining) live behind /gemini cache info
      // so we don't pollute every reply with bookkeeping the user only checks
      // occasionally. Cache hits are still observed via lower bills, just not
      // surfaced inline.
      const tokenStr = u
        ? `\` ↑ ${formatTokenCount(u.promptTokens)} · ↓ ${formatTokenCount(u.responseTokens)} · » ${respondElapsedSec}s \``
        : `\` » ${respondElapsedSec}s — no usage data \``
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
      // Edit streaming preview messages in place to become the final output.
      // The prior approach (delete all streaming messages, then send fresh ones)
      // produced duplicate messages when a delete silently failed — the send
      // ran regardless, leaving the old message alive next to the new one.
      // Trading the "(edited)" marker for zero-duplicate guarantee.
      const pieces = chunk(finalFullReply, 2000, 'newline')
      for (let i = 0; i < pieces.length; i++) {
        const piece = pieces[i]
        if (i < activeMessages.length) {
          if (activeMessages[i].content !== piece) {
            await activeMessages[i].edit(piece).catch(err => {
              console.error(`final edit failed for chunk ${i}:`, err)
            })
          }
        } else {
          const msg = await message.reply({ content: piece, allowedMentions: { repliedUser: false } }).catch(() => null)
          if (msg) activeMessages.push(msg as Message)
        }
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
    } else {
      // If the final reply is empty (e.g. only a react), delete the thinking messages
      for (const m of activeMessages) await m.delete().catch(() => {})
    }

    await Promise.all([attachmentResult.cleanup(), ytResult.cleanup()])

    // Fire-and-forget: kick off conversation summarization if the channel
    // has accumulated enough new messages. Single-flight per channel inside
    // the scheduler — safe to call on every reply.
    summarizer.scheduleIfNeeded(message.channelId)

  } catch (e: any) {
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
        await message.reply({ content: msg, allowedMentions: { repliedUser: false } })
      }
    } catch { /* nothing to do */ }
  } finally {
    if (typingInterval) clearInterval(typingInterval)
    if (streamInterval) clearInterval(streamInterval)
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
        await handleUserMessage(message, { editTarget: target })
        return
      } catch (e) {
        console.error('[reactions] edit-target fetch failed, falling through:', e)
      }
    }
  }
  await handleUserMessage(message, {})
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
