# Gemma — Standalone Gemini Discord Bot

**Date:** 2026-04-16
**Status:** Design approved, ready for implementation plan
**Repo:** `discord-mcp` (will be repurposed; MCP scaffolding removed)

## Summary

Rebuild `discord-mcp` as a standalone Discord bot ("Gemma") that talks directly to the Gemini API. The existing MCP-based architecture is abandoned because Gemini CLI has no push-event ingestion pathway, making an MCP-server-plus-CLI design unworkable for a reactive bot. Gemma runs as a persistent daemon on HOST (WSL) under systemd, joining the existing bot fleet (Fraggy, MacClaude, Claudsson, Claude总) but as the first native-bot implementation — the Claude bots are all `claude --channels plugin:discord` CLI sessions, while Gemma is a purpose-built daemon.

## Why This Architecture

The Claude Discord plugin works as an MCP server because Claude Code's runtime has first-class integration points: Discord messages get injected into the conversation turn via `<channel>` tags, hooks fire on events, and the SDK exposes push pathways. Gemini CLI lacks all of these. Its event loop is strictly REPL-style (user input → model → tool call → tool result → response → wait for next input), with no surface for external events to wake the model.

Three workarounds were considered and rejected:

- **External loop prompting Gemini CLI on a timer** — burns tokens continuously even when idle.
- **Stdin injection into a running Gemini session** — undocumented, fragile, fights the tool's design.
- **Fork Gemini CLI to add hooks** — unbounded maintenance burden.

Instead, Gemma is a standalone Bun process: Discord's WebSocket pushes `messageCreate` events to her directly, she calls the Gemini API when warranted, and posts replies back. No CLI involvement. This is the same architectural pattern Fraggy would use if it weren't leveraging Claude Code's runtime for free.

## Runtime & Stack

