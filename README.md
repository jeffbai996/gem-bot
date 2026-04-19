# gem-discord-bot

A standalone Discord bot backed by Google's Gemini 2.0. Runs as a Node.js/`tsx` process, responds to allowlisted messages, supports multimodal input (images, video, audio, documents), uses native Gemini tools (Google Search, Code Execution), and can react with emoji.

The bot's in-Discord persona is "Gemma" — the repo name was simplified from `discord-mcp` to `gem-discord-bot` once the MCP approach was abandoned.

## Why not MCP?

An earlier version of this repo tried to be a Gemini-CLI MCP plugin. It didn't work: Gemini CLI has no push-event ingestion pathway, so there was no way for Discord messages to reach the model unprompted. Rebuilt as a standalone daemon instead.

## Stack

- TypeScript + Node.js (via `tsx`)
- `discord.js` v14
- `@google/generative-ai` (Gemini 2.0 Flash by default; override with `GEMINI_MODEL`)

---

## Features

### Intelligence & Tools
- **Native Tool Use:** Automatically uses Google Search and Code Execution when appropriate.
- **Chain-of-Thought (CoT):** Displays a `💭 **Thinking:**` blockquote when reasoning through complex prompts before delivering the final answer.

### Messaging & UX
- **Heartbeat Typing:** Discord's typing indicator is maintained recursively until Gemini finishes processing, preventing timeout drop-offs during long tool-use or CoT generations.
- **Smart Chunking:** Splits long responses into ≤2000-char chunks. Syntax-aware splitting preserves markdown code block formatting (`` ``` ``) across message boundaries.
- **Context Window:** Fetches the last 20 messages of channel history as conversation context.
- **Emoji Reactions:** Can react to a message with an emoji based on context.

### Multimodal Ingestion (Parallelized & Cached)
- **Images** (PNG, JPEG, WebP, GIF, HEIC) & **Documents** (PDF, TXT, HTML, JS/TS): processed inline via base64.
- **Video + Audio**: Uploaded via the Gemini File API.
- **Parallel Processing:** Multiple attachments are processed concurrently via `Promise.allSettled` for maximum speed.
- **URI Caching:** Discord media URLs are cached to Gemini `fileUri`s, preventing redundant uploads and allowing the bot to "remember" images from earlier in the conversation history.

### Admin Slash Commands
Manage the bot directly from Discord without touching terminal files. Requires `DISCORD_ADMIN_ID` in `.env` (or Server Admin permissions).
- `/admin allow @user`
- `/admin revoke @user`
- `/admin channel #channel [enabled] [require_mention]`
- `/admin persona <filename.md>` (Hot-swaps the active persona)

### Persona & Shared Context
The system prompt is composed at runtime from:
1. The active persona file (e.g., `persona.md`) in the state dir.
2. Shared memory files — any `*.md` under `$SQUAD_CONTEXT_DIR/memories/` (optional).
3. Per-channel summary — `$SQUAD_CONTEXT_DIR/summaries/<channel_id>.md` (read fresh each turn, optional).

---

## Future Roadmap
- **Real-Time Token Streaming (UX):** Transition from the current "wait and chunk" model to streaming responses directly into Discord via Webhook message editing, providing a ChatGPT-like typing experience for long generations.
- **Proactive Cron Jobs (Autonomy):** Enable Gemma to run scheduled tasks (e.g., pulling data from `ibkr-mcp`) to drop unprompted daily portfolio briefings, risk alerts, or earnings summaries into a dedicated channel.
- **Semantic Discord Search & SQLite Memory:** Implement a local vector database (like `sqlite-vss`) to persist facts across sessions and allow semantic searching over months of Discord history (e.g., "What did Dan say about copper prices last month?").
- **Agent Handoff & Multi-Agent Debates:** Give Gemma the ability to delegate sub-tasks (triggering `code-review-tool` on a GitHub link) or spawn secondary model instances to debate complex topics (e.g., generating a bull case, then calling a bear-case agent to argue against it).
- **Token-Aware Context Windowing:** Replace the hardcoded 20-message limit with a dynamic token counter to maximize context efficiency without hitting API limits.
- **Voice Channel Intake:** Enable the bot to join Discord Voice Channels and transcribe/process audio streams natively using Gemini's multimodal capabilities.

---

## State directory

All runtime state lives in `~/.gemini/channels/discord/` (override via `DISCORD_STATE_DIR`):

| File | Purpose |
|---|---|
| `.env` | `DISCORD_BOT_TOKEN`, `GEMINI_API_KEY`, `DISCORD_ADMIN_ID`, optional `GEMINI_MODEL` |
| `access.json` | User + channel allowlists (Modified via `/admin` commands) |
| `persona.md` | Default System prompt |
| `inbox/` | Per-message attachment scratch dir (auto-cleaned after each turn) |

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
- Can be modified securely via the `/admin` Discord slash commands.

---

## Setup

### Prerequisites

- Node.js (v20+)
- A Discord bot application with:
  - **Message Content Intent** enabled (Bot → Privileged Gateway Intents)
  - Permissions: View Channels, Send Messages, Send Messages in Threads, Read Message History, Add Reactions, Attach Files
- A Google AI Studio API key (aistudio.google.com → Get API key)

### Local dev

```bash
npm install
mkdir -p ~/.gemini/channels/discord
chmod 700 ~/.gemini/channels/discord

cat > ~/.gemini/channels/discord/.env <<EOF
DISCORD_BOT_TOKEN=your_token_here
GEMINI_API_KEY=your_key_here
DISCORD_ADMIN_ID=your_personal_discord_user_id
# GEMINI_MODEL=gemini-2.0-flash   # optional override
EOF
chmod 600 ~/.gemini/channels/discord/.env

# Optionally create a default access.json, though /admin commands can handle this later
cat > ~/.gemini/channels/discord/access.json <<EOF
{
  "users": { "YOUR_DISCORD_USER_ID": { "allowed": true } },
  "channels": { "YOUR_CHANNEL_ID": { "enabled": true, "requireMention": true } }
}
EOF

npm run start
```

Expected output: 
```
Gemma online as <bot-username>#XXXX (<bot-id>)
Slash commands registered.
```

---

## Tests

```bash
npm run test
```

Coverage: access filter, attachment processing, history formatting, Gemini response parsing, persona loading, and chunk splitting.
