# gem-discord-bot Context & Guidelines

This document provides context for agents working on `gem-discord-bot`.

## Project Overview
A standalone Discord bot using Discord.js and Gemini 2.0. It acts as an intelligent assistant with access to Gemini tools (Google Search, Code Execution) and supports full multimodal input (Images, Video, Audio, Documents).

## Core Architecture
- **Language/Runtime:** TypeScript + Node.js (via `tsx`).
- **State Management:** All state (`.env`, `access.json`, `persona.md`) lives in `~/.gemini/channels/discord/`.
- **Bot Persona:** "Gemma" — helpful, concise, responds to allowlisted users/channels.
- **Admin Control:** Discord Slash Commands (`/admin`) control permissions to avoid manual JSON edits.

## Development Rules
- Use `tsx` for running the bot locally (`npm run start`).
- Use `node:test` for testing (`npm run test`).
- Keep features modular (`src/gemini.ts`, `src/attachments.ts`, `src/chunk.ts`).
- Avoid adding heavy database dependencies unless strictly necessary (SQLite is preferred if needed later).
- When processing media, use `Promise.allSettled` to maintain high throughput and non-blocking I/O.

## Future Roadmap (Architectural Debt & New Features)
- **Real-Time Token Streaming (UX):** Transition from the current "wait and chunk" model to streaming responses directly into Discord via Webhook message editing, providing a ChatGPT-like typing experience for long generations.
- **Proactive Cron Jobs (Autonomy):** Enable Gemma to run scheduled tasks (e.g., pulling data from `ibkr-mcp`) to drop unprompted daily portfolio briefings, risk alerts, or earnings summaries into a dedicated channel.
- **Semantic Discord Search & SQLite Memory:** Implement a local vector database (like `sqlite-vss`) to persist facts across sessions and allow semantic searching over months of Discord history (e.g., "What did Dan say about copper prices last month?").
- **Agent Handoff & Multi-Agent Debates:** Give Gemma the ability to delegate sub-tasks (triggering `code-review-tool` on a GitHub link) or spawn secondary model instances to debate complex topics (e.g., generating a bull case, then calling a bear-case agent to argue against it).
- **Token-Aware Context Windowing:** Replace the hardcoded 20-message limit in `history.ts` with a dynamic token counter to maximize context efficiency without hitting API limits.
- **Voice Channel Intake:** Enable the bot to join Discord Voice Channels and transcribe/process audio streams using Gemini's native multimodal capabilities.
