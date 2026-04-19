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
- **Token-Aware Context Windowing:** Replace the hardcoded 20-message limit in `history.ts` with a dynamic token counter (e.g., using `js-tiktoken`) to maximize context efficiency.
- **Voice Channel Intake:** Enable the bot to join Discord Voice Channels and transcribe/process audio streams using Gemini's native multimodal capabilities.
- **Long-term SQLite Memory:** Implement a local SQLite vector/key-value store to persist user facts and preferences across sessions, reducing reliance on the short-term message buffer.
- **Agent Handoff:** Give Gemma the ability to delegate specific sub-tasks to other local CLI tools or external webhooks (e.g., triggering code reviews via `jules`).
