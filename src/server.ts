import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { Client, GatewayIntentBits, Partials, Message, ChannelType, TextChannel, ThreadChannel, DMChannel } from 'discord.js'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import https from 'https'
import dotenv from 'dotenv'
import { AccessManager } from './access.js'
import { chunk } from './chunk.js'

const STATE_DIR = process.env.DISCORD_STATE_DIR || path.join(os.homedir(), '.gemini', 'channels', 'discord')
const ENV_PATH = path.join(STATE_DIR, '.env')

// Load environment variables securely from the state directory
try {
  dotenv.config({ path: ENV_PATH })
} catch (e) {
  // ignore
}

const TOKEN = process.env.DISCORD_BOT_TOKEN
if (!TOKEN) {
  console.error(`Missing DISCORD_BOT_TOKEN. Please add it to ${ENV_PATH}`)
  process.exit(1)
}

const INBOX_DIR = path.join(STATE_DIR, 'inbox')
const APPROVED_DIR = path.join(STATE_DIR, 'approved')

// Initialize Access Manager
const accessManager = new AccessManager()

// Initialize Discord Client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [
    Partials.Channel,
    Partials.Message,
    Partials.User,
    Partials.GuildMember,
    Partials.Reaction
  ]
})

// Initialize MCP Server
const server = new Server(
  {
    name: 'claude-channel-discord',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
      experimental: {
        'claude/channel': {},
      }
    }
  }
)

const recentSentIds = new Set<string>()

client.on('ready', async () => {
  console.error(`[Discord] Logged in as ${client.user?.tag}`)
  client.user?.setActivity({ name: 'your requests', type: 2 }) // type 2 is LISTENING
  await accessManager.init()
  await fs.mkdir(INBOX_DIR, { recursive: true })
  
  // Start background poll for approvals
  setInterval(async () => {
    try {
      const files = await fs.readdir(APPROVED_DIR)
      for (const file of files) {
        if (file.startsWith('.')) continue
        const content = await fs.readFile(path.join(APPROVED_DIR, file), 'utf-8')
        const chatId = content.trim()
        
        // Add to allowlist
        if (!accessManager.access.allowFrom.includes(file)) {
          accessManager.access.allowFrom.push(file)
          await accessManager.save()
        }
        
        // Notify user
        const channel = await client.channels.fetch(chatId)
        if (channel && channel.isTextBased()) {
          await channel.send('✅ Paired! Say hi.')
        }
        
        // Remove marker
        await fs.unlink(path.join(APPROVED_DIR, file))
      }
    } catch (e) {
      // ignore
    }
  }, 5000)
})

