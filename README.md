# gem-discord-bot

A standalone Discord bot backed by Google's Gemini. Runs as a Bun process, responds to allowlisted messages, supports multimodal input (images, video, audio, documents), and can react with emoji.

The bot's in-Discord persona is "Gemma" — the repo name was simplified from `discord-mcp` to `gem-discord-bot` once the MCP approach was abandoned.

## Why not MCP?

An earlier version of this repo tried to be a Gemini-CLI MCP plugin. It didn't work: Gemini CLI has no push-event ingestion pathway, so there was no way for Discord messages to reach the model unprompted. Rebuilt as a standalone daemon instead.

## Stack

- TypeScript + Bun 1.x
- `discord.js` v14
- `@google/generative-ai` (Gemini 2.0 Flash by default; override with `GEMINI_MODEL`)

---

## Features

### Messaging
- Responds to messages in configured channels
- `requireMention` per channel — bot only speaks when directly `@`-tagged
- Typing indicator while Gemini is processing
- Splits long responses into ≤2000-char chunks at natural line breaks
- Fetches last 20 messages of channel history as conversation context

### Emoji reactions
- Can react to a message with an emoji in addition to (or instead of) a text reply
- Picks the emoji itself based on context — Unicode and server custom emoji both work
- List available custom emoji in `persona.md` so the model knows what's in the server

### Multimodal ingestion
- **Images** (PNG, JPEG, WebP, GIF, HEIC): inline base64
- **Video + Audio**: Gemini File API upload → poll until ACTIVE → fileUri reference
- **Documents** (PDF, plaintext, markdown, CSV, HTML, JS/TS): inline base64
- Files over the per-type size limit are skipped with a note in-channel

### Persona & optional shared context
The system prompt is composed at runtime from up to three sources:
1. `persona.md` in the state dir — personality, instructions, bot roster if desired
2. Shared memory files — any `*.md` under `$SQUAD_CONTEXT_DIR/memories/` (optional)
3. Per-channel summary — `$SQUAD_CONTEXT_DIR/summaries/<channel_id>.md` (read fresh each turn, optional)

If `SQUAD_CONTEXT_DIR` is unset or the dirs don't exist, only `persona.md` is used.

### Hot reload
Edit `access.json` or `persona.md` and send SIGHUP — no restart needed:
```bash
# under systemd
systemctl --user kill -s HUP gemma

# local dev
kill -HUP $(pgrep -f 'bun src/gemma.ts')
```

---

## State directory

All runtime state lives in `~/.gemini/channels/discord/` (override via `DISCORD_STATE_DIR`):

| File | Purpose |
|---|---|
| `.env` | `DISCORD_BOT_TOKEN`, `GEMINI_API_KEY`, optional `GEMINI_MODEL` |
| `access.json` | User + channel allowlists |
| `persona.md` | System prompt (optional — built-in default if missing) |
| `inbox/` | Per-message attachment scratch dir (auto-cleaned after each turn) |
| `gemma.log` | Application log (when running under systemd) |

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
- `requireMention: true` — bot only responds when directly `@`-tagged in that channel.
- `requireMention: false` — bot responds to every message from an allowed user in that channel.
- Edits picked up on SIGHUP, no restart needed.

### persona.md

Plain markdown. Loaded at startup; reloaded on SIGHUP. If missing, a built-in default persona is used.

Useful things to include:
- Personality and tone
- Custom emoji available in the server (so the model can react with them)
- Any standing instructions or context about the server
- Bot roster if you run multiple bots (names + Discord user IDs)

---

## Setup

### Prerequisites

- Bun 1.x
- A Discord bot application with:
  - **Message Content Intent** enabled (Bot → Privileged Gateway Intents)
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

cat > ~/.gemini/channels/discord/access.json <<EOF
{
  "users": { "YOUR_DISCORD_USER_ID": { "allowed": true } },
  "channels": { "YOUR_CHANNEL_ID": { "enabled": true, "requireMention": true } }
}
EOF

bun src/gemma.ts
```

Expected output: `Gemma online as <bot-username>#XXXX (<bot-id>)`

### Systemd user service (Linux)

Example `~/.config/systemd/user/gemma.service`:

```ini
[Unit]
Description=Gemma — Gemini Discord bot
After=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/repos/gem-discord-bot
ExecStart=%h/.local/bin/bun src/gemma.ts
Restart=always
RestartSec=10
StandardOutput=append:%h/.gemini/channels/discord/gemma.log
StandardError=append:%h/.gemini/channels/discord/gemma.log

[Install]
WantedBy=default.target
```

Enable and start:
```bash
loginctl enable-linger $USER   # so the service survives logout
systemctl --user daemon-reload
systemctl --user enable --now gemma
systemctl --user status gemma
```

---

## Tests

```bash
bun test
```

Coverage: access filter, attachment processing, history formatting, Gemini response parsing, persona loading, and chunk splitting.
