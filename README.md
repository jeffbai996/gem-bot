# gem-discord-bot

A standalone Discord bot backed by Google's Gemini. Runs as a Bun process on HOST, responds to allowlisted messages, supports image input, and can react with emoji.

The bot's in-Discord persona is "Gemma" — the repo name was simplified from `discord-mcp` to `gem-discord-bot` once the MCP approach was abandoned.

## Why not MCP?

An earlier version of this repo tried to be a Gemini-CLI MCP plugin. It didn't work: Gemini CLI has no push-event ingestion pathway, so there was no way for Discord messages to reach the model unprompted. Rebuilt as a standalone daemon instead — see `docs/superpowers/specs/2026-04-16-gemma-standalone-bot-design.md`.

## Stack

- TypeScript + Bun 1.x
- `discord.js` v14
- `@google/generative-ai` (Gemini 2.0 Flash by default)

---

## Features

### Messaging
- Responds to messages in configured channels
- Supports `requireMention` per channel — Gemma only speaks when `@Gemma`'d
- Shows typing indicator while Gemini is processing
- Splits long responses into ≤2000-char chunks at natural line breaks
- Fetches last 20 messages of channel history as conversation context

### Emoji reactions
- Gemma can react to your message with an emoji in addition to (or instead of) a text reply
- She picks the emoji herself based on context — Unicode and server custom emoji both work
- Add available custom emoji to `persona.md` so she knows what's in the server

### Image ingestion
- Attach PNG, JPEG, WebP, or GIF to any message — Gemma sees and describes the image
- Files over 20 MB are skipped with a note
- Other file types (PDF, video, etc.) are skipped in v1

### Persona & squad context
Gemma's system prompt is composed from three sources at runtime:
1. `persona.md` in the state dir — her personality and instructions
2. Shared squad memories — `<your-shared-context-dir>/memories/*.md`
3. Per-channel summary — `<your-shared-context-dir>/summaries/<channel_id>.md` (read fresh each turn)

She also has a hard-coded bot roster so she knows the other squad members by name and Discord ID.

### Hot reload
Edit `access.json` or `persona.md` and send SIGHUP — no restart needed:
```bash
# on HOST
systemctl --user kill -s HUP gemma
# or locally
kill -HUP $(pgrep -f 'bun src/gemma.ts')
```

---

## State directory

All runtime state lives in `~/.gemini/channels/discord/`:

| File | Purpose |
|---|---|
| `.env` | `DISCORD_BOT_TOKEN`, `GEMINI_API_KEY`, optional `GEMINI_MODEL` |
| `access.json` | User + channel allowlists |
| `persona.md` | System prompt (optional — built-in default if missing) |
| `inbox/` | Per-message attachment scratch dir (auto-cleaned after each turn) |
| `gemma.log` | Application log |

### access.json format

```json
{
  "users": {
    "<discord_user_id>": { "allowed": true }
  },
  "channels": {
    "<channel_id>": { "enabled": true, "requireMention": true }
  }
}
```

- Unknown users or channels are silently ignored — explicit allowlist only.
- `requireMention: true` — Gemma only responds when directly `@Gemma`'d in that channel.
- `requireMention: false` — Gemma responds to every message from an allowed user in that channel.
- Edits picked up on SIGHUP, no restart needed.

### persona.md

Plain markdown. Loaded at startup; reloaded on SIGHUP. If missing, a built-in default persona is used.

Useful things to include:
- Gemma's personality and tone
- Custom emoji available in the server (so she can react with them)
- Any standing instructions or context about the server

Example:
```markdown
You are Gemma, a Gemini-backed Discord bot. Be sharp and direct. Dry humor welcome.

Available custom emoji: :green: (<:green:1492450556277559326>), :pack11_sticker_14: (<:pack11_sticker_14:1492412038784352257>)
```

---

## Setup

### Prerequisites

- Bun 1.x
- A Discord bot application with:
  - **Message Content Intent** enabled (under Bot → Privileged Gateway Intents)
  - Permissions: View Channels, Send Messages, Send Messages in Threads, Read Message History, Add Reactions, Attach Files
- A Google AI Studio API key (aistudio.google.com → Get API key)

### Local dev

```bash
bun install
mkdir -p ~/.gemini/channels/discord
chmod 700 ~/.gemini/channels/discord

cat > ~/.gemini/channels/discord/.env <<EOF
DISCORD_BOT_TOKEN=your_token_here
GEMINI_API_KEY=your_key_here
# GEMINI_MODEL=gemini-2.0-flash   # optional override
EOF
chmod 600 ~/.gemini/channels/discord/.env

# Populate access.json with your user ID and channel IDs
cat > ~/.gemini/channels/discord/access.json <<EOF
{
  "users": { "YOUR_DISCORD_USER_ID": { "allowed": true } },
  "channels": { "YOUR_CHANNEL_ID": { "enabled": true, "requireMention": true } }
}
EOF

bun src/gemma.ts
```

Expected output: `Gemma online as gemma#XXXX (<bot-id>)`

### HOST deployment

Gemma runs as a systemd user service. Unit file at `~/.config/systemd/user/gemma.service`.

```bash
# Deploy update
git push origin main
ssh <deploy-user>@<deploy-host> 'wsl -u jbai -e bash -lc "cd ~/gem-discord-bot && git pull"'
ssh <deploy-user>@<deploy-host> 'wsl -u jbai -e bash -lc "systemctl --user restart gemma"'

# Check status
ssh <deploy-user>@<deploy-host> 'wsl -u jbai -e bash -lc "systemctl --user status gemma --no-pager"'
ssh <deploy-user>@<deploy-host> 'wsl -u jbai -e bash -lc "tail -20 ~/.gemini/channels/discord/gemma.log"'

# Reload config without restart
ssh <deploy-user>@<deploy-host> 'wsl -u jbai -e bash -lc "systemctl --user kill -s HUP gemma"'
```

---

## Tests

```bash
bun test
```

33 tests across 6 files covering: access filter, attachment processing, history formatting, Gemini response parsing, persona loading, and chunk splitting.
