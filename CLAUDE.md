# gem-discord-bot Context & Guidelines

This document provides context for agents working on `gem-discord-bot`.

## Project Overview
A standalone Discord bot using Discord.js and Gemini 2.0. It acts as an intelligent assistant with access to Gemini tools (Google Search, Code Execution) and supports full multimodal input (Images, Video, Audio, Documents).

## Core Architecture
- **Language/Runtime:** TypeScript + Node.js (via `tsx`).
- **State Management:** All state (`.env`, `access.json`, `persona.md`) lives in `~/.gemini/channels/discord/`.
- **Bot Persona:** "Gem" — helpful, concise, responds to allowlisted users/channels.
- **Admin Control:** Discord Slash Commands (`/gemini`) control permissions to avoid manual JSON edits.

## Development Rules
- Use `tsx` for running the bot locally (`npm run start`).
- Use `node:test` for testing (`npm run test`).
- Keep features modular (`src/gemini.ts`, `src/attachments.ts`, `src/chunk.ts`).
- Avoid adding heavy database dependencies unless strictly necessary (SQLite is preferred if needed later).
- When processing media, use `Promise.allSettled` to maintain high throughput and non-blocking I/O.

## Deployment

Designed to run as a systemd user service (`gemma.service`) on a Linux host with Node 22+. The service invokes `node --import tsx/esm src/gemma.ts`.

Deploy flow (replace `<deploy-host>` and `<deploy-user>` with your own):

```bash
git push origin main
ssh <deploy-user>@<deploy-host> 'cd ~/gem-discord-bot && git pull && npm install && systemctl --user restart gemma'
```

Hot reload (no restart — reloads `access.json` and `persona.md` only):

```bash
ssh <deploy-user>@<deploy-host> 'systemctl --user kill -s HUP gemma'
```

Logs: `~/.gemini/channels/discord/gemma.log`.

## Runtime note — native modules

`better-sqlite3` and `sqlite-vss` are native Node modules. They do not work on Bun (`ERR_DLOPEN_FAILED`). Stay on Node+tsx until someone ports sqlite-vss to a Bun-friendly backend.

## Future Roadmap (Architectural Debt & New Features)
- **Proactive Cron Jobs (Autonomy):** Enable Gem to run scheduled tasks (e.g., pulling data from an external MCP server) to drop unprompted daily briefings, alerts, or summaries into a dedicated channel.
- **Agent Handoff & Multi-Agent Debates:** Give Gem the ability to delegate sub-tasks or spawn secondary model instances to debate complex topics (e.g., generating a bull case, then calling a bear-case agent to argue against it).
- **Token-Aware Context Windowing:** Replace the hardcoded 20-message limit in `history.ts` with a dynamic token counter to maximize context efficiency without hitting API limits.
- **Voice Channel Intake:** Enable the bot to join Discord Voice Channels and transcribe/process audio streams using Gemini's native multimodal capabilities.
