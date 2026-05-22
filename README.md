# gem-discord-bot

**A Discord bot backed by Google's Gemini 3, with multimodal input, live tools, semantic memory, and a "show your work" UI that surfaces every search query, tool call, code execution, and reasoning step inline.**

The in-Discord persona is **Gem**. The repo name was simplified from `gemini-discord-mcp` to `gem-discord-bot` once the MCP approach was abandoned (see [Why not MCP?](#why-not-mcp) below).

---

## Anatomy of a reply

A single turn against Gem in a verbose-mode channel renders something like this:

> **`@you`** &nbsp; what's the latest on the FOMC decision today, and back-of-envelope what a 25bp cut would do to the 10y? *(reaction added by Gem: 👀)*

> **Gem** &nbsp; *(reactions evolve as the turn progresses: 👀 → 🤔 → 🌐 → 🧠 → 🔧 → ✅)*
>
> 🌐 **Web search**
> &nbsp;&nbsp;• `FOMC decision May 2026`
> &nbsp;&nbsp;• `10 year treasury yield reaction rate cut`
>
> 🛠️ **Tool calls**
> &nbsp;&nbsp;• `fetch_url("https://www.federalreserve.gov/...")` &nbsp;`[412ms]` &nbsp;↳ *FOMC Statement, May 7 2026 — held rates at 4.25–4.50%, dot plot now showing 2 cuts in 2026 vs 1 prior...*
>
> 🛠️ **Code (python)**
> ```python
> # rough duration-based price impact
> dur_10y = 8.4
> dy = -0.0025  # 25bp cut, approximate yield response
> price_pct = -dur_10y * dy
> print(f"~{price_pct*100:.2f}% price move")
> ```
> &nbsp;&nbsp;↳ `~2.10% price move`
>
> 🧠 **Reasoning**
> &nbsp;&nbsp;User wants both fact + analysis. Pulled the FOMC statement live (training data is stale), got the held-rates outcome and the revised dot plot. Then translated the hypothetical 25bp move into a duration-based price estimate. Modified duration on the 10Y is ~8.4, so a 25bp parallel down-shift maps to roughly +2.1% on price (yield down → price up).
>
> ---
>
> Fed held at 4.25–4.50% today. Dot plot moved to **2 cuts pencilled in for the rest of 2026** (vs 1 last meeting). Powell's presser leaned dovish on services inflation but stayed cagey on timing.
>
> If they had cut 25bp instead: 10Y price ~+2.1% on duration alone (mod dur ~8.4, parallel shift). Real life would be messier — curve usually steepens on a cut, so the long end moves less than the short end. Call it +1.5% to +2% on the 10Y.
>
> ` ↑ 14,200 · ↓ 310 · » 4.2s `

The verbose blocks (🌐 / 🛠️ / 🧠 / 💭 / token+time footer) are toggleable per channel. With them off, you get just the prose reply and a token footer — the model still uses every tool, you just don't see the receipts.

---

## Features

### Tools the model can use mid-reply

- **Native Gemini tools** — `googleSearch` and `codeExecution` fire automatically when the model decides to. The bot drops `codeExecution` from the tool list when the request payload contains audio or video — Gemini's codeExecution mime allowlist is stricter than the model's video-understanding allowlist, and `.mov` / `.mp4` files with embedded timed-text tracks 400 the entire request otherwise.
- **Function-call registry** — model can call `fetch_url` (Mozilla Readability extraction with SSRF guard), `search_memory` (semantic recall over the channel's history, see RAG below), and any registered IBKR / utility tools. Each call is wrapped with timing + result-preview capture for the verbose surface.
- **Tool-call loop** capped at 5 iterations to bound runaway cost. On exhaustion the model gets one final no-tools pass to wrap up gracefully instead of cutting mid-turn.
- **Streaming with edit-flushing** — long responses stream into Discord via `message.edit()` as tokens arrive. Streaming preview messages get edited in place to become the final output (zero-duplicate guarantee on chunk-count changes).

### Multimodal ingestion

- **Images** (PNG, JPEG, WebP, GIF, HEIC) and **documents** (PDF, TXT, HTML, JS/TS) inline as base64.
- **Video and audio** (mp4, mov→quicktime, mpeg, webm, wav, mp3, flac, etc.) upload via the Gemini File API. Mime types validated against an allowlist before upload.
- **YouTube URLs** in the message body are fetched via `yt-dlp` for auto-subs, ingested as text.
- **Parallel processing** — `Promise.allSettled` on attachment + YouTube workers.
- **URI cache** — Discord media URLs cached to Gemini `fileUri`s so the model can "remember" media from earlier in the conversation without re-uploading.

### Semantic memory (RAG)

- **Background ingestion** — messages from allowed users in allowed channels are embedded with `gemini-embedding-001` (768-dim) and stored in SQLite + [`sqlite-vss`](https://github.com/asg017/sqlite-vss). Throttled at most one embed per (channel, user) per 3 s (`GEMINI_EMBED_COOLDOWN_MS`) so chatty users don't fire continuous embed calls.
- **Retrieval tool** — the model can call `search_memory` mid-generation to pull semantically-relevant past messages for the current channel.
- **Conversation summarization** — background `SummarizationScheduler` rolls up older history into per-channel summaries that get injected into the system prompt — keeps long-running channels from blowing the context window without losing prior context.
- **Backfill** — `/gemini backfill #channel [limit]` embeds recent history on demand after deploying to an existing channel. Inter-call delay defaults to 100 ms (`GEMINI_BACKFILL_DELAY_MS`) so a 500-msg backfill doesn't fire 500 sequential API hits in &lt;1 s.

### Reactions — both directions

**Gem reacts to your message as the turn progresses.** Every inbound message Gem decides to handle gets a live emoji reaction that updates as work happens — 👀 the moment the gate passes, then evolving through thinking, ingesting attachments, searching, calling tools, until ✅ on reply. If something goes wrong, the terminal reaction tells you why (truncated / blocked / denied / errored). One glance at the message tells you exactly what happened without reading the response.

| Stage | Emoji |
|-------|-------|
| Received (gate passed) | 👀 |
| Thinking (placeholder up, Gemini call about to start) | 🤔 |
| Ingesting (attachment or YouTube URL detected) | 📎 |
| Native thinking (first `thought: true` part from gemini-3) | 🧠 |
| Searching (first non-empty `webSearchQueries`) | 🌐 |
| Tooling (function-call dispatch start/end) | 🔧 |
| Replied (substantive content committed) | ✅ |
| Truncated (`finishReason === MAX_TOKENS`) | ✂️ |
| Blocked (`finishReason === SAFETY`) | 🛑 |
| Denied (caught 429 / quota / rate-limit) | ⚠️ |
| Errored (everything else) | ❌ |
| Silenced (turn ended with no reply emitted — gate flipped, output filtered, or no-op pass) | 🖥️ |

Each event de-dupes per turn so a stream yielding N grounding chunks doesn't spam N reactions. The terminal 🖥️ tombstone slides forward per channel — only the most recent silenced turn carries the badge, older ones get cleared so 🖥️ never piles up.

**You react to Gem's reply to drive bot actions** (gated through `PinnedFactsStore`):

| Emoji | Action |
|------|--------|
| 🔁 | Regenerate the reply with the same prompt |
| 🔍 | Expand on the previous reply with more depth |
| 📌 | Pin a fact to this channel's persistent prompt |
| ❌ | Gem deletes her own message |
| 🔇 / 🔊 | Per-user channel mute toggle |
| ✏️ | Mark for edit — Gem's next reply edits this message in place |

Inbound 🛑 short-circuits the next tool call as a stop signal (see the cc-context discord plugin patch).

### Context caching (per channel, opt-in)

When `cache: true` for a channel, the stable system-prompt prefix (persona + response-format addendum + thinking-mode addendum + rolling channel summary + pinned facts + tools + toolConfig) is cached server-side via `client.caches.create`. Per-call, only the volatile parts (recent history tail + the new user message) flow on the wire; the API references the cached prefix by name.

Cached input tokens bill at **10% of the normal rate** (90% discount; Google's published rate for Gemini 2.5/3.x context caching). Typical hit: ~6,000-token prompt with ~4,000 cached → ~60% input-cost reduction.

The in-process manager keys on `(model, hash(systemText), hash(toolsAndConfig))`. Because the channel summary is part of `systemText`, every summarizer rollup naturally rotates into a fresh cache (old one ages out via TTL — no explicit invalidation needed). Different thinking modes also get separate caches; identical persona+summary across two channels collapses into one shared cache.

TTL defaults to 2 hours, configurable per channel via `/gemini cache ttl <seconds>` (60–86400). `/gemini cache info` (ephemeral) shows live cache state with size, age, hit count, and lifecycle. Fail-open: any error during cache create falls back to the uncached path.

### Persona & shared context

The system prompt is composed at runtime from:

1. The active persona file (`persona.md` by default) in the state dir.
2. Pinned facts from `pinned-facts.md`.
3. Per-channel conversation summary from `SummaryStore` (refreshed by the background scheduler).
4. A response-format JSON contract — instructs the model to emit `{react, thinking, reply}` since `responseSchema` is incompatible with Gemini's built-in tools.

**Per-guild persona overrides.** Drop a `persona.<guildId>.md` file in the state dir and Gem loads that persona when running in that guild, falling back to the default `persona.md` everywhere else. Hot-swappable at runtime via `/gemini persona <filename>` for the current guild — no restart, no global flag flip.

Gem's persona file establishes the core rule: **never pretend you did something you couldn't do.** She has `googleSearch`, `codeExecution`, multimodal perception, Discord history, and YouTube transcript ingestion — but no shell, no file write, no IBKR account state, no ability to grant her own access. Hallucinating action is the single biggest failure mode and the persona makes that explicit.

---

### Voice channel intake (experimental)

`/voice join` / `/voice leave` slash commands bring Gem into a Discord voice channel. The voice loop is a two-process design:

- **gem-discord-bot (this repo)** — uses `@discordjs/voice` to join the summoner's vc, subscribes to their audio stream, streams raw 48kHz Opus frames over a unix socket to a sibling daemon. Receives `audio_out` events with model Opus and plays them back via `AudioPlayer`.
- **[gem-voice](https://github.com/jeffbai996/gem-voice)** (separate Python repo) — long-lived systemd daemon. Decodes Opus, forwards to Gemini Live, re-encodes the model's response back to Opus.

IPC is NDJSON over `$XDG_RUNTIME_DIR/gem-voice.sock` (override with `GEM_VOICE_SOCKET_PATH`). Permissions Gem needs in the target channel: **Connect**, **Speak**, **Use Voice Activity**, **View Channel**.

Owner gate: `CC_OWNER_DISCORD_USER_ID` (or `DISCORD_ADMIN_ID` as fallback).

**Status (2026-05-22):** voice connection and IPC handshake work; Gemini Live closes the WebSocket after 17-77s without responding. Diagnostic logging is live in the gem-voice sibling repo. See `CLAUDE.md` for the open-issue triage path.

---

## Slash commands

Manage everything from inside Discord — no terminal-side JSON edits required. Requires `DISCORD_ADMIN_ID` in `.env` (or Server Admin permissions).

| Command | Purpose |
|---------|---------|
| `/gemini allow @user` / `/gemini revoke @user` | User allowlist |
| `/gemini channel #channel enabled require_mention` | Enable/disable in a channel; require @ mention or not |
| `/gemini set <flag> <value> [#channel]` | Per-channel flags. `flag`: `thinking` (`always\|auto\|never`), `show_code` (`true\|false`), `verbose` (`true\|false`), `require_mention` (`true\|false` — flip the @-mention gate without re-running `/gemini channel`) |
| `/gemini model <name>` | Switch the global Gemini model and auto-restart the bot. Choices include `gemini-3-flash-preview` (default), `gemini-3-pro-preview`, `gemini-3.5-flash`, `gemini-3.1-flash-lite-preview` |
| `/gemini cache on\|off [#channel]` | Toggle server-side context caching |
| `/gemini cache info` | Live cache details — size, hits, age, TTL, hash |
| `/gemini cache ttl <seconds> [#channel]` | Per-channel TTL override (60–86400; `0` resets to default) |
| `/gemini cache flush` | Drop all in-process cache refs |
| `/gemini clear [#channel]` | Reset Gem's context — bumps history watermark, blanks summary, flushes cache |
| `/gemini compact [#channel]` | Force a context-summary rollup right now |
| `/gemini persona <filename.md>` | Hot-swap the active persona |
| `/gemini backfill #channel [limit]` | Embed recent history into semantic memory |

---

## State directory

Runtime state lives in `~/.gemini/channels/discord/` (override via `DISCORD_STATE_DIR`):

| File / dir | Purpose |
|---|---|
| `.env` | `DISCORD_BOT_TOKEN`, `GEMINI_API_KEY`, `DISCORD_ADMIN_ID`, optional `GEMINI_MODEL`, `MAX_HISTORY_TOKENS` (default 80000), `MAX_UNSUMMARIZED_MESSAGES`, `SUMMARIZATION_BATCH_LIMIT`, `GEMINI_EMBED_COOLDOWN_MS` (default 3000), `GEMINI_BACKFILL_DELAY_MS` (default 100) |
| `access.json` | User + channel allowlists with per-channel render flags |
| `memory.db` | SQLite + sqlite-vss database of embedded messages |
| `persona.md` | Default system prompt |
| `pinned-facts.md` | Persistent facts injected every turn |
| `gemma.log` | Service log (info + errors) |
| `summaries.json` | Per-channel rolled-up summaries |
| `inbox/` | Per-message attachment scratch dir (auto-cleaned) |

### `access.json` shape

```json
{
  "users": {
    "<discord_user_id>": { "allowed": true }
  },
  "channels": {
    "<channel_id>": {
      "enabled": true,
      "requireMention": true,
      "thinking": "auto",
      "showCode": true,
      "verbose": true,
      "cache": true,
      "cacheTtlSec": null
    }
  }
}
```

Unknown users or channels are silently ignored — explicit allowlist only. Every flag is modifiable via `/gemini` slash commands; editing `access.json` directly works too.

---

## Setup

### Prerequisites

- Node.js v22+
- A Discord bot application with:
  - **Message Content Intent** enabled (Bot → Privileged Gateway Intents)
  - Permissions: View Channels, Send Messages, Send Messages in Threads, Read Message History, Add Reactions, Attach Files
- A Google AI Studio API key

### Local dev

```bash
npm install
mkdir -p ~/.gemini/channels/discord
chmod 700 ~/.gemini/channels/discord

cat > ~/.gemini/channels/discord/.env <<EOF
DISCORD_BOT_TOKEN=your_token_here
GEMINI_API_KEY=your_key_here
DISCORD_ADMIN_ID=your_personal_discord_user_id
GEMINI_MODEL=gemini-3-flash-preview
EOF
chmod 600 ~/.gemini/channels/discord/.env

# Optional bootstrap (or use /gemini commands later)
cat > ~/.gemini/channels/discord/access.json <<EOF
{
  "users": { "YOUR_DISCORD_USER_ID": { "allowed": true } },
  "channels": {
    "YOUR_CHANNEL_ID": {
      "enabled": true,
      "requireMention": true,
      "thinking": "auto",
      "showCode": false,
      "verbose": false
    }
  }
}
EOF

npm run start
```

Expected startup:

```
◇ injected env (3) from ../../.gemini/channels/discord/.env
Gem online as <bot-username>#XXXX (<bot-id>)
Slash commands registered.
```

### Production

Runs as a systemd user service (`gemma.service`) on Node 22+ via nvm.

```bash
# Pull + redeploy
git pull && npm install
systemctl --user restart gemma

# Hot reload (access.json + persona.md only, no code reload):
systemctl --user kill -s HUP gemma
```

Logs: `~/.gemini/channels/discord/gemma.log`. Status: `systemctl --user status gemma`.

---

## Tests

```bash
npm run test
```

Coverage: access manager (allowlist + flags + invariants), Gemini client (response parsing, tool extraction, mime sanitization), attachments processing, history formatting + token budgeting, persona loading, chunk splitting, pinned-facts store, summarization scheduler, reactions handler.

---

## Why not MCP?

An earlier version tried to be a Gemini-CLI MCP plugin. It didn't work: Gemini CLI has no push-event ingestion pathway, so there was no way for inbound Discord messages to reach the model unprompted. Rebuilt as a standalone daemon instead.

The bot still *consumes* MCP — it auto-discovers tools from an external MCP server and bridges them into Gemini's function-call format via `mcpSchemaToGemini`. So MCP became the integration protocol, not the runtime.

---

## Stack

TypeScript · Node.js 22+ (`tsx`) · `discord.js` v14 · `@google/genai` (Gemini 3 Flash by default; override via `GEMINI_MODEL`) · `better-sqlite3` + `sqlite-vss` · `@modelcontextprotocol/sdk` · `@mozilla/readability` + `jsdom` · `yt-dlp` (system binary, optional)

---

## Roadmap

- **Voice channel intake** — `/voice join` ships behind the experimental flag; finish wiring Gemini Live so the model actually talks back (currently sessions establish but the model never responds before WS close). See [Voice channel intake](#voice-channel-intake-experimental).
- **Proactive cron jobs** — scheduled Gem broadcasts (daily portfolio briefings, risk alerts, earnings summaries) into a dedicated channel.
- **Multi-agent debates** — delegate sub-tasks to a code-review agent on a GitHub link, or spawn secondary instances to argue both sides of a thesis.
- **Token-aware context windowing** — replace the hard 80k token cap with a dynamic counter so long contexts trim by relevance instead of FIFO.

---

## License

MIT — see [LICENSE](LICENSE).
