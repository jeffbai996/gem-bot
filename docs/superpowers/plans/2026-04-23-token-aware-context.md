# Token-Aware Context Windowing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat 20-message history cap with a token-budget walk that uses Gemini's `countTokens()` API.

**Architecture:** A new `selectWithinBudget()` helper trims the oldest messages one at a time until the total token count falls under a configurable budget, with a minimum-retain floor. `GeminiClient.countTokens()` wraps the SDK call. `history.ts` gains a `buildContextHistory()` function that fetches more raw messages (100) and pipes them through `formatHistory()` and `selectWithinBudget()`. `gemma.ts` reads `MAX_HISTORY_TOKENS` from env and passes it in.

**Tech Stack:** TypeScript, Node.js via tsx, `@google/generative-ai` SDK, `node:test`.

**Spec:** `docs/superpowers/specs/2026-04-23-token-aware-context-design.md`

---

## File Structure

**New:**
- `src/token-budget.ts` — `selectWithinBudget()` + types.
- `tests/token-budget.test.ts` — unit tests.

**Modified:**
- `src/gemini.ts` — add `countTokens()` method.
- `src/history.ts` — add `buildContextHistory()`; bump raw limit 20 → 100.
- `src/gemma.ts` — use `buildContextHistory`, read `MAX_HISTORY_TOKENS`.

---

## Task 1: token-budget module

**Files:**
- Create: `src/token-budget.ts`
- Test: `tests/token-budget.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/token-budget.test.ts`:

```typescript
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { selectWithinBudget } from '../src/token-budget.ts'
import type { GeminiContent } from '../src/history.ts'

function msg(text: string): GeminiContent {
  return { role: 'user', parts: [{ text }] }
}

describe('selectWithinBudget', () => {
  test('empty array returns empty array', async () => {
    const out = await selectWithinBudget([], async () => 0, { budget: 1000 })
    assert.deepEqual(out, [])
  })

  test('contents at or below minRetain short-circuits without counting', async () => {
    let calls = 0
    const contents = [msg('a'), msg('b'), msg('c')]
    const out = await selectWithinBudget(contents, async () => { calls++; return 999999 }, { budget: 1, minRetain: 3 })
    assert.deepEqual(out, contents)
    assert.equal(calls, 0)
  })

  test('under budget passes through unchanged', async () => {
    const contents = [msg('a'), msg('b'), msg('c'), msg('d'), msg('e')]
    const out = await selectWithinBudget(contents, async () => 100, { budget: 1000 })
    assert.equal(out.length, 5)
  })

  test('trims oldest when over budget', async () => {
    const contents = [msg('a'), msg('b'), msg('c'), msg('d'), msg('e')]
    // 1st call (full): 1500 over. 2nd call (4 msgs): 800 under. -> returns [b,c,d,e]
    const scripted = [1500, 800]
    let i = 0
    const out = await selectWithinBudget(contents, async () => scripted[i++], { budget: 1000 })
    assert.equal(out.length, 4)
    assert.equal((out[0].parts[0] as any).text, 'b')
  })

  test('trims multiple messages', async () => {
    const contents = [msg('a'), msg('b'), msg('c'), msg('d'), msg('e')]
    const scripted = [3000, 2500, 2000, 800]
    let i = 0
    const out = await selectWithinBudget(contents, async () => scripted[i++], { budget: 1000 })
    assert.equal(out.length, 2)
    assert.equal((out[0].parts[0] as any).text, 'd')
    assert.equal((out[1].parts[0] as any).text, 'e')
  })

  test('respects minRetain floor even if still over budget', async () => {
    const contents = [msg('a'), msg('b'), msg('c'), msg('d'), msg('e')]
    // Every trim is still over budget; floor is 3. -> returns last 3.
    const out = await selectWithinBudget(contents, async () => 99999, { budget: 1, minRetain: 3 })
    assert.equal(out.length, 3)
    assert.equal((out[0].parts[0] as any).text, 'c')
  })

  test('defaults minRetain to 3 when omitted', async () => {
    const contents = [msg('a'), msg('b'), msg('c'), msg('d'), msg('e')]
    const out = await selectWithinBudget(contents, async () => 99999, { budget: 1 })
    assert.equal(out.length, 3)
  })

  test('falls back to last 20 on countTokens throw', async () => {
    const contents: GeminiContent[] = []
    for (let i = 0; i < 30; i++) contents.push(msg(`m${i}`))
    const out = await selectWithinBudget(contents, async () => { throw new Error('api down') }, { budget: 1000 })
    assert.equal(out.length, 20)
    assert.equal((out[0].parts[0] as any).text, 'm10')
    assert.equal((out[19].parts[0] as any).text, 'm29')
  })

  test('fallback returns full contents if shorter than 20', async () => {
    const contents = [msg('a'), msg('b')]
    const out = await selectWithinBudget(contents, async () => { throw new Error('x') }, { budget: 1000 })
    assert.deepEqual(out, contents)
  })
})
```

- [ ] **Step 2: Run tests — expect failure (module missing)**

Run: `npm run test -- 'tests/token-budget.test.ts'`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the module**

Create `src/token-budget.ts`:

```typescript
import type { GeminiContent } from './history.ts'

export type CountTokens = (contents: GeminiContent[]) => Promise<number>

export interface BudgetOptions {
  budget: number
  minRetain?: number
}

export async function selectWithinBudget(
  contents: GeminiContent[],
  countTokens: CountTokens,
  opts: BudgetOptions
): Promise<GeminiContent[]> {
  const { budget } = opts
  const minRetain = opts.minRetain ?? 3

  if (contents.length === 0) return contents
  if (contents.length <= minRetain) return contents

  try {
    let current = contents
    let tokens = await countTokens(current)
    if (tokens <= budget) return current

    // Trim oldest until under budget or at floor.
    while (current.length > minRetain) {
      current = current.slice(1)
      tokens = await countTokens(current)
      if (tokens <= budget) return current
    }
    return current
  } catch (e) {
    console.error('[token-budget] countTokens failed, falling back to last 20 messages:', e)
    return contents.length > 20 ? contents.slice(-20) : contents
  }
}
```

