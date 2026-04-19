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
    await executeGeminiCommand(interaction, access, persona, adminId)
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
  if (!gate) return

  let typingInterval: ReturnType<typeof setInterval> | null = null

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

    const { parsed, meta } = await gemini.respond({
      systemPrompt: persona.buildSystemPrompt(message.channelId),
      history,
      userMessageText: message.content,
      userMediaParts: allParts,
      userName: message.author.username,
      thinkingMode: flags.thinking
    })

    // Usage metadata — one line per turn for cost tracking
    if (meta.usage) {
      console.error(`[usage] channel=${message.channelId} prompt=${meta.usage.promptTokens} response=${meta.usage.responseTokens} total=${meta.usage.totalTokens}`)
    }
    // Non-STOP finish reasons deserve visibility (MAX_TOKENS truncation,
    // SAFETY filter, RECITATION, etc.)
    if (meta.finishReason && meta.finishReason !== 'STOP' && meta.finishReason !== 'FINISH_REASON_UNSPECIFIED') {
      console.error(`[finish] channel=${message.channelId} reason=${meta.finishReason}`)
    }
    // Flagged safety categories (MEDIUM/HIGH only)
    if (meta.flaggedSafety.length > 0) {
      console.error(`[safety] channel=${message.channelId} flagged=${JSON.stringify(meta.flaggedSafety)}`)
    }

    const tasks: Promise<unknown>[] = []

    if (parsed.react) {
      tasks.push(message.react(parsed.react).catch(e => console.error('react failed:', e)))
    }

    let fullReply = ''
    // Thinking block: "never" suppresses; "always" forces emission (the
    // system-prompt addendum tells Gemma to always populate it); "auto"
    // (default) trusts whatever Gemma decided per-message.
    const showThinking = flags.thinking !== 'never' && !!parsed.thinking
    if (showThinking && parsed.thinking) {
      const quotedThinking = parsed.thinking.split('\n').map(line => `> ${line}`).join('\n')
      fullReply += `💭 **Thinking:**\n${quotedThinking}\n\n`
    }

    // Code execution artifacts — gated by per-channel showCode flag. Render
    // before the reply so the reader sees "what she ran" → "what it said" →
    // "what she concluded" in natural order.
    if (flags.showCode && meta.codeArtifacts.length > 0) {
      for (const art of meta.codeArtifacts) {
        fullReply += `🛠️ **Code (${art.language}):**\n\`\`\`${art.language}\n${art.code}\n\`\`\`\n`
        if (art.output) {
          fullReply += `**Output:**\n\`\`\`\n${art.output.trim()}\n\`\`\`\n`
        }
        fullReply += '\n'
      }
    }

    if (parsed.reply) {
      fullReply += parsed.reply
    }

    // Grounding metadata footer — when googleSearch was used, show sources.
    // Compact one-line-per-source format. Markdown link syntax so Discord
    // renders them clickable.
    if (meta.groundingSources.length > 0 && parsed.reply) {
      fullReply += '\n\n-# ↳ sources: '
      fullReply += meta.groundingSources
        .slice(0, 5)
        .map((s, i) => `[${i + 1}](<${s.uri}>)`)
        .join(' · ')
    }

    // Non-STOP finish surfaced as a user-visible hint (only for MAX_TOKENS
    // and SAFETY which the user should know about). RECITATION/OTHER stay
    // in logs only.
    if (meta.finishReason === 'MAX_TOKENS') {
      fullReply += '\n\n-# ⚠️ response hit max-tokens limit (reply may be truncated)'
    } else if (meta.finishReason === 'SAFETY') {
      fullReply = '⚠️ response blocked by Gemini safety filter. ' + (fullReply || '(no content)')
    }

    if (fullReply) {
      const pieces = chunk(fullReply, 2000, 'newline')
      for (const piece of pieces) {
        tasks.push((message.channel as any).send({
          content: piece,
          allowedMentions: { repliedUser: false }
        }).catch((e: any) => console.error('send failed:', e)))
      }
    }

    await Promise.all(tasks)
    await Promise.all([attachmentResult.cleanup(), ytResult.cleanup()])

  } catch (e: any) {
    console.error('message handler error:', e)
    const isRateLimit = e?.status === 429 || /rate/i.test(String(e?.message || ''))
    const msg = isRateLimit
      ? "hitting Gemini's rate limit — give me a minute"
      : "something broke reaching Gemini. check logs."
    try {
      await message.reply({ content: msg, allowedMentions: { repliedUser: false } })
    } catch { /* nothing to do */ }
  } finally {
    if (typingInterval) clearInterval(typingInterval)
  }
})

await client.login(DISCORD_TOKEN)
