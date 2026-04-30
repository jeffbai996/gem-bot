import { Client, GatewayIntentBits, Partials, ActivityType, REST, Routes, type Message } from 'discord.js'
import path from 'path'
import os from 'os'
import dotenv from 'dotenv'
import { AccessManager } from './access.ts'
import { PersonaLoader } from './persona.ts'
import { buildContextHistory } from './history.ts'
import { processAttachments, processYouTubeUrls, type InputAttachment } from './attachments.ts'
import { GeminiClient } from './gemini.ts'
import { chunk } from './chunk.ts'
import { geminiCommand, executeGeminiCommand } from './commands.ts'
import { insertMessage } from './db.ts'
import { buildDefaultRegistry } from './tools/index.ts'
import { PendingEditsStore } from './reactions/pending-edits.ts'
import { isValidOutboundReactEmoji } from './reactions/vocabulary.ts'
import { PinnedFactsStore } from './pinned-facts.ts'
import { handleReaction } from './reactions/handler.ts'
import { SummaryStore } from './summarization/store.ts'
import { SummarizationScheduler } from './summarization/scheduler.ts'
import { fetchMessagesSince } from './db.ts'

const STATE_DIR = process.env.DISCORD_STATE_DIR || path.join(os.homedir(), '.gemini', 'channels', 'discord')
dotenv.config({ path: path.join(STATE_DIR, '.env') })

const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN
const GEMINI_API_KEY = process.env.GEMINI_API_KEY
const MODEL_NAME = process.env.GEMINI_MODEL || 'gemini-2.0-flash'
const MAX_HISTORY_TOKENS = parseInt(process.env.MAX_HISTORY_TOKENS ?? '200000', 10)

if (!DISCORD_TOKEN) {
  console.error(`FATAL: DISCORD_BOT_TOKEN missing. Set in ${path.join(STATE_DIR, '.env')}`)
  process.exit(1)
}
if (!GEMINI_API_KEY) {
  console.error(`FATAL: GEMINI_API_KEY missing. Set in ${path.join(STATE_DIR, '.env')}`)
  process.exit(1)
}

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
    activities: [{ name: '🧠 hallucinating confidently', type: ActivityType.Playing }]
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
    await executeGeminiCommand(interaction, access, persona, gemini, adminId)
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
  const userAllowed = access.data.users[message.author.id]?.allowed
  const channelEnabled = access.data.channels[message.channelId]?.enabled
  if (userAllowed && channelEnabled && message.content.trim()) {
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

  let typingInterval: ReturnType<typeof setInterval> | null = null
  let streamInterval: ReturnType<typeof setInterval> | null = null

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
    let activeMessages: Message[] = []

    // Initial loading message. When opts.editTarget is set, reuse that bot
    // message (regenerate / ✏️ flow) instead of sending a new reply.
    if (opts.editTarget) {
      activeMessages.push(opts.editTarget)
      await opts.editTarget.edit('💭 *Thinking...*').catch(() => {})
    } else {
      const initialMsg = await message.reply({ content: '💭 *Thinking...*', allowedMentions: { repliedUser: false } }).catch(() => null)
      if (initialMsg) activeMessages.push(initialMsg as Message)
    }

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

    const { parsed, meta } = await gemini.respond({
      systemPrompt: persona.buildSystemPrompt(message.channelId),
      history,
      userMessageText: userText,
      userMediaParts: allParts,
      userName: message.author.username,
      channelId: message.channelId,
      thinkingMode: flags.thinking
    }, (partial) => {
      latestParsed = partial
    })

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

    // gemini-3-pro-preview frequently omits the `react` field despite the
    // persona instruction. Default to 👀 to guarantee a reaction.
    let reactToFire: string | null = null
    if (parsed.react && isValidOutboundReactEmoji(parsed.react)) {
      reactToFire = parsed.react
    } else if (parsed.react) {
      console.error(`[react skipped] not a valid unicode emoji: ${JSON.stringify(parsed.react)}`)
      reactToFire = '👀'
    } else {
      reactToFire = '👀'
    }
    message.react(reactToFire).catch(e => console.error('react failed:', e))

    let finalFullReply = ''
    const showThinkingFinal = flags.thinking !== 'never' && !!parsed.thinking
    if (showThinkingFinal && parsed.thinking) {
      const quotedThinking = parsed.thinking.split('\n').map(line => `> ${line}`).join('\n')
      finalFullReply += `💭 **Thinking:**\n${quotedThinking}\n\n`
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

    if (parsed.reply) {
      finalFullReply += parsed.reply
    }

    if (meta.groundingSources.length > 0 && parsed.reply) {
      finalFullReply += '\n\n-# ↳ sources: '
      finalFullReply += meta.groundingSources
        .slice(0, 5)
        .map((s, i) => `[${i + 1}](<${s.uri}>)`)
        .join(' · ')
    }

    if (meta.finishReason === 'MAX_TOKENS') {
      finalFullReply += '\n\n-# ⚠️ response hit max-tokens limit (reply may be truncated)'
    } else if (meta.finishReason === 'SAFETY') {
      finalFullReply = '⚠️ response blocked by Gemini safety filter. ' + (finalFullReply || '(no content)')
    }

    if (!finalFullReply && !parsed.react) {
       finalFullReply = '(Empty response)'
    }

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
    const msg = isRateLimit
      ? "hitting Gemini's rate limit — give me a minute"
      : "something broke reaching Gemini. check logs."
    try {
      await message.reply({ content: msg, allowedMentions: { repliedUser: false } })
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