- [ ] **Step 4: Run tests — expect all pass**

Run: `npm run test -- 'tests/token-budget.test.ts'`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/token-budget.ts tests/token-budget.test.ts
git commit -m "feat: selectWithinBudget helper for token-aware history trimming"
```

---

## Task 2: GeminiClient.countTokens

**Files:**
- Modify: `src/gemini.ts`

- [ ] **Step 1: Add the method**

In `src/gemini.ts`, inside the `GeminiClient` class, immediately after `embed()`:

```typescript
async countTokens(contents: Content[]): Promise<number> {
  const result = await this.model.countTokens({ contents })
  return result.totalTokens
}
```

`Content` is already imported at the top of the file (via `@google/generative-ai`). `GeminiContent` (from history.ts) is structurally compatible with `Content`.

- [ ] **Step 2: Verify tests still pass**

Run: `npm run test`
Expected: all 112 tests pass (103 existing + 9 new from Task 1).

- [ ] **Step 3: Commit**

```bash
git add src/gemini.ts
git commit -m "feat: GeminiClient.countTokens wraps SDK countTokens call"
```

---

## Task 3: buildContextHistory in history.ts

**Files:**
- Modify: `src/history.ts`

- [ ] **Step 1: Update the raw fetch limit and add buildContextHistory**

In `src/history.ts`, replace:

```typescript
const HISTORY_LIMIT = 20
```

with:

```typescript
// Upper bound for the raw Discord fetch. Actual history length is then
// trimmed by token budget in buildContextHistory(). Discord caps fetch at 100
// messages per call, so don't exceed that without pagination.
const HISTORY_RAW_LIMIT = 100
```

Update the `fetchHistory` function body to use the renamed constant:

```typescript
  const fetched = await channel.messages.fetch({ limit: HISTORY_RAW_LIMIT, before: beforeMessageId })
```

Add imports at the top of `src/history.ts`:

```typescript
import { selectWithinBudget } from './token-budget.ts'
import type { GeminiClient } from './gemini.ts'
```

Append to `src/history.ts`:

```typescript
// Fetch + format + token-budget trim, in one call. Use this from gemma.ts;
// the individual pieces remain exported for testing and future reuse.
export async function buildContextHistory(
  channel: TextChannel | DMChannel | ThreadChannel,
  beforeMessageId: string,
  gemini: GeminiClient,
  selfId: string,
  budget: number
): Promise<GeminiContent[]> {
  const raw = await fetchHistory(channel, beforeMessageId)
  const formatted = formatHistory(raw, selfId)
  if (budget <= 0) {
    // Safety valve: budget disabled, fall back to last 20 messages.
    return formatted.length > 20 ? formatted.slice(-20) : formatted
  }
  return selectWithinBudget(formatted, c => gemini.countTokens(c as any), { budget })
}
```

- [ ] **Step 2: Run tests**

Run: `npm run test`
Expected: all tests pass (history.test.ts still passes — it tests `formatHistory` directly).

- [ ] **Step 3: Commit**

```bash
git add src/history.ts
git commit -m "feat: buildContextHistory ties fetch + format + token budget"
```

---

## Task 4: Wire into gemma.ts

**Files:**
- Modify: `src/gemma.ts`

- [ ] **Step 1: Update imports and add env var read**

In `src/gemma.ts`, change:

```typescript
import { fetchHistory, formatHistory } from './history.ts'
```

to:

```typescript
import { buildContextHistory } from './history.ts'
```

After the other `const` declarations at the top (near `MODEL_NAME`), add:

```typescript
const MAX_HISTORY_TOKENS = parseInt(process.env.MAX_HISTORY_TOKENS ?? '200000', 10)
```

- [ ] **Step 2: Replace the fetchHistory call**

Find the Promise.all block (around line 140) — replace the history line:

```typescript
      fetchHistory(message.channel as any, message.id).then(msgs => formatHistory(msgs, client.user!.id)),
```

with:

```typescript
      buildContextHistory(message.channel as any, message.id, gemini, client.user!.id, MAX_HISTORY_TOKENS),
```

- [ ] **Step 3: Run tests**

Run: `npm run test`
Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/gemma.ts
git commit -m "feat: gemma uses MAX_HISTORY_TOKENS for context budgeting"
```

---

## Task 5: Final verification

- [ ] **Step 1: Full test suite**

Run: `npm run test`
Expected: all tests pass (112 total: 103 existing + 9 new).

- [ ] **Step 2: Verify line counts**

Run: `wc -l src/token-budget.ts src/history.ts src/gemini.ts src/gemma.ts`
Expected: `token-budget.ts` ~40 lines, `history.ts` grew by ~20 lines, others roughly unchanged.

- [ ] **Step 3: Confirm no leftover HISTORY_LIMIT**

Run: grep for `HISTORY_LIMIT` via Grep tool across `src/`.
Expected: no matches (renamed to `HISTORY_RAW_LIMIT`).

- [ ] **Step 4: Done** — no final commit needed.

---

## Out of Scope

- Per-message token caching in SQLite.
- Reply-token headroom accounting.
- Separate system-prompt / shared-memory budgets.
- Pagination past 100 raw messages.
