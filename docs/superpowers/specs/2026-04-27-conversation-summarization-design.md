# Persistent Conversation Summarization — Design

**Date:** 2026-04-27
**Status:** Approved (auto mode)

## Motivation

`buildContextHistory` fetches up to 100 raw messages and trims to a 200K-token budget. Once a channel exceeds that, older context is simply lost. For long-running channels (months of conversation), Gemma forgets prior decisions, prior thesis discussions, callbacks, jokes, anything she doesn't have a tool to look up.

The semantic memory tool (`search_memory`) covers retrieval-on-demand, but the model has to know to look. A *summary* — proactively present in every system prompt — is cheap, automatic, and gives Gemma "story so far" context with no tool call.

## Goals

1. Per-channel conversation summary stored in SQLite (`memory.db`).
2. Background summarization triggered when un-summarized message count exceeds a threshold (default 50).
3. Summary fed into the system prompt alongside (and distinct from) the existing squad-context channel summary.
4. `buildContextHistory` fetches only messages newer than the last summarized message — token budget then trims as before.
5. Single-flight: only one summarization runs per channel at a time.
6. Summarization failures don't break the reply path. Logged, retried next time.

## Non-Goals (Stashed)

- Hierarchical summary trees ("summary of summaries"). One flat summary per channel; we re-summarize old + new together each time.
- Per-user-in-channel summaries.
- User-facing `/gemini summary` slash command for view/edit/forget. Future work.
- Cross-channel knowledge transfer.
- Summarizing DMs separately from group channels — same logic applies.

## Architecture

### Storage

New SQLite table:

```sql
CREATE TABLE IF NOT EXISTS conversation_summaries (
  channel_id TEXT PRIMARY KEY,
  summary TEXT NOT NULL,
  last_summarized_message_id TEXT NOT NULL,
  updated_at DATETIME NOT NULL
)
```

`memory.db` already exists (`sqlite-vss` for embeddings). Same DB file, new table; the migration is idempotent (`CREATE TABLE IF NOT EXISTS`).

### Module layout

```
src/summarization/
  store.ts       — SummaryStore class: get(channelId), upsert(channelId, summary, lastMessageId)
  summarizer.ts  — runSummarization(channelId, oldSummary, newMessages, gemini) -> {summary, lastMessageId}
  scheduler.ts   — scheduleIfNeeded(channelId, ...) with in-flight Map deduping
src/db.ts        — schema migration adds the new table
src/history.ts   — buildContextHistory accepts optional `since` message ID
src/persona.ts   — buildSystemPrompt includes conversation summary as its own section
src/gemma.ts     — after each successful reply, call scheduler.scheduleIfNeeded(channelId)
tests/summarization/
  store.test.ts
  summarizer.test.ts
  scheduler.test.ts
```

### Interfaces

```typescript
// src/summarization/store.ts
export interface SummaryRecord {
  channelId: string
  summary: string
  lastSummarizedMessageId: string
  updatedAt: string  // ISO
}

export class SummaryStore {
  get(channelId: string): SummaryRecord | null
  upsert(channelId: string, summary: string, lastMessageId: string): void
}
```

```typescript
// src/summarization/summarizer.ts
export interface SummarizableMessage {
  authorName: string
  content: string
  timestamp: string  // ISO
  messageId: string
}

export async function runSummarization(
  oldSummary: string | null,
  newMessages: SummarizableMessage[],
  gemini: GeminiClient
): Promise<{ summary: string; lastMessageId: string }>
```

```typescript
// src/summarization/scheduler.ts
export interface SchedulerDeps {
  store: SummaryStore
  fetchSinceForSummarization: (channelId: string, since: string | null, limit: number) => Promise<SummarizableMessage[]>
  gemini: GeminiClient
  threshold: number  // default 50
}

export class SummarizationScheduler {
  constructor(deps: SchedulerDeps)
  // Non-blocking. Deduped per channel. Returns void; errors logged.
  scheduleIfNeeded(channelId: string): void
}
```

### Summarization prompt

