# Changelog

Versioning is `0.MAJOR` (no patch level). Each version reflects a shippable feature epoch; intermediate fixes fold into the surrounding range. Pre-1.0 — breaking changes possible between minors until the public API stabilizes.

Tags are annotated; check them out with `git checkout v0.N` to inspect that point.

---

## v0.12 — 2026-05-02 — mid-stream lifecycle reactions

Expands Gem's reaction lifecycle beyond the basic `👀 → 🤔 → ✅` chain to surface what's actually happening inside a turn:

- **📎 ingesting** — fires before generate when there's a Discord attachment or YouTube URL in the message (youtube grouped under attachments, no separate emoji)
- **🧠 native_thinking** — first chunk with a `thought: true` part (gemini-3 thinking models)
- **🌐 searching** — first chunk with non-empty `webSearchQueries` grounding metadata
- **🔧 tooling** — start/end of each function-call dispatch (de-duped per turn)
- **✂️ truncated** — terminal state when `finishReason === MAX_TOKENS`
- **🛑 blocked** — terminal state when `finishReason === SAFETY`
- **⚠️ denied** — caught-path now uses `denied` (not `errored`) for 429 / quota / rate-limit; `❌` stays for everything else

Threaded a new `onEvent` callback through `gemini.ts` `respond()` and the underlying stream loop. Each in-flight event de-dupes per turn so a stream yielding N grounding chunks doesn't spam N reactions.

## v0.11 — 2026-05-02 — squad lifecycle reactions

Adopts the reaction lifecycle pattern used by the Claude-based squad bots so Gem's "I'm working on it" feedback matches the rest of the family.

- **👀 received** — fires the moment we commit to handling a message (after the gate passes)
- **🤔 thinking** — fires when the `💭 Thinking…` placeholder is up and the Gemini call is about to start
- **✅ replied** — fires when there's substantive content to commit
- **❌ errored** — fires in the catch block

Drops the prior single LLM-picked content react; `parsed.react` is still parsed for older personas but ignored. New module: `src/reactions/lifecycle.ts`.

## v0.10 — 2026-05-01 — @google/genai migration + context caching

The largest reliability + cost-reduction epoch.

