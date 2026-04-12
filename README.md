# Gemini CLI Discord MCP Plugin

A fully-featured Model Context Protocol (MCP) server that bridges Discord and the Gemini CLI. This plugin allows your local Gemini CLI sessions to read and respond to messages, images, and files in Discord, exactly like the official Claude Code Discord plugin.

## Features
- **Stateless Operation:** History is fetched natively from Discord; no local database needed.
- **Multimodal Support:** Images and files dropped in Discord are seamlessly passed to Gemini CLI's vision and context window.
- **Thread Management:** Mentions in regular channels automatically spin off dedicated threads to keep conversations contained.
- **Smart Chunking:** Long responses are automatically split to accommodate Discord's 2000-character limit without breaking formatting.
- **Access Control & Pairing:** Security-first design using an `access.json` state file to gate who can talk to the bot and what channels it listens in. Unknown users are given a pairing code to authorize via terminal.

## Architecture

This plugin runs via `bun` or `tsx` and utilizes `@modelcontextprotocol/sdk`. It separates code from runtime state.
- **Code:** Lives in the `discord-mcp` directory (`src/server.ts`).
- **State:** Lives by default in `~/.gemini/channels/discord/`. This directory holds `.env`, `access.json`, downloaded attachments (`inbox/`), and pairing markers (`approved/`).

## Setup Instructions

### 1. Create a Discord Bot
1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and create a New Application.
2. In the **Bot** section, grab the **Token**.
3. Under **Privileged Gateway Intents**, enable **Message Content Intent**.
4. Use the OAuth2 URL Generator (bot scope, permissions: View Channels, Send Messages, Send Messages in Threads, Read Message History, Attach Files, Add Reactions) to invite the bot to your server.

### 2. Configure State Directory
Create the state directory and an `.env` file:
```bash
mkdir -p ~/.gemini/channels/discord
echo "DISCORD_BOT_TOKEN=your_token_here" > ~/.gemini/channels/discord/.env
```

### 3. Install the Plugin
In the root directory of this repository, install dependencies:
```bash
npm install
```

### 4. Register with Gemini CLI
Add this entry to your `~/.gemini/mcp.json` or `.gemini/settings.json` to register the Discord channel:

```json
{
  "mcpServers": {
    "discord": {
      "command": "npx",
      "args": ["-y", "tsx", "/path/to/discord-mcp/src/server.ts"]
    }
  }
}
```
*(Make sure to replace `/path/to/discord-mcp` with the actual path to this repository).*

### 5. Pairing a User
By default, the bot requires a pairing code for DMs.
1. Send a DM to your bot in Discord.
2. The bot will reply with a 6-character hex code (e.g., `a1b2c3`) and tell you to run a pairing command.
3. In your terminal, you can manually pair by creating a file in the `approved/` directory:
   ```bash
   mkdir -p ~/.gemini/channels/discord/approved
   echo "your_chat_id_here" > ~/.gemini/channels/discord/approved/your_discord_user_id_here
   ```
   *The background polling in `server.ts` will detect this, add you to `access.json`, and send a success message to Discord.*

## Development
- **Run Server Manually:** `npm start`
- **Run Tests:** `npm test`

## Security
- The `.env` file containing the Discord token is isolated in the state directory and should be locked down.
- The outbound gate (`canSendTo`) prevents Gemini from sending messages to unauthorized channels or users.
- All access control management occurs locally on the machine via `access.json`. Do not allow Gemini CLI to modify this file based on Discord input.