The `runSummarization` function builds a one-shot Gemini call (no streaming, no tools) with a dedicated system prompt:

```
You are summarizing a Discord channel for context preservation. Produce a tight, factual summary that captures:
- Key decisions and conclusions
- Recurring themes or running jokes
- Important named entities (people, places, projects)
- Open questions or pending items
- The general tone of the channel

Constraints:
- Maximum ~500 words.
- Plain prose, no headers or bullets unless necessary for clarity.
- Don't editorialize. Report what was discussed.

If a previous summary is provided, incorporate it. Old facts that are still relevant stay; old facts that have been superseded by newer messages are updated. Don't double-count.

Output ONLY the summary text. No preamble, no metadata.
```

Then user content:
```
PREVIOUS SUMMARY:
<oldSummary or "(none)">

NEW MESSAGES SINCE PREVIOUS SUMMARY:
[2026-01-01T12:00:00Z] alice: hello
[2026-01-01T12:01:00Z] bob: hi
...
```

The model returns plain text. Strip whitespace, store.

We use `GeminiClient.respond()` directly with a custom system prompt and an empty tool registry effect (the model can ignore tools for this; we just won't act on any function calls). Actually simpler: `runSummarization` calls a new `gemini.completeText(systemPrompt, userText)` helper to bypass the registry/tool loop entirely.

Add `GeminiClient.completeText(systemPrompt: string, userText: string): Promise<string>` — single-turn, no streaming, no tool dispatch. Returns plain text from the response.

### Scheduler logic

```typescript
class SummarizationScheduler {
  private inFlight = new Map<string, Promise<void>>()

  scheduleIfNeeded(channelId: string): void {
    if (this.inFlight.has(channelId)) return  // already running
    const promise = this.runIfThresholdMet(channelId)
      .catch(e => console.error(`[summarization] failed for ${channelId}:`, e))
      .finally(() => this.inFlight.delete(channelId))
    this.inFlight.set(channelId, promise)
  }

  private async runIfThresholdMet(channelId: string) {
    const existing = this.deps.store.get(channelId)
    const since = existing?.lastSummarizedMessageId ?? null
    // Fetch messages since the last summary point. Bounded to a sane upper
    // limit (e.g. 500) to avoid pathological memory blow-up if a channel
    // missed many summarization windows.
    const messages = await this.deps.fetchSinceForSummarization(channelId, since, 500)
    if (messages.length < this.deps.threshold) return
    const { summary, lastMessageId } = await runSummarization(
      existing?.summary ?? null,
      messages,
      this.deps.gemini
    )
    this.deps.store.upsert(channelId, summary, lastMessageId)
    console.error(`[summarization] updated channel ${channelId}; summarized ${messages.length} new messages`)
  }
}
```

### History fetcher integration

`buildContextHistory(channel, beforeId, gemini, selfId, budget, since?)`. New optional `since` param:
- If `since` provided, after the raw fetch, drop messages with `id <= since` (Discord IDs are sortable, comparable as snowflakes).
- Then format and budget-trim as before.

In `gemma.ts` before calling `buildContextHistory`:
```typescript
const summaryRecord = summaryStore.get(message.channelId)
const since = summaryRecord?.lastSummarizedMessageId
const history = await buildContextHistory(channel, messageId, gemini, selfId, budget, since)
```

### Persona integration

`PersonaLoader` gains `setSummaryStore(store)`, then in `buildSystemPrompt(channelId)`:

```typescript
const conversationSummary = this.summaryStore?.get(channelId)?.summary ?? ''
// ... existing sections ...
if (conversationSummary) {
  sections.push(`## Conversation summary (older context)\n\n${conversationSummary}`)
}
```

Comes before pinned facts but after squad-context summary, since it's "older context" and should be considered roughly equivalent in priority to the squad summary (which is also background/older). Order: persona → squad memories → squad summary → conversation summary → pinned facts.

### Source data for summarizer

The summarizer needs raw text of messages between two points. Options:

1. **Re-fetch from Discord**: requires the channel object; risky if channel has been deleted.
2. **Pull from `memory.db`'s `messages` table** (already populated by background memory ingestion).

Going with **(2)** — the embeddings flow already inserts every allowed-channel message into `messages`. We just SELECT WHERE channel_id=? AND id > ? ORDER BY timestamp LIMIT 500.

Add new query in `db.ts`:

```typescript
export function fetchMessagesSince(channelId: string, sinceMessageId: string | null, limit: number): Array<{
  id: string, channel_id: string, author_name: string, content: string, timestamp: string
}>
```

Discord snowflake IDs are sortable as strings (lexicographic for same-length strings) and decimal-comparable as BigInts. Use `id > ?` in SQL with TEXT comparison; we just need to make sure the stored IDs are all the same length (Discord IDs are currently all 17-19 digits — same-order-of-magnitude — but to be safe we'll use a length-padded comparison: store as-is, but compare via CAST(id AS INTEGER) which SQLite handles fine for 64-bit integers).

Actually simpler: use `WHERE channel_id = ? AND CAST(id AS INTEGER) > CAST(? AS INTEGER) ORDER BY id ASC LIMIT ?`. SQLite handles 64-bit int comparison.

### Configuration

- `MAX_UNSUMMARIZED_MESSAGES` env var. Default 50.
- `SUMMARIZATION_BATCH_LIMIT` env var. Default 500. Cap for one summarization pass.

### Error paths

| Failure | Behavior |
|---|---|
| `gemini.completeText` throws | Logged, no upsert. Retry next time threshold met. |
| DB read fails in scheduler | Logged, no-op. |
| DB write fails | Logged. Next scheduling attempt refetches from `since` and retries. |
| Empty new messages despite threshold check (race) | Skip silently. |
| `fetchMessagesSince` returns empty | Skip — no work. |

The reply path never blocks on summarization. `scheduleIfNeeded` is fire-and-forget.

## Tests

`tests/summarization/store.test.ts`:
- Upsert + get round-trip.
- Get on missing channel returns null.
- Upsert overwrites prior entry.

`tests/summarization/summarizer.test.ts`:
- With mock `gemini.completeText` returning a known string, `runSummarization` returns that string + the last message id.
- Empty newMessages array still resolves (returns oldSummary unchanged + null lastMessageId? No — caller skips before invoking. We assert the function throws or returns gracefully).
- Includes both old summary and new messages in the prompt sent to `completeText` (assert via spy on the recorded prompt).

`tests/summarization/scheduler.test.ts`:
- Below threshold → no run.
- At threshold → run; store.upsert called with expected args.
- Concurrent scheduleIfNeeded calls → only one in-flight per channel.
- Different channels run independently.
- Run completes; map cleared; subsequent call can run again.

No new tests for `db.ts` query — covered indirectly via scheduler test using a real in-memory SQLite or fake store.

`tests/persona.test.ts`:
- Existing tests keep passing.
- New test: when summaryStore set and returns a summary, system prompt includes a "Conversation summary" section.

## Migration plan

1. Add `db.ts` schema migration + `fetchMessagesSince` query + tests.
2. Implement `SummaryStore` + tests.
3. Add `GeminiClient.completeText` helper + reuse in summarizer.
4. Implement `runSummarization` + tests.
5. Implement `SummarizationScheduler` + tests.
6. Wire `buildContextHistory` to accept `since`.
7. Wire `PersonaLoader.setSummaryStore` + system prompt section.
8. Wire all into `gemma.ts`: instantiate scheduler, call `scheduleIfNeeded` after reply, pass `since` to `buildContextHistory`.
9. Run full suite. Done.

## Open questions resolved

- **Why not vector summary**: a textual summary is what we'd retrieve anyway; storing structured data adds complexity for no win.
- **Why not summarize per-user**: thread-of-conversation matters more than who said what for context. Authors are still in the body.
- **Why 50 messages**: roughly a day's worth of activity in an active channel. Tune via env var.
- **Why both summary and pinned facts**: pinned facts are user-curated highlights; summary is auto-generated rolling context. Different signal.