- **Language:** TypeScript
- **Runtime:** Bun (native TS, fast startup, matches Anthropic's Claude Discord plugin)
- **Discord library:** `discord.js` v14
- **Gemini SDK:** `@google/generative-ai`
- **Model:** `gemini-3.1-flash` (cheap, fast, multimodal-native)
- **Deployment:** HOST WSL (Ubuntu 24.04, `jbai` user), managed as a systemd user service
- **Auth:** Google AI Studio API key (user already has one), stored in state-dir `.env`
- **Repo:** Reuse `discord-mcp`. Gut `src/server.ts` (MCP scaffolding) and `src/monitor.ts` (file-log bridge). Keep the discord.js client bootstrap and chunking logic; rewrite everything else.

## Architecture

Single long-running Bun process. One event loop.

```
Discord Gateway (WebSocket, push)
          │
          ▼
   [discord.js Client] ── on('messageCreate')
          │
          ▼
   [Access filter] ── sender allowed? channel allowed? mention rules satisfied?
          │ pass
          │
          ├──► [Attachment handler] ── download images to inbox/; mime-sniff; build inline parts
          │
          └──► [History fetcher] ── last 20 messages from channel, text only (no historical attachments)
                     │
                     ▼  (both complete)
          [Prompt builder] ── system prompt + persona + history + user message + media parts
                     │
                     ▼
          [Gemini API] ── generateContent, structured output { react?, reply? }
                     │
                     ▼
          [Response handler] ── parallel: react(emoji) + chunk(reply).send()
                     │
                     ▼
          [Cleanup] ── delete temp files
```

Attachment download and history fetch run **in parallel** — they're independent I/O. Prompt build waits for both.

### Key properties

- **Push-driven.** Discord Gateway WebSocket delivers messages within milliseconds. No polling, no pending-file intermediates.
- **Stateless per-message.** No DB. History fetched from Discord on each turn (same pattern as Claude plugin).
- **Parallel turns.** Multiple messages arriving simultaneously run concurrently through Node's event loop.
- **One system prompt per instance.** Gemma's persona lives in a text file, loaded at startup, reloadable via SIGHUP.

## Access Control

Inherits the Claude Discord plugin's pattern. Permissions are **manual only** — Gemma never modifies her own allowlist, regardless of anything said in Discord.

### State file: `~/.gemini/channels/discord/access.json`

Example structure — real user and channel IDs come from `~/.claude/projects/-Users-jeffbai-repos/memory/reference_discord_bots.md` and will be filled in during implementation.

```json
{
  "users": {
    "<jeff_user_id>": { "allowed": true }
  },
  "channels": {
    "<cl-2_id>": { "enabled": true, "requireMention": false, "isPrimary": false },
    "<private_fam_id>": { "enabled": true, "requireMention": true, "isPrimary": false },
    "<cl-1_id>": { "enabled": true, "requireMention": true, "isPrimary": false }
  },
  "defaultChannel": { "enabled": false }
}
```

- **Default posture:** unknown channels and users are ignored. Explicit allowlist.
- **`requireMention: true`** (default for known channels) — only responds when `@Gemma` is in the message.
- **`isPrimary: true`** — the "lead bot" in that channel; observer protocol not in scope for v1 (Gemma speaks or stays silent; she doesn't wait-and-watch-others).
- **Edit flow:** human edits `access.json`, sends SIGHUP to reload without restart. A `gemma-access` helper shell script is **deferred to v1.1** — v1 uses direct JSON editing.

### Security note

No pairing flow, no Discord-triggered permission changes. This is a hard rule inherited from the Claude plugin — prompt injection must not grant access.

## Multimodal Ingestion

Gemini 3.1 Flash accepts images and video natively in the same request as text. This is the main reason to pick Gemini over text-only alternatives.

### Supported in v1

- **Images only:** PNG, JPEG, WebP, GIF — inline, up to 20 MB per file

### Deferred to v1.1

- **Video** (MP4, MOV, WebM) — requires Files API path for anything non-trivial in size
- **PDF / txt** — text extraction flow, not inline data parts

### Flow

1. Discord message arrives with attachments.
2. Gemma downloads each attachment to `~/.gemini/channels/discord/inbox/<message_id>/<filename>`.
3. Mime-sniff: accept `image/*` inline; reject other types in v1 with a polite "I can only handle images right now" reply.
4. Build request with inline data parts: `{ inlineData: { mimeType, data: base64(file) } }`.
5. After the API call completes (success or failure), delete the message's inbox dir.
6. **History pass:** when building prior-turn context, reference old attachments as `[previous image]` in text. Never re-upload historical media — cost explodes, most models cache poorly across turns anyway.

### Size rejection

Files over 20 MB are rejected with a user-facing message. Don't attempt truncation or downsampling in v1.

## Emoji Reactions

Gemma can react with an emoji to the user's message, in addition to (or instead of) replying with text.

### Implementation

- Gemini returns a **structured JSON** response: `{ "react": "🦆" | null, "reply": "text..." | null }`.
- Enforced via `@google/generative-ai`'s `responseSchema` / `responseMimeType: "application/json"`.
- Server parses, then in parallel:
  - `message.react(emoji)` if `react` is non-null
  - Chunk and send `reply` to the channel if `reply` is non-null (≤2000 chars per chunk)
- At least one of the two must be non-null; if both null, treat as "no response" and log.

### Emoji support

- **Unicode emoji:** works out of the box.
- **Custom server emoji:** Discord format `<:name:id>` or `<a:name:id>` for animated. Gemma is told about the available custom emoji (e.g. `<:green:1492450556277559326>`) in her system prompt.

## System Prompt & Persona

- Lives in `~/.gemini/channels/discord/persona.md` (editable without code changes, reloadable via SIGHUP).
- Includes: identity (Gemma, Gemini-backed bot), role in the squad, any stylistic notes, list of custom emoji IDs, list of other bots and their IDs (so Gemma knows when `@Fraggy` is being tagged, etc.).
- **Out of scope for v1:** personality/voice tuning — that's a later iteration. v1 just gets Gemma conversational.

## Error Handling

- **Discord disconnects:** discord.js auto-reconnects; log the event and continue.
- **Gemini API failure (non-429):** catch the error, post a generic "having trouble reaching Gemini right now" reply to the channel, log the full error to stderr (systemd captures).
- **Rate limit (429):** catch, reply with a rate-limit message, back off. Don't retry the same turn.
- **Unhandled rejections / uncaught exceptions:** top-level handlers log but don't exit. Match the Claude plugin's last-resort pattern.
- **Attachment download fails:** reply that the file couldn't be fetched; don't include it in the API call.

## Deployment & Ops

### State directory layout

```
~/.gemini/channels/discord/
  .env             # DISCORD_BOT_TOKEN=..., GEMINI_API_KEY=...  (chmod 600)
  access.json      # allowlist
  persona.md       # system prompt + persona
  inbox/           # per-message attachment temp dirs; cleaned after each turn
  gemma.log        # application log (systemd also captures stderr)
```

### systemd user service

```
[Unit]
Description=Gemma — Gemini Discord bot
After=network-online.target

[Service]
Type=simple
WorkingDirectory=<your-mcp-repo>
ExecStart=~/.bun/bin/bun src/gemma.ts
Restart=always
RestartSec=10
StandardOutput=append:~/.gemini/channels/discord/gemma.log
StandardError=append:~/.gemini/channels/discord/gemma.log

[Install]
WantedBy=default.target
```

Unit file lives at `~/.config/systemd/user/gemma.service`. Enable with `systemctl --user enable --now gemma`.

### Deployment flow

Matches existing HOST pattern:
1. Push from Mac to GitHub
2. SSH `<deploy-user>@<deploy-host>`, then `wsl -u jbai -e bash -c "cd <your-mcp-repo> && git pull && bun install"`
3. Restart: `wsl -u jbai -e systemctl --user restart gemma`

### Log rotation

Not in v1. Monitor file size; add logrotate or a systemd timer like `ibkr-mcp-logrotate.timer` only if `gemma.log` grows problematic.

## What's Explicitly Out of Scope (v1)

- Tool use / function calling (IBKR queries, web search, etc.) — v1.1+
- Voice / slash commands
- Video or PDF ingestion (images only)
- Message edit/delete handling (ignore edits; never delete own messages)
- `gemma-access` helper CLI (v1 uses direct JSON editing)
- Multi-instance / sharding
- Observer protocol (wait-for-primary-before-responding) — v1 is "respond or don't"
- Log rotation
- Metrics / health endpoint

## File Inventory (Planned)

Repo `discord-mcp` after rewrite:

```
src/
  gemma.ts        # main entry: discord.js client + event wiring
  access.ts       # access.json load/reload, filter logic           (rewrite existing)
  attachments.ts  # download, mime-sniff, inline-part builder, cleanup   (new)
  gemini.ts       # Gemini API client, prompt builder, structured parser (new)
  history.ts      # channel history fetcher                              (new)
  chunk.ts        # 2000-char splitter                                   (reuse existing)
  persona.ts      # persona.md loader + SIGHUP reload                    (new)
package.json      # deps: discord.js, @google/generative-ai, dotenv
tsconfig.json
README.md         # updated — no more MCP talk
```

Deleted:
- `src/server.ts` (MCP scaffolding)
- `src/monitor.ts` (pending.jsonl bridge)
- `fetch_dms.ts`, `talk.ts`, `test_bot.ts`, `test_bot2.ts` — leftover experiment files
- `server_debug.log`, `server.log`, `test_bot.log`, `test_bot2.log` — stale logs

## Open Questions for Implementation Plan

None at this stage. All major decisions resolved in this design.

## Next Step

Invoke `superpowers:writing-plans` to produce a step-by-step implementation plan from this spec.
