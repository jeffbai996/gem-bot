# Token-Aware Context Windowing — Design

**Date:** 2026-04-23
**Status:** Approved (auto mode), ready for implementation plan

## Motivation

`src/history.ts:22` caps conversation history at 20 messages (`HISTORY_LIMIT = 20`). This is a flat count regardless of content. Two failure modes:

- **Wasted context in chatty channels** — 20 short one-liners might total 500 tokens. Flash's 1M window is mostly empty; Gemma forgets things from 10 messages ago for no reason.
- **Overflow in long-form channels** — one 5000-word paste plus 19 other messages blows through the model's effective window. The API may reject, truncate, or drop the system prompt.

Media-heavy channels make this worse: cached `fileUri` parts (re-injected by `history.ts:63-69`) aren't counted at all.

A token budget replaces the count cap and lets Gemma use the window proportionally.

## Goals

1. Replace the flat 20-message cap with a token budget.
2. Raise the raw Discord fetch to 100 messages so small-token channels can see further back.
3. Always keep at least the 3 most recent messages, even if the budget is absurdly small, so the bot doesn't fall off a cliff on misconfiguration.
4. Use Gemini's `countTokens()` API — accurate, no client-side heuristics.
5. Gracefully fall back to the old 20-message cap if `countTokens` throws.
6. Tests: mocked `countTokens` covers the trim cases.

## Non-Goals (Stashed)

- Per-message token caching keyed by message ID (speeds repeated turns on the same channel — follow-up).
- Reply-token headroom accounting (subtracting expected response size from budget).
- Separate budgets for system prompt vs history vs tool outputs.
- Raising `HISTORY_LIMIT` beyond 100 (`channel.messages.fetch` supports up to 100 per call; further would need pagination).

## Architecture

### Module layout

```
src/
  history.ts             — raw fetch bumped 20 → 100 msgs; new buildContextHistory()
  token-budget.ts        — selectWithinBudget() helper, takes a countTokens fn
  gemini.ts              — expose countTokens as GeminiClient.countTokens(contents)
  gemma.ts               — call buildContextHistory instead of fetchHistory+formatHistory
tests/
  token-budget.test.ts   — new, unit tests with fake countTokens
```

### Flow

```
buildContextHistory(channel, beforeId, gemini, budget)
  ├── fetchHistory(channel, beforeId, limit=100)   // raw, chronological
  ├── formatHistory(messages, selfId)              // -> GeminiContent[]
  └── selectWithinBudget(contents, gemini.countTokens, budget)  // -> trimmed
      returns GeminiContent[]
```

`gemma.ts` replaces the inline `fetchHistory(...).then(formatHistory)` with one call to `buildContextHistory`. The Promise.all parallelism is preserved.

### Interfaces

```typescript
// src/token-budget.ts
export type CountTokens = (contents: GeminiContent[]) => Promise<number>

export interface BudgetOptions {
  budget: number       // max tokens
  minRetain?: number   // floor; always keep at least this many most-recent messages. default 3
}

export async function selectWithinBudget(
  contents: GeminiContent[],
  countTokens: CountTokens,
  opts: BudgetOptions
): Promise<GeminiContent[]>
```

```typescript
// src/gemini.ts — new method on GeminiClient
async countTokens(contents: GeminiContent[]): Promise<number>
// Wraps this.model.countTokens({ contents }) and returns totalTokens
```

```typescript
// src/history.ts — new exported function
export async function buildContextHistory(
  channel: TextChannel | DMChannel | ThreadChannel,
  beforeMessageId: string,
  gemini: GeminiClient,
  selfId: string,
  budget: number
): Promise<GeminiContent[]>
```

`fetchHistory` stays exported (used by other call sites if any — check with grep; if none, the API is internal-only). `formatHistory` also stays exported for testability.

### Algorithm

```typescript
async function selectWithinBudget(contents, countTokens, { budget, minRetain = 3 }) {
  if (contents.length <= minRetain) return contents
  try {
    let current = contents
    let tokens = await countTokens(current)
    if (tokens <= budget) return current
    // Trim from oldest end until under budget or at minRetain floor
    while (current.length > minRetain) {
      current = current.slice(1)
      tokens = await countTokens(current)
      if (tokens <= budget) return current
    }
    return current  // minRetain floor — may still exceed budget; that's acceptable
  } catch (e) {
    console.error('[token-budget] countTokens failed, falling back to last 20 messages:', e)
    return contents.slice(-20)
  }
}
```

**Why one-by-one instead of binary search:** typical overflow trims only the first 1-3 messages. Binary search saves calls only when trimming many; the simple loop is fine and reads cleanly.

### Configuration

- `MAX_HISTORY_TOKENS` env var in `~/.gemini/channels/discord/.env`.
- Default: **200000** (well under Flash's 1M window, leaves room for system prompt, media, tool outputs, reply).
- Value `0` disables the budget and falls back to count-based (last 20). Safety valve for debugging.

`gemma.ts` reads the env var at boot and passes `budget` into `buildContextHistory`.

### Raw fetch limit

`history.ts`: change `HISTORY_LIMIT = 20` → `HISTORY_RAW_LIMIT = 100`. Comment explains: upper bound for budget-driven trimming; Discord fetch API caps at 100 per call.

## Error handling

| Failure | Behavior |
|---|---|
| `countTokens` throws | Log error, return last 20 messages (old behavior) |
| `MAX_HISTORY_TOKENS=0` | Skip budget logic, return last 20 |
| `MAX_HISTORY_TOKENS` unset | Use default 200000 |
| Empty history | Return `[]` (unchanged) |
| `minRetain > contents.length` | Return `contents` as-is (no trimming possible) |

## Testing

`tests/token-budget.test.ts` — all tests use a fake `countTokens` that returns a scripted value per call:

1. **Under budget passes through** — `countTokens` returns 100, budget 1000 → returns all.
2. **Trims oldest message** — first call 1500, second call 400, budget 1000 → returns slice without first message.
3. **Trims multiple messages** — 3000, 2000, 800, budget 1000 → returns slice removing first 2.
4. **Respects minRetain floor** — budget 1, minRetain 3, contents.length 5 → returns last 3 even though they exceed budget.
5. **Fallback on countTokens throw** — throws on first call → returns `contents.slice(-20)` (or full array if shorter).
6. **Zero contents** — empty array in → empty array out.
7. **Contents <= minRetain short-circuits** — no countTokens call made.

Existing `history.test.ts` stays green (tests formatting, not budgeting). No changes expected.

`GeminiClient.countTokens` is tested indirectly (in manual smoke). Unit-testing it would need mocking the SDK; not worth the overhead for a 2-line wrapper.

## Migration plan

1. Add `src/token-budget.ts` with `selectWithinBudget` + tests.
2. Add `countTokens` method on `GeminiClient`.
3. Add `buildContextHistory` to `history.ts`, keep `fetchHistory` and `formatHistory` exported.
4. Raise raw fetch limit 20 → 100.
5. Update `gemma.ts` to use `buildContextHistory`, read `MAX_HISTORY_TOKENS` from env.
6. Run full tests; smoke-start if env available.
7. Commit.

## Open questions resolved

- **Budget default:** 200,000. Easy to override per-deployment.
- **Floor (minRetain):** 3. Protects against absurd misconfig.
- **countTokens caching:** deferred. Premature without profiling; one extra Gemini call per turn is acceptable latency (~100-300ms).
- **Media accounting:** `countTokens` handles `fileData` parts natively; no special code needed.
- **Reply headroom:** not subtracted from budget. At 200K budget on a 1M window, there's 800K of slack — plenty for system prompt + reply.