- **@google/genai migration** — replaces the legacy `@google/generative-ai` SDK. Fixes the streaming "Failed to parse stream" bug and the silent stripping of `thoughtSignature`, which broke gemini-3 thinking models on tool-loop iteration 2.
- **Per-channel context caching (opt-in)** — stable system prefix (persona + summary + pinned facts + tools + toolConfig) cached server-side via `client.caches.create`. Cached input tokens bill at 10% of normal rate. Per-channel TTL via `/gemini cache ttl` (60–86400s, default 2h). `/gemini cache info` shows live cache state with size, age, hit count, and lifecycle. Fail-open: cache faults fall back to uncached path.
- **`/gemini clear`** + **`/gemini compact`** for manual context management.
- **`/gemini set` consolidation** — single subcommand replacing the per-flag toggle proliferation.
- **opt-in reply gate removed** — the two-tier classifier silenced too many legitimately-addressed messages; persona-level instructions handle the same job at LLM time without a pre-call API hop.
- **Silent-exit when model returns nothing** — matches the Claude bot pattern; no more empty `(Empty response)` placeholder.
- **`maxOutputTokens=4096` cap** to bound any future degenerate-generation loop blast radius.
- React-emoji fallback (👀) when the model omits the field. Outbound react validator rejects custom Discord emojis (silently drops, doesn't block reply).
- Footer marker drop, padding fixes, executableCode dedupe.

## v0.9 — 2026-04-27 — summarization + fetch_url + token-aware context

- **Persistent conversation summarization** — `conversation_summaries` SQLite table; rolling per-channel summaries injected into the system prompt. `SummarizationScheduler` runs single-flight per channel, kicks in after `MAX_UNSUMMARIZED_MESSAGES` (default 50). `fetchMessagesSince` honors the summary cutoff to avoid re-summarizing.
- **`fetch_url` tool** — fetches a URL, runs Mozilla Readability + JSDOM, returns extracted main text. Includes SSRF guard (blocks private IP ranges) and length truncation. Registered in the default tool registry.
- **Token-aware context windowing** — `selectWithinBudget` helper trims history to fit `MAX_HISTORY_TOKENS` (default 200000). `GeminiClient.countTokens` wraps the SDK call. `buildContextHistory` ties fetch + format + budget together.

## v0.8 — 2026-04-26 — reaction-driven actions

User-side reactions on Gem's messages now drive bot actions:

- **🔁 regenerate** — re-run the same prompt
- **🔍 expand** — ask Gem to expand on her previous reply with more depth
- **📌 pin** — add a fact to the channel's persistent pinned-facts file (system-prompt augmentation)
- **❌ delete** — Gem deletes her own message
- **🔇 mute** / **🔊 unmute** — per-user channel mute toggle
- **✏️ markForEdit** — Gem's next reply edits this message in place

New: `reactions/vocabulary.ts`, `reactions/handler.ts`, `reactions/actions.ts`, `reactions/pending-edits.ts`. `PinnedFactsStore` writes `~/.gemini/channels/discord/pinned-facts.md`. `AccessManager.canReact` gates the permission. `messageReactionAdd` event handler routes emoji → action.

## v0.7 — 2026-04-24 — IBKR MCP auto-registration

Auto-discovers and registers tools exposed by an Interactive Brokers MCP server, transparently bridging MCP → Gemini function-calls.

- **`@modelcontextprotocol/sdk`** dependency added.
- **`mcpSchemaToGemini`** converts MCP JSON Schema to Gemini Schema (drops unsupported keys like `additionalProperties`, normalizes type names).
- **`connectMcpClient`** wraps the streamable-HTTP transport with timeout + reconnect logic.
- **`loadIbkrTools`** with unreachable-fallback stub: if the IBKR MCP server is down, the bot still boots; the stub tool returns a "service unavailable" error instead of failing registration.
- **`buildDefaultRegistry`** is now async and auto-loads IBKR tools on startup.

## v0.6 — 2026-04-23 — ToolRegistry

Pluggable function-call tools — moves away from hard-coded tool dispatch.

- **`ToolRegistry`** with `register(name, schema, dispatch)` API.
- **`search_memory`** ported to the new interface (was previously hard-coded in respond()).
- **`ibkr_briefing`** stub as the first new registered tool.
- **`buildDefaultRegistry`** wires both into `GeminiClient` construction.
- **`runOneTurn`** dedupes the streaming and non-streaming paths so the tool loop is identical regardless of which mode the call is in.

## v0.5 — 2026-04-20 — semantic memory + RAG

- **sqlite-vss** virtual-table for vector storage of channel messages.
- **Background embedding** — every allowed user message gets embedded (`text-embedding-004`, later `gemini-embedding-001`) and stored. Independent of the reply gate so the bot learns from passive conversation.
- **`search_memory` RAG tool** — semantic recall over stored messages. The model can call it during the tool loop to fetch relevant context from prior conversations.
- Reverted, then reapplied (the initial commit had a bug; the reapply was the durable shape).

## v0.4 — 2026-04-19 — streaming + slash command flags

- **Real-time token streaming** — long replies stream into Discord via `message.edit()` as tokens arrive. Streaming preview messages get edited in place to become the final output (zero-duplicate guarantee on chunk-count changes).
- **Dynamic JSON parsing** — tolerates partial / streaming-corrupted JSON, regex-fallback when the model emits invalid JSON with literal newlines, accumulator-based parsing.
- **`/gemini`** slash command (renamed from `/admin`) with per-channel toggles for chain-of-thought, code-execution display, verbose footer.
- API metadata surfacing — usage tokens, finish reason, flagged safety categories visible in logs and (when verbose is on) inline.

## v0.3 — 2026-04-16 — multimodal + DM support

- **Video, audio, image, document support** via Gemini File API.
- Full Gemini ingest filetype list — wider mime allowlist than the initial image-only.
- **DM intents** + partial channel fetch — bot responds in DMs as well as guild channels.
- Public-readme PII scrub.

## v0.2 — 2026-04-16 — first standalone bot

The pivot away from the MCP-plugin approach. Builds the standalone-daemon shape that all subsequent versions extend.

- **Runtime: bun** (later migrated to node+tsx in v0.5 work).
- **Discord client** with Guilds + Messages + DM intents.
- **Gemini SDK** integration with structured `{ react, reply }` response format.
- **Persona loader** with shared squad context + per-channel summary placeholder.
- **History fetch + format** for Gemini context window.
- **Attachment download + mime filter + inline parts** for Gemini multimodal.
- **`AccessManager`** with explicit allowlist (no pairing protocol).
- **`chunk`** helper for splitting long replies under Discord's 2000-char limit.
- **Typing indicator** + online presence status.

## v0.1 — 2026-04-11 — initial (MCP-server experiment, abandoned)

The repo's pre-history. An attempt to wrap a Discord bot as a Gemini-CLI MCP plugin. It didn't work — Gemini CLI has no push-event ingestion pathway, so there was no way for Discord messages to reach the model unprompted. Rebuilt as a standalone daemon at v0.2. Tagged here for transparency rather than rewritten out of history.
