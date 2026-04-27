# Conversation Summarization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`).

**Goal:** Persistent per-channel conversation summary, auto-updated when un-summarized message count exceeds threshold (default 50). Summary feeds into system prompt; history-fetcher skips already-summarized messages.

**Spec:** `docs/superpowers/specs/2026-04-27-conversation-summarization-design.md`

---

## Files

**New:**
- `src/summarization/store.ts`
- `src/summarization/summarizer.ts`
- `src/summarization/scheduler.ts`
- `tests/summarization/store.test.ts`
- `tests/summarization/summarizer.test.ts`
- `tests/summarization/scheduler.test.ts`

**Modified:**
- `src/db.ts` — add table + `fetchMessagesSince` query.
- `src/gemini.ts` — add `completeText` method.
- `src/history.ts` — accept optional `since`.
- `src/persona.ts` — accept summary store, inject section.
- `src/gemma.ts` — wire it.

---

## Task 1: db.ts schema + fetchMessagesSince

Add table after the existing schema block in `src/db.ts`:

```typescript
db.exec(`
  CREATE TABLE IF NOT EXISTS conversation_summaries (
    channel_id TEXT PRIMARY KEY,
    summary TEXT NOT NULL,
    last_summarized_message_id TEXT NOT NULL,
    updated_at DATETIME NOT NULL
  )
`)
```

Add prepared statements + exports:

```typescript
const fetchMessagesSinceStmt = db.prepare(`
  SELECT id, channel_id, author_name, content, timestamp
  FROM messages
  WHERE channel_id = ?
    AND (? IS NULL OR CAST(id AS INTEGER) > CAST(? AS INTEGER))
  ORDER BY CAST(id AS INTEGER) ASC
  LIMIT ?
