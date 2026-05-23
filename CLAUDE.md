# gem-bot Context & Guidelines

This document provides context for agents working on `gem-bot`.

## Project Overview
A standalone Discord bot using Discord.js and the Gemini API (current default `gemini-3-flash-preview`, with `gemini-3-pro-preview`, `gemini-3.5-flash`, and `gemini-3.1-flash-lite-preview` selectable via `/gemini model`). It acts as an intelligent assistant with access to Gemini tools (Google Search, Code Execution) and supports full multimodal input (Images, Video, Audio, Documents).

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
ssh <deploy-user>@<deploy-host> 'cd ~/gem-bot && git pull && npm install && systemctl --user restart gemma'
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

## Live Voice — work-in-progress (paused 2026-05-22)

`/voice join` and `/voice leave` slash commands are wired and shipping. The
audio loop ends at the model layer — voice connection works, audio reaches
Gemini Live, but the model isn't responding and the WebSocket closes with
code 1000 after 17-77 seconds. The most recent diagnostic deploy is live;
the next session needs to read the new logs to confirm root cause.

### Architecture

Two-process design. Voice WS lives on the Node side; the LLM bridge is
Python.

- **gem-bot (Node, this repo)** — uses `@discordjs/voice` to join
  the user's vc, subscribes to the summoner's audio stream, streams raw
  48kHz Opus frames over a unix socket to gem-voice. Receives `audio_out`
  events with model Opus and plays them back via `AudioPlayer`.
- **gem-voice (Python, sibling repo `~/repos/gem-voice/`)** — long-lived
  systemd-managed daemon. Receives Opus via IPC, decodes to 16kHz PCM,
  forwards to Gemini Live, encodes the model's 24kHz PCM response back to
  48kHz Opus, emits as `audio_out` events.

IPC is NDJSON over `$XDG_RUNTIME_DIR/gem-voice.sock` (override with
`GEM_VOICE_SOCKET_PATH`). Audio frames carry base64-encoded Opus in the
`b64` field. Actions: `join`, `leave`, `status`, `audio_in`. Events:
`user_speech_start`, `user_speech_end`, `model_speech_start`,
`model_speech_end`, `audio_out`, `session_ended`, `error`.

### Files

- `src/voice.ts` — `VoiceManager` class. `joinVoiceChannel()`, IPC client,
  outbound `Readable` stream for model audio piped into `AudioPlayer`.
- `src/voice-commands.ts` — `/voice join` and `/voice leave` slash
  commands. Owner-gated via `CC_OWNER_DISCORD_USER_ID || DISCORD_ADMIN_ID`.
- `src/gemma.ts` — adds `GuildVoiceStates` intent, instantiates
  `VoiceManager` at boot, registers the `voice` slash command, routes
  interactionCreate.
- `tests/voice.test.ts` — 3 tests covering the IPC client surface only
  (join, audio_in base64, audio_out event handling). The discord.js
  voice side is covered manually because mocking `joinVoiceChannel` is
  heavy.

### Permissions

Gem's role needs **Connect**, **Speak**, **Use Voice Activity**, and
**View Channel** in the target voice channel (or guild-wide). Per-channel
denials override role grants — diagnosed when an unrestricted vc worked
and a specific one didn't.

### Open issue: model doesn't talk back

Sessions establish cleanly (`session_started` logged on gem-voice side,
voice connection up on gemma side, frames flowing per `gemini_send_progress`
logs). But Gemini Live closes the WebSocket with code 1000 ("normal
closure") after 17-77 seconds and the model never responds. The May 22
deploy fixes two suspected issues — switched model to
`gemini-live-2.5-flash-preview` (the SDK's documented model name; the
previous `gemini-3.1-flash-live-preview` may have been accepted then
silently rejected), and switched the send call from `audio=` to `media=`
kwarg per the SDK example.

### Diagnostic logging added in the May 22 deploy

`src/gem_voice/gemini_live.py` (in gem-voice repo) now logs:
- `gemini_send_progress` — first frame + every 100 frames, with byte size
- `gemini_send_stopped` — frame count at stream end
- `gemini_recv_no_server_content` — first 5 unexpected response shapes
- `gemini_audio_chunk` — first 3 audio chunks received with mime + bytes
- `gemini_turn_complete` — model finished a turn, with msg + chunk count
- `gemini_recv_failed` — error + msgs_received + audio_chunks counters

### Where to pick up next session

1. Have user run `/voice join`, talk for ~10 seconds, then run `/voice leave`.
2. Read gem-voice journal: `journalctl --user -u gem-voice -n 100 -o cat`.
3. Diagnose based on the counter values:
   - `frames_sent > 0` + `msgs_received == 0` → config issue (auth,
     model name still wrong, response_modalities mismatch).
   - `frames_sent > 0` + `msgs_received > 0` + `audio_chunks == 0` →
     model is responding with text instead of audio (response_modalities
     config wrong).
   - `audio_chunks > 0` + nothing playing in Discord → encode/playback
     path broken on gem-bot side; check Gemma logs for `audio_out`
     events arriving on the IPC socket.

### Cost guardrails

`src/gem_voice/session.py` has two timers:
- `GEM_VOICE_IDLE_TIMEOUT_S` (default 300s) — end session if no inbound
  Opus frame arrives.
- `GEM_VOICE_MAX_DURATION_S` (default 1800s) — hard ceiling regardless
  of activity.

Both emit `session_ended` with a `reason` field (`idle_timeout` or
`hard_max_duration`).
