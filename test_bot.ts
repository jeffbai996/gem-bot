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
  partials: [
    Partials.Channel,
    Partials.Message,
    Partials.User,
    Partials.GuildMember,
    Partials.Reaction
  ]
})

client.on('ready', () => {
  console.log(`Test Bot logged in as ${client.user?.tag}`)
})

client.on('messageCreate', (message) => {
  console.log(`[TEST] Received message from ${message.author.tag} in ${message.channel.type === ChannelType.DM ? 'DM' : 'Channel'}: ${message.content}`)
})

client.login(process.env.DISCORD_BOT_TOKEN)