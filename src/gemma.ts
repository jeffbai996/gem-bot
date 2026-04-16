import { Client, GatewayIntentBits, Partials, ActivityType, type Message } from 'discord.js'
import path from 'path'
import os from 'os'
import dotenv from 'dotenv'
import { AccessManager } from './access.ts'
import { PersonaLoader } from './persona.ts'
import { fetchHistory, formatHistory } from './history.ts'
import { processAttachments, type InputAttachment } from './attachments.ts'
import { GeminiClient } from './gemini.ts'
import { chunk } from './chunk.ts'

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
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel, Partials.Message]
})

client.once('ready', () => {
  console.error(`Gemma online as ${client.user?.tag} (${client.user?.id})`)
  client.user?.setPresence({
    status: 'online',
    activities: [{ name: '🧠 hallucinating confidently', type: ActivityType.Playing }]
  })
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

  try {
    ;(message.channel as any).sendTyping().catch(() => {})

    const [history, attachmentResult] = await Promise.all([
      fetchHistory(message.channel as any, message.id).then(msgs => formatHistory(msgs, client.user!.id)),
      processAttachments(
        message.id,
        [...message.attachments.values()].map<InputAttachment>(a => ({
          url: a.url,
          name: a.name,
          size: a.size,
          contentType: a.contentType
        }))
      )
    ])

    if (attachmentResult.skipped.length > 0) {
      const notes = attachmentResult.skipped.map(s => `- ${s.name}: ${s.reason}`).join('\n')
      await message.reply({
        content: `skipped some attachments:\n${notes}`,
        allowedMentions: { repliedUser: false }
      })
    }

    const parsed = await gemini.respond({
      systemPrompt: persona.buildSystemPrompt(message.channelId),
      history,
      userMessageText: message.content,
      userMediaParts: attachmentResult.parts,
      userName: message.author.username
    })

    const tasks: Promise<unknown>[] = []

    if (parsed.react) {
      tasks.push(message.react(parsed.react).catch(e => console.error('react failed:', e)))
    }

    if (parsed.reply) {
      const pieces = chunk(parsed.reply, 2000, 'newline')
      for (const piece of pieces) {
        tasks.push((message.channel as any).send({
          content: piece,
          allowedMentions: { repliedUser: false }
        }).catch((e: any) => console.error('send failed:', e)))
      }
    }

    await Promise.all(tasks)
    await attachmentResult.cleanup()

  } catch (e: any) {
    console.error('message handler error:', e)
    const isRateLimit = e?.status === 429 || /rate/i.test(String(e?.message || ''))
    const msg = isRateLimit
      ? "hitting Gemini's rate limit — give me a minute"
      : "something broke reaching Gemini. check logs."
    try {
      await message.reply({ content: msg, allowedMentions: { repliedUser: false } })
    } catch { /* nothing to do */ }
  }
})

await client.login(DISCORD_TOKEN)