`)

export interface MessageRow {
  id: string
  channel_id: string
  author_name: string
  content: string
  timestamp: string
}

export function fetchMessagesSince(channelId: string, sinceMessageId: string | null, limit: number): MessageRow[] {
  return fetchMessagesSinceStmt.all(channelId, sinceMessageId, sinceMessageId, limit) as MessageRow[]
}

const upsertSummaryStmt = db.prepare(`
  INSERT INTO conversation_summaries (channel_id, summary, last_summarized_message_id, updated_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(channel_id) DO UPDATE SET
    summary = excluded.summary,
    last_summarized_message_id = excluded.last_summarized_message_id,
    updated_at = excluded.updated_at
`)

const getSummaryStmt = db.prepare(`
  SELECT channel_id, summary, last_summarized_message_id, updated_at
  FROM conversation_summaries WHERE channel_id = ?
`)

export interface SummaryRow {
  channel_id: string
  summary: string
  last_summarized_message_id: string
  updated_at: string
}

export function upsertSummary(channelId: string, summary: string, lastMessageId: string): void {
  upsertSummaryStmt.run(channelId, summary, lastMessageId, new Date().toISOString())
}

export function getSummary(channelId: string): SummaryRow | null {
  return (getSummaryStmt.get(channelId) as SummaryRow | undefined) ?? null
}
```

Run: `npm run test`. Commit:
- `git add src/db.ts`
- `git commit -m "feat: conversation_summaries table + queries"`

---

## Task 2: SummaryStore

Create `tests/summarization/store.test.ts`:

```typescript
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { SummaryStore } from '../../src/summarization/store.ts'

class FakeDb {
  data = new Map<string, any>()
  upsert = (id: string, summary: string, lastId: string) => {
    this.data.set(id, { channel_id: id, summary, last_summarized_message_id: lastId, updated_at: new Date().toISOString() })
  }
  get = (id: string) => this.data.get(id) ?? null
}

describe('SummaryStore', () => {
  test('get returns null when channel absent', () => {
    const fake = new FakeDb()
    const s = new SummaryStore({ getSummary: fake.get, upsertSummary: fake.upsert })
    assert.equal(s.get('nope'), null)
  })

  test('upsert + get round-trip', () => {
    const fake = new FakeDb()
    const s = new SummaryStore({ getSummary: fake.get, upsertSummary: fake.upsert })
    s.upsert('C1', 'a summary', 'M99')
    const got = s.get('C1')!
    assert.equal(got.channelId, 'C1')
    assert.equal(got.summary, 'a summary')
    assert.equal(got.lastSummarizedMessageId, 'M99')
    assert.ok(got.updatedAt)
  })

  test('upsert overwrites', () => {
    const fake = new FakeDb()
    const s = new SummaryStore({ getSummary: fake.get, upsertSummary: fake.upsert })
    s.upsert('C1', 'first', 'M1')
    s.upsert('C1', 'second', 'M2')
    assert.equal(s.get('C1')!.summary, 'second')
  })
})
```

Create `src/summarization/store.ts`:

```typescript
import { getSummary as defaultGet, upsertSummary as defaultUpsert, type SummaryRow } from '../db.ts'

export interface SummaryRecord {
  channelId: string
  summary: string
  lastSummarizedMessageId: string
  updatedAt: string
}

export interface SummaryDeps {
  getSummary: (channelId: string) => SummaryRow | null
  upsertSummary: (channelId: string, summary: string, lastMessageId: string) => void
}

export class SummaryStore {
  private deps: SummaryDeps
  constructor(deps: SummaryDeps = { getSummary: defaultGet, upsertSummary: defaultUpsert }) {
    this.deps = deps
  }

  get(channelId: string): SummaryRecord | null {
    const row = this.deps.getSummary(channelId)
    if (!row) return null
    return {
      channelId: row.channel_id,
      summary: row.summary,
      lastSummarizedMessageId: row.last_summarized_message_id,
      updatedAt: row.updated_at
    }
  }

  upsert(channelId: string, summary: string, lastMessageId: string): void {
    this.deps.upsertSummary(channelId, summary, lastMessageId)
  }
}
```

Run + commit `feat: SummaryStore wraps conversation_summaries DB queries`.

---

## Task 3: GeminiClient.completeText

Add to `GeminiClient` class (after `countTokens`):

```typescript
async completeText(systemPrompt: string, userText: string): Promise<string> {
  const result = await this.model.generateContent({
    systemInstruction: { role: 'system', parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: userText }] }]
  })
  const candidate = result.response.candidates?.[0]
  const parts = (candidate?.content?.parts ?? []) as any[]
  return parts
    .filter(p => typeof p.text === 'string' && !p.executableCode && !p.codeExecutionResult && !p.functionCall)
    .map(p => p.text as string)
    .join('\n')
    .trim()
}
```

Run + commit `feat: GeminiClient.completeText for single-turn no-tools generation`.

---

## Task 4: Summarizer

Create `tests/summarization/summarizer.test.ts`:

```typescript
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { runSummarization } from '../../src/summarization/summarizer.ts'

describe('runSummarization', () => {
  test('returns model output trimmed and lastMessageId of newest message', async () => {
    let capturedSystem = ''
    let capturedUser = ''
    const gemini = {
      completeText: async (sys: string, user: string) => {
        capturedSystem = sys
        capturedUser = user
        return '  the new summary text  '
      }
    }
    const out = await runSummarization(null, [
      { authorName: 'a', content: 'hi', timestamp: '2026-01-01T00:00:00Z', messageId: 'M1' },
      { authorName: 'b', content: 'yo', timestamp: '2026-01-01T00:01:00Z', messageId: 'M2' }
    ], gemini as any)
    assert.equal(out.summary, 'the new summary text')
    assert.equal(out.lastMessageId, 'M2')
    assert.match(capturedSystem, /summarizing a Discord channel/)
    assert.match(capturedUser, /M1|hi/)
  })

  test('includes prior summary in user payload when present', async () => {
    let capturedUser = ''
    const gemini = {
      completeText: async (_sys: string, user: string) => { capturedUser = user; return 'updated' }
    }
    await runSummarization('OLD STORY', [
      { authorName: 'a', content: 'new', timestamp: '2026-01-02T00:00:00Z', messageId: 'M3' }
    ], gemini as any)
    assert.match(capturedUser, /PREVIOUS SUMMARY/)
    assert.match(capturedUser, /OLD STORY/)
    assert.match(capturedUser, /NEW MESSAGES/)
  })

  test('throws when newMessages is empty', async () => {
    const gemini = { completeText: async () => 'x' }
    await assert.rejects(() => runSummarization(null, [], gemini as any), /empty/)
  })
})
```

Create `src/summarization/summarizer.ts`:

```typescript
import type { GeminiClient } from '../gemini.ts'

export interface SummarizableMessage {
  authorName: string
  content: string
  timestamp: string
  messageId: string
}

const SYSTEM_PROMPT = `You are summarizing a Discord channel for context preservation. Produce a tight, factual summary that captures:
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

Output ONLY the summary text. No preamble, no metadata.`

export async function runSummarization(
  oldSummary: string | null,
  newMessages: SummarizableMessage[],
  gemini: Pick<GeminiClient, 'completeText'>
): Promise<{ summary: string; lastMessageId: string }> {
  if (newMessages.length === 0) throw new Error('runSummarization called with empty newMessages')

  const formattedMessages = newMessages
    .map(m => `[${m.timestamp}] ${m.authorName}: ${m.content}`)
    .join('\n')

  const userText = `PREVIOUS SUMMARY:\n${oldSummary ?? '(none)'}\n\nNEW MESSAGES SINCE PREVIOUS SUMMARY:\n${formattedMessages}`

  const summary = (await gemini.completeText(SYSTEM_PROMPT, userText)).trim()
  const lastMessageId = newMessages[newMessages.length - 1].messageId
  return { summary, lastMessageId }
}
```

Run + commit `feat: runSummarization composes prompt + calls completeText`.

---

## Task 5: Scheduler

Create `tests/summarization/scheduler.test.ts`:

```typescript
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { SummarizationScheduler } from '../../src/summarization/scheduler.ts'

class FakeStore {
  data = new Map<string, any>()
  get(channelId: string) { return this.data.get(channelId) ?? null }
  upsert(channelId: string, summary: string, lastId: string) {
    this.data.set(channelId, { channelId, summary, lastSummarizedMessageId: lastId, updatedAt: new Date().toISOString() })
  }
}

function gemini(returns: string) {
  return { completeText: async () => returns } as any
}

function makeMessages(ids: string[]) {
  return ids.map(id => ({ authorName: 'u', content: 'c', timestamp: '2026-01-01T00:00:00Z', messageId: id }))
}

async function settle(s: SummarizationScheduler, channelId: string) {
  await (s as any).inFlight.get(channelId)
}

describe('SummarizationScheduler', () => {
  test('below threshold does not upsert', async () => {
    const store = new FakeStore()
    let called = false
    const s = new SummarizationScheduler({
      store: store as any,
      fetchSinceForSummarization: async () => { called = true; return makeMessages(['M1']) },
      gemini: gemini('x'),
      threshold: 50
    })
    s.scheduleIfNeeded('C1')
    await settle(s, 'C1')
    assert.equal(called, true)
    assert.equal(store.get('C1'), null)
  })

  test('at threshold upserts', async () => {
    const store = new FakeStore()
    const s = new SummarizationScheduler({
      store: store as any,
      fetchSinceForSummarization: async () => makeMessages(Array.from({ length: 50 }, (_, i) => `M${i + 1}`)),
      gemini: gemini('summary text'),
      threshold: 50
    })
    s.scheduleIfNeeded('C1')
    await settle(s, 'C1')
    const got = store.get('C1')
    assert.equal(got.summary, 'summary text')
    assert.equal(got.lastSummarizedMessageId, 'M50')
  })

  test('concurrent calls dedupe per channel', async () => {
    let runs = 0
    const store = new FakeStore()
    let resolveFetch: ((v: any) => void) | null = null
    const fetchPromise = new Promise<any[]>(r => { resolveFetch = r })
    const s = new SummarizationScheduler({
      store: store as any,
      fetchSinceForSummarization: async () => { runs++; return fetchPromise },
      gemini: gemini('x'),
      threshold: 1
    })
    s.scheduleIfNeeded('C1')
    s.scheduleIfNeeded('C1')
    s.scheduleIfNeeded('C1')
    resolveFetch!(makeMessages(['M1']))
    await settle(s, 'C1')
    assert.equal(runs, 1)
  })

  test('different channels run independently', async () => {
    const store = new FakeStore()
    let calls: string[] = []
    const s = new SummarizationScheduler({
      store: store as any,
      fetchSinceForSummarization: async (cid) => { calls.push(cid); return makeMessages(['M1']) },
      gemini: gemini('x'),
      threshold: 1
    })
    s.scheduleIfNeeded('C1')
    s.scheduleIfNeeded('C2')
    await settle(s, 'C1')
    await settle(s, 'C2')
    assert.deepEqual(calls.sort(), ['C1', 'C2'])
  })

  test('after run completes, can run again', async () => {
    const store = new FakeStore()
    let runs = 0
    const s = new SummarizationScheduler({
      store: store as any,
      fetchSinceForSummarization: async () => { runs++; return makeMessages(['M1']) },
      gemini: gemini('x'),
      threshold: 1
    })
    s.scheduleIfNeeded('C1')
    await settle(s, 'C1')
    s.scheduleIfNeeded('C1')
    await settle(s, 'C1')
    assert.equal(runs, 2)
  })
})
```

Create `src/summarization/scheduler.ts`:

```typescript
import type { GeminiClient } from '../gemini.ts'
import type { SummaryStore } from './store.ts'
import { runSummarization, type SummarizableMessage } from './summarizer.ts'

export interface SchedulerDeps {
  store: SummaryStore
  fetchSinceForSummarization: (channelId: string, since: string | null, limit: number) => Promise<SummarizableMessage[]>
  gemini: Pick<GeminiClient, 'completeText'>
  threshold: number
  batchLimit?: number
}

export class SummarizationScheduler {
  private inFlight = new Map<string, Promise<void>>()
  constructor(private deps: SchedulerDeps) {}

  scheduleIfNeeded(channelId: string): void {
    if (this.inFlight.has(channelId)) return
    const p = this.runIfThresholdMet(channelId)
      .catch(e => console.error(`[summarization] failed for ${channelId}:`, e))
      .finally(() => this.inFlight.delete(channelId))
    this.inFlight.set(channelId, p)
  }

  private async runIfThresholdMet(channelId: string): Promise<void> {
    const existing = this.deps.store.get(channelId)
    const since = existing?.lastSummarizedMessageId ?? null
    const limit = this.deps.batchLimit ?? 500
    const messages = await this.deps.fetchSinceForSummarization(channelId, since, limit)
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

Run + commit `feat: SummarizationScheduler with single-flight per channel`.

---

## Task 6: history.ts accepts `since` filter

Add `id` to `HistoryMessage`:

```typescript
export interface HistoryMessage {
  id: string
  authorId: string
  authorName: string
  content: string
  attachments: HistoryAttachment[]
}
```

In `fetchHistory`, populate `id: m.id`.

Update `buildContextHistory`:

```typescript
export async function buildContextHistory(
  channel: TextChannel | DMChannel | ThreadChannel,
  beforeMessageId: string,
  gemini: GeminiClient,
  selfId: string,
  budget: number,
  since?: string | null
): Promise<GeminiContent[]> {
  const raw = await fetchHistory(channel, beforeMessageId)
  const filtered = since
    ? raw.filter(m => BigInt(m.id) > BigInt(since))
    : raw
  const formatted = formatHistory(filtered, selfId)
  if (budget <= 0) {
    return formatted.length > 20 ? formatted.slice(-20) : formatted
  }
  return selectWithinBudget(formatted, c => gemini.countTokens(c as any), { budget })
}
```

Update existing tests in `tests/history.test.ts` if any construct `HistoryMessage` literals — they need an `id` field now.

Run + commit `feat: buildContextHistory filters by since; HistoryMessage gains id`.

---

## Task 7: persona.ts injects summary

Add field + setter:

```typescript
import type { SummaryStore } from './summarization/store.ts'

private summaryStore: SummaryStore | null = null
setSummaryStore(store: SummaryStore): void { this.summaryStore = store }
```

Update `buildSystemPrompt`:

```typescript
buildSystemPrompt(channelId: string): string {
  const summary = this.readChannelSummary(channelId)
  const conversationSummary = this.summaryStore?.get(channelId)?.summary ?? ''
  const pinned = this.pinnedFacts?.readForChannelSync(channelId) ?? ''

  const sections: string[] = [this.persona]
  if (this.memories) sections.push(`## Shared squad memories\n\n${this.memories}`)
  if (summary) sections.push(`## Current channel summary\n\n${summary}`)
  if (conversationSummary) sections.push(`## Conversation summary (older context)\n\n${conversationSummary}`)
  if (pinned) sections.push(`## Pinned facts for this channel\n\n${pinned}`)
  return sections.join('\n\n---\n\n')
}
```

Run + commit `feat: persona injects conversation summary into system prompt`.

---

## Task 8: gemma.ts wiring

Imports:

```typescript
import { SummaryStore } from './summarization/store.ts'
import { SummarizationScheduler } from './summarization/scheduler.ts'
import { fetchMessagesSince } from './db.ts'
```

Instantiate near other singletons (after pinnedFacts):

```typescript
const summaryStore = new SummaryStore()
persona.setSummaryStore(summaryStore)
const SUMMARIZATION_THRESHOLD = parseInt(process.env.MAX_UNSUMMARIZED_MESSAGES ?? '50', 10)
const SUMMARIZATION_BATCH_LIMIT = parseInt(process.env.SUMMARIZATION_BATCH_LIMIT ?? '500', 10)
const summarizer = new SummarizationScheduler({
  store: summaryStore,
  fetchSinceForSummarization: async (channelId, since, limit) => {
    const rows = fetchMessagesSince(channelId, since, limit)
    return rows.map(r => ({
      authorName: r.author_name,
      content: r.content,
      timestamp: r.timestamp,
      messageId: r.id
    }))
  },
  gemini,
  threshold: SUMMARIZATION_THRESHOLD,
  batchLimit: SUMMARIZATION_BATCH_LIMIT
})
```

Inside `handleUserMessage`, before `buildContextHistory`:

```typescript
const summaryRecord = summaryStore.get(message.channelId)
const sinceMessageId = summaryRecord?.lastSummarizedMessageId ?? null
```

Update the call:

```typescript
buildContextHistory(message.channel as any, message.id, gemini, client.user!.id, MAX_HISTORY_TOKENS, sinceMessageId),
```

After successful reply (after the cleanup line), add:

```typescript
summarizer.scheduleIfNeeded(message.channelId)
```

Run + commit `feat: wire SummarizationScheduler in gemma.ts; pass since filter to history`.

---

## Task 9: Final verification

Run `npm run test`. Smoke-load gemma.ts via dynamic import. All green = done.

---

## Out of Scope
Hierarchical summaries, per-user summaries, slash command for view/edit, cross-channel transfer.