client.on('messageCreate', async (message: Message) => {
  console.error(`[DEBUG] Received message from ${message.author.tag} in ${message.channel.type === ChannelType.DM ? 'DM' : 'Channel'}: ${message.content}`)
  
  if (message.author.bot) return

  const isDm = message.channel.type === ChannelType.DM
  
  // Check if it mentions the bot or replies to a bot message
  const isExplicitMention = client.user ? message.mentions.has(client.user.id) : false
  const isReplyToBot = message.reference?.messageId ? recentSentIds.has(message.reference.messageId) : false
  const isMention = isExplicitMention || isReplyToBot || isDm

  const gate = accessManager.canHandle(message.channelId, message.author.id, isDm, isMention)

  if (gate === 'deny') return

  if (gate === 'pair') {
    // Generate pairing code
    const code = await accessManager.generatePairing(message.author.id, message.channelId)
    // Only reply up to 2 times for pairing to avoid spam
    const pending = accessManager.access.pending[code]
    if (pending && pending.replies < 2) {
      pending.replies++
      await accessManager.save()
      await message.reply(`Pairing required. Run: \`gemini discord:access pair ${code}\` in your terminal.`)
    }
    return
  }

  // Handle message - Emit notification to Gemini
  if (accessManager.access.ackReaction) {
    message.react(accessManager.access.ackReaction).catch(() => {})
  }

  const attachments = message.attachments.map(a => ({
    name: a.name,
    type: a.contentType || 'unknown',
    size: a.size
  }))

  server.notification({
    method: 'notifications/channel',
    params: {
      content: message.content,
      meta: {
        chat_id: message.channelId,
        message_id: message.id,
        user: message.author.username,
        user_id: message.author.id,
        ts: message.createdAt.toISOString(),
        attachment_count: attachments.length,
        attachments: attachments.length > 0 ? attachments : undefined
      }
    }
  })
})

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'reply',
        description: 'Send message to Discord channel. Chunks long text at 2000 chars.',
        inputSchema: {
          type: 'object',
          properties: {
            chat_id: { type: 'string' },
            text: { type: 'string' },
            reply_to: { type: 'string' },
            files: { type: 'array', items: { type: 'string' } }
          },
          required: ['chat_id', 'text']
        }
      },
      {
        name: 'fetch_messages',
        description: 'Fetch up to 100 recent messages.',
        inputSchema: {
          type: 'object',
          properties: {
            channel: { type: 'string' },
            limit: { type: 'number' }
          },
          required: ['channel']
        }
      },
      {
        name: 'download_attachment',
        description: 'Download all attachments from a message.',
        inputSchema: {
          type: 'object',
          properties: {
            chat_id: { type: 'string' },
            message_id: { type: 'string' }
          },
          required: ['chat_id', 'message_id']
        }
      },
      {
        name: 'react',
        description: 'Add emoji reaction to a message.',
        inputSchema: {
          type: 'object',
          properties: {
            chat_id: { type: 'string' },
            message_id: { type: 'string' },
            emoji: { type: 'string' }
          },
          required: ['chat_id', 'message_id', 'emoji']
        }
      },
      {
        name: 'edit_message',
        description: 'Edit a previous bot message.',
        inputSchema: {
          type: 'object',
          properties: {
            chat_id: { type: 'string' },
            message_id: { type: 'string' },
            text: { type: 'string' }
          },
          required: ['chat_id', 'message_id', 'text']
        }
      },
      {
        name: 'set_presence',
        description: 'Set bot presence/status.',
        inputSchema: {
          type: 'object',
          properties: {
            status: { type: 'string' }
          },
          required: ['status']
        }
      }
    ]
  }
})

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params

  if (!args) {
    throw new Error('Arguments are required')
  }

  try {
    switch (name) {
      case 'reply': {
        const { chat_id, text, reply_to, files } = args as { chat_id: string, text: string, reply_to?: string, files?: string[] }
        
        if (!accessManager.canSendTo(chat_id)) {
          throw new Error('Access denied to send to this chat_id')
        }

        const channel = await client.channels.fetch(chat_id)
        if (!channel || !channel.isTextBased()) throw new Error('Invalid channel')

        const chunks = chunk(text, accessManager.access.textChunkLimit || 2000, accessManager.access.chunkMode || 'newline')
        const sentIds: string[] = []

        // Sanitized attachments
        const validFiles = files ? files.filter(f => f.startsWith(INBOX_DIR) || f.startsWith(os.homedir())) : undefined

        for (let i = 0; i < chunks.length; i++) {
          const payload: any = { content: chunks[i] }
          if (i === 0 && validFiles && validFiles.length > 0) {
            payload.files = validFiles.slice(0, 10)
          }
          if (reply_to && (i === 0 || accessManager.access.replyToMode === 'all')) {
            payload.reply = { messageReference: reply_to }
          }
          const sent = await channel.send(payload)
          recentSentIds.add(sent.id)
          if (recentSentIds.size > 200) {
            const first = recentSentIds.values().next().value
            if (first) recentSentIds.delete(first)
          }
          sentIds.push(sent.id)
        }

        return { content: [{ type: 'text', text: `Sent successfully. IDs: ${sentIds.join(', ')}` }] }
      }

      case 'fetch_messages': {
        const { channel: channelId, limit } = args as { channel: string, limit?: number }
        const channel = await client.channels.fetch(channelId)
        if (!channel || !channel.isTextBased()) throw new Error('Invalid channel')

        const messages = await channel.messages.fetch({ limit: limit || 10 })
        const formatted = messages.reverse().map(m => {
          let content = m.content
          if (m.attachments.size > 0) content += ` [+${m.attachments.size}att]`
          return `[${m.createdAt.toISOString()}] ${m.author.username} (${m.id}): ${content}`
        }).join('\n')

        return { content: [{ type: 'text', text: formatted || 'No messages.' }] }
      }

      case 'download_attachment': {
        const { chat_id, message_id } = args as { chat_id: string, message_id: string }
        const channel = await client.channels.fetch(chat_id)
        if (!channel || !channel.isTextBased()) throw new Error('Invalid channel')

        const msg = await channel.messages.fetch(message_id)
        const paths: string[] = []

        for (const [id, att] of msg.attachments) {
          const safeName = att.name.replace(/[\[\]\r\n;]/g, '_')
          const dest = path.join(INBOX_DIR, `${id}_${safeName}`)
          
          await new Promise((resolve, reject) => {
            https.get(att.url, (res) => {
              if (res.statusCode !== 200) return reject(new Error(`Failed to download: ${res.statusCode}`))
              const file = require('fs').createWriteStream(dest)
              res.pipe(file)
              file.on('finish', () => { file.close(); resolve(dest) })
            }).on('error', reject)
          })
          paths.push(dest)
        }

        return { content: [{ type: 'text', text: `Downloaded to:\n${paths.join('\n')}` }] }
      }

      case 'react': {
        const { chat_id, message_id, emoji } = args as { chat_id: string, message_id: string, emoji: string }
        const channel = await client.channels.fetch(chat_id)
        if (!channel || !channel.isTextBased()) throw new Error('Invalid channel')
        const msg = await channel.messages.fetch(message_id)
        await msg.react(emoji)
        return { content: [{ type: 'text', text: `Reacted with ${emoji}` }] }
      }

      case 'edit_message': {
        const { chat_id, message_id, text } = args as { chat_id: string, message_id: string, text: string }
        const channel = await client.channels.fetch(chat_id)
        if (!channel || !channel.isTextBased()) throw new Error('Invalid channel')
        const msg = await channel.messages.fetch(message_id)
        if (msg.author.id !== client.user?.id) throw new Error('Cannot edit messages from other users')
        await msg.edit(text)
        return { content: [{ type: 'text', text: `Message edited.` }] }
      }

      case 'set_presence': {
        const { status } = args as { status: string }
        client.user?.setActivity({ name: status })
        return { content: [{ type: 'text', text: `Presence set to: ${status}` }] }
      }

      default:
        throw new Error(`Unknown tool: ${name}`)
    }
  } catch (error: any) {
    return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true }
  }
})

// Start server
async function main() {
  await client.login(TOKEN)
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('MCP Server listening on stdio')
}

main().catch((error) => {
  console.error('Fatal error in main():', error)
  process.exit(1)
})