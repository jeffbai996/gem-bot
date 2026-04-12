import { Client, GatewayIntentBits, Partials, ChannelType } from 'discord.js'
import dotenv from 'dotenv'

dotenv.config({ path: '/Users/user/.gemini/channels/discord/.env' })

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message]
})

client.on('ready', async () => {
  console.log(`Test Bot logged in as ${client.user?.tag}`)
  try {
    const user = await client.users.fetch('REDACTED_USER_ID')
    console.log(`Fetched user: ${user.tag}`)
    const dmChannel = await user.createDM()
    console.log(`Created/Fetched DM channel: ${dmChannel.id}`)
    const messages = await dmChannel.messages.fetch({ limit: 5 })
    console.log(`Found ${messages.size} messages.`)
    messages.forEach(msg => {
      console.log(`[${msg.createdAt}] ${msg.author.tag}: ${msg.content}`)
    })
  } catch (e) {
    console.error('Error fetching DMs:', e)
  }
  process.exit(0)
})

client.login(process.env.DISCORD_BOT_TOKEN)