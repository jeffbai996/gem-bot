# Gemma

A standalone Discord bot backed by Google's Gemini. Runs as a Bun process, one event loop, one purpose: respond to allowlisted messages in allowlisted channels.

## Why not MCP?

An earlier version of this repo tried to be a Gemini-CLI MCP plugin. It didn't work: Gemini CLI has no push-event ingestion pathway, so there was no way for Discord messages to reach the model unprompted. Rebuilt as a standalone daemon instead — see `docs/superpowers/specs/2026-04-16-gemma-standalone-bot-design.md`.

## Stack

- TypeScript + Bun 1.x
- `discord.js` v14
- `@google/generative-ai` (Gemini 2.0 Flash by default)

## State directory

All runtime state lives in `~/.gemini/channels/discord/`:

- `.env` — `DISCORD_BOT_TOKEN`, `GEMINI_API_KEY`, optional `GEMINI_MODEL`
- `access.json` — allowlists (users + channels); see format below
- `persona.md` — system prompt (optional; built-in default if missing)
- `inbox/` — per-message attachment scratch dir (auto-cleaned)

### access.json format

```json
{
  "users": {
    "<discord_user_id>": { "allowed": true }
  },
  "channels": {
    "<channel_id>": { "enabled": true, "requireMention": false }
  }
}
```

Edits are picked up on `SIGHUP` — no restart needed:

```bash
kill -HUP $(pgrep -f 'bun src/gemma.ts')
```

## Running locally

```bash
bun install
mkdir -p ~/.gemini/channels/discord
cat > ~/.gemini/channels/discord/.env <<EOF
DISCORD_BOT_TOKEN=...
GEMINI_API_KEY=...
EOF
bun src/gemma.ts
```

## Deployment (HOST)

See `docs/superpowers/specs/2026-04-16-gemma-standalone-bot-design.md` §Deployment. systemd user service at `~/.config/systemd/user/gemma.service`.

## Tests

```bash
bun test
```
