import { Client, GatewayIntentBits, Partials, ChannelType } from 'discord.js';
import dotenv from 'dotenv';
import path from 'path';
import os from 'os';

const STATE_DIR = process.env.DISCORD_STATE_DIR || path.join(os.homedir(), '.gemini', 'channels', 'discord');
dotenv.config({ path: path.join(STATE_DIR, '.env') });

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel, Partials.Message]
});

client.on('messageCreate', (message) => {
  if (message.author.bot) return;
  
  // Directly append to a "pending" log that Gemini CLI monitors
  const pendingFile = path.join(STATE_DIR, 'pending.jsonl');
  const entry = JSON.stringify({
    ts: message.createdAt.toISOString(),
    channelId: message.channelId,
    author: message.author.username,
    content: message.content
  }) + '\n';
  
  require('fs').appendFileSync(pendingFile, entry);
});

client.login(process.env.DISCORD_BOT_TOKEN);
