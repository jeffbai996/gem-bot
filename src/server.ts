import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { Client, GatewayIntentBits, Partials } from 'discord.js'
import fs from 'fs'
import path from 'path'
import os from 'os'
import dotenv from 'dotenv'

const STATE_DIR = process.env.DISCORD_STATE_DIR || path.join(os.homedir(), '.gemini', 'channels', 'discord')
dotenv.config({ path: path.join(STATE_DIR, '.env') })

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel, Partials.Message]
})

const server = new Server({ name: 'gemini-discord-interactive', version: '1.0.0' }, { capabilities: { tools: {} } })

client.on('messageCreate', (message) => {
  if (message.author.bot) return
  fs.appendFileSync(path.join(STATE_DIR, 'pending.jsonl'), JSON.stringify({
    ts: message.createdAt.toISOString(), channelId: message.channelId, author: message.author.username, content: message.content
  }) + '\n')
})

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'read_pending',
    description: 'Read and clear pending messages from Discord.',
    inputSchema: { type: 'object', properties: {} }
  }]
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  console.error("[DEBUG] Received Tool Call:", request.params.name);
  if (request.params.name === 'read_pending') {
    const file = path.join(STATE_DIR, 'pending.jsonl')
    if (!fs.existsSync(file)) return { content: [{ type: 'text', text: 'No pending messages.' }] }
    const content = fs.readFileSync(file, 'utf8')
    fs.unlinkSync(file)
    return { content: [{ type: 'text', text: content }] }
  }
  return { content: [{ type: 'text', text: 'Unknown tool' }], isError: true }
})

client.login(process.env.DISCORD_BOT_TOKEN)
server.connect(new StdioServerTransport())
