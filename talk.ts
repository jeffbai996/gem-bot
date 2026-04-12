import { Client, GatewayIntentBits, TextChannel } from 'discord.js'
import dotenv from 'dotenv'
import path from 'path'
import os from 'os'

const STATE_DIR = process.env.DISCORD_STATE_DIR || path.join(os.homedir(), '.gemini', 'channels', 'discord')
const ENV_PATH = path.join(STATE_DIR, '.env')
dotenv.config({ path: ENV_PATH })

const TOKEN = process.env.DISCORD_BOT_TOKEN
const CHANNEL_ID = process.argv[2]
const MESSAGE = process.argv[3]

if (!CHANNEL_ID || !MESSAGE) {
  console.error('Usage: tsx talk.ts <channel_id> <message>')
  process.exit(1)
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
})

client.on('ready', async () => {
  try {
    const channel = await client.channels.fetch(CHANNEL_ID) as TextChannel
    if (channel) {
      await channel.send(MESSAGE)
      console.log(`[OK] Sent to ${CHANNEL_ID}`)
    }
  } catch (e: any) {
    console.error(`[ERR] ${e.message}`)
  }
  process.exit(0)
})

client.login(TOKEN)
