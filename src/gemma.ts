import { Client, GatewayIntentBits, Partials, ActivityType, REST, Routes, type Message } from 'discord.js'
import path from 'path'
import os from 'os'
import dotenv from 'dotenv'
import { AccessManager } from './access.ts'
import { PersonaLoader } from './persona.ts'
import { fetchHistory, formatHistory } from './history.ts'
import { processAttachments, processYouTubeUrls, type InputAttachment } from './attachments.ts'
import { GeminiClient } from './gemini.ts'
import { chunk } from './chunk.ts'
import { geminiCommand, executeGeminiCommand } from './commands.ts'
import { insertMessage } from './db.ts'

const STATE_DIR = process.env.DISCORD_STATE_DIR || path.join(os.homedir(), '.gemini', 'channels', 'discord')
dotenv.config({ path: path.join(STATE_DIR, '.env') })

const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN
const GEMINI_API_KEY = process.env.GEMINI_API_KEY
const MODEL_NAME = process.env.GEMINI_MODEL || 'gemini-2.0-flash'

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
const gemini = new GeminiClient(GEMINI_API_KEY, MODEL_NAME)

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
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.DirectMessageTyping,
    GatewayIntentBits.DirectMessageReactions,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel, Partials.Message, Partials.User]
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

client.on('messageCreate', async (message: Message) => {
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

    const [history, attachmentResult, ytResult] = await Promise.all([
      fetchHistory(message.channel as any, message.id).then(msgs => formatHistory(msgs, client.user!.id)),
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
    
    // Initial loading message
    const initialMsg = await message.reply({ content: '💭 *Thinking...*', allowedMentions: { repliedUser: false } }).catch(() => null)
    if (initialMsg) activeMessages.push(initialMsg as Message)

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

    const { parsed, meta } = await gemini.respond({
      systemPrompt: persona.buildSystemPrompt(message.channelId),
      history,
      userMessageText: message.content,
      userMediaParts: allParts,
      userName: message.author.username,
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

    if (parsed.react) {
      message.react(parsed.react).catch(e => console.error('react failed:', e))
    }

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
      const pieces = chunk(finalFullReply, 2000, 'newline')
      for (let i = 0; i < pieces.length; i++) {
        const piece = pieces[i]
        if (i < activeMessages.length) {
          await activeMessages[i].edit(piece).catch(() => {})
        } else {
          const msg = await message.reply({ content: piece, allowedMentions: { repliedUser: false } }).catch(() => null)
          if (msg) activeMessages.push(msg as Message)
        }
      }
      // Delete any leftover active messages if the final chunking shrank the message count
      for (let i = pieces.length; i < activeMessages.length; i++) {
        await activeMessages[i].delete().catch(() => {})
      }
    } else {
      // If the final reply is empty (e.g. only a react), delete the thinking messages
      for (const m of activeMessages) await m.delete().catch(() => {})
    }

    await Promise.all([attachmentResult.cleanup(), ytResult.cleanup()])

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
})

await client.login(DISCORD_TOKEN)
