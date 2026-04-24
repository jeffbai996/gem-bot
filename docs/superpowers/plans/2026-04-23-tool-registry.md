# Tool Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract hardcoded tool dispatch from `GeminiClient.respond()` into a `ToolRegistry`, port `search_memory` to the new pattern, and add an `ibkr_briefing` stub as the first registered new tool.

**Architecture:** Each tool becomes a module exporting a `Tool` object (name, FunctionDeclaration, async execute). A `ToolRegistry` holds tools by name and provides `getDeclarations()` + `dispatch(name, args, ctx)`. `GeminiClient` takes a registry in its constructor, passes declarations to the Gemini SDK, and routes all function calls through `registry.dispatch()` — no tool-specific branches inline. The streaming and non-streaming tool loops in `respond()` collapse into a shared `runOneTurn()` helper.

**Tech Stack:** TypeScript, Node.js via tsx, `@google/generative-ai` SDK, `node:test`, `better-sqlite3` + `sqlite-vss` (existing).

**Spec:** `docs/superpowers/specs/2026-04-23-tool-registry-design.md`

---

## File Structure

**New files:**
- `src/tools/registry.ts` — `Tool`, `ToolContext` interfaces; `ToolRegistry` class.
- `src/tools/search-memory.ts` — ported RAG tool.
- `src/tools/ibkr-briefing.ts` — stub tool returning a placeholder string.
- `src/tools/index.ts` — `buildDefaultRegistry()` wires the two tools.
- `tests/tools/registry.test.ts` — registry unit tests.
- `tests/tools/search-memory.test.ts` — RAG tool unit tests.
- `tests/tools/ibkr-briefing.test.ts` — stub tool unit tests.

**Modified files:**
- `src/gemini.ts` — `GeminiClient` takes a `ToolRegistry`; `respond()` uses `registry.dispatch()`; extract `runOneTurn()` helper to dedupe streaming/non-streaming.
- `src/gemma.ts` — call `buildDefaultRegistry()` at boot and pass to `new GeminiClient(...)`.

---

## Task 1: ToolRegistry interfaces and class

**Files:**
- Create: `src/tools/registry.ts`
- Test: `tests/tools/registry.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/tools/registry.test.ts`:

```typescript
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { SchemaType } from '@google/generative-ai'
import { ToolRegistry, type Tool, type ToolContext } from '../../src/tools/registry.ts'

function makeTool(name: string, executeImpl?: (args: any, ctx: ToolContext) => Promise<string>): Tool {
  return {
    name,
    declaration: {
      name,
      description: `test tool ${name}`,
      parameters: { type: SchemaType.OBJECT, properties: {}, required: [] }
    },
    execute: executeImpl ?? (async () => `result from ${name}`)
  }
}

const fakeCtx: ToolContext = { gemini: {} as any }

describe('ToolRegistry', () => {
  test('register adds a tool and getDeclarations returns it', () => {
    const reg = new ToolRegistry()
    reg.register(makeTool('alpha'))
    const decls = reg.getDeclarations()
    assert.equal(decls.length, 1)
    assert.equal(decls[0].name, 'alpha')
  })

  test('register preserves insertion order', () => {
    const reg = new ToolRegistry()
    reg.register(makeTool('alpha'))
    reg.register(makeTool('beta'))
    reg.register(makeTool('gamma'))
    const names = reg.getDeclarations().map(d => d.name)
    assert.deepEqual(names, ['alpha', 'beta', 'gamma'])
  })

  test('register throws on duplicate name', () => {
    const reg = new ToolRegistry()
    reg.register(makeTool('alpha'))
    assert.throws(() => reg.register(makeTool('alpha')), /already registered/i)
  })

  test('dispatch routes by name and returns the tool result', async () => {
    const reg = new ToolRegistry()
    reg.register(makeTool('alpha', async () => 'alpha-out'))
    reg.register(makeTool('beta', async () => 'beta-out'))
    assert.equal(await reg.dispatch('beta', {}, fakeCtx), 'beta-out')
  })

  test('dispatch on unknown name returns an unknown-tool string', async () => {
    const reg = new ToolRegistry()
    const result = await reg.dispatch('nope', {}, fakeCtx)
    assert.match(result, /unknown tool.*nope/i)
  })

  test('dispatch catches execute errors and returns an error string', async () => {
    const reg = new ToolRegistry()
    reg.register(makeTool('boom', async () => { throw new Error('kaboom') }))
    const result = await reg.dispatch('boom', {}, fakeCtx)
    assert.match(result, /error in boom/i)
    assert.match(result, /kaboom/)
  })

  test('dispatch passes args and context to execute', async () => {
    const reg = new ToolRegistry()
    let seenArgs: unknown = null
    let seenCtx: unknown = null
    reg.register(makeTool('spy', async (args, ctx) => {
      seenArgs = args
      seenCtx = ctx
      return 'ok'
    }))
    await reg.dispatch('spy', { query: 'hello' }, { channelId: 'C1', gemini: {} as any })
    assert.deepEqual(seenArgs, { query: 'hello' })
    assert.deepEqual(seenCtx, { channelId: 'C1', gemini: {} as any })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- tests/tools/registry.test.ts`
Expected: FAIL with module not found (`src/tools/registry.ts` doesn't exist yet).

- [ ] **Step 3: Implement the registry**

Create `src/tools/registry.ts`:

```typescript
import type { FunctionDeclaration } from '@google/generative-ai'
import type { GeminiClient } from '../gemini.ts'

export interface ToolContext {
  channelId?: string
  userId?: string
  gemini: GeminiClient
}

export interface Tool {
  name: string
  declaration: FunctionDeclaration
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string>
}

export class ToolRegistry {
  private tools: Map<string, Tool> = new Map()
  private order: string[] = []

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" already registered`)
    }
    this.tools.set(tool.name, tool)
    this.order.push(tool.name)
  }

  getDeclarations(): FunctionDeclaration[] {
    return this.order.map(n => this.tools.get(n)!.declaration)
  }

  async dispatch(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const tool = this.tools.get(name)
    if (!tool) return `Unknown tool: ${name}`
    try {
      return await tool.execute(args, ctx)
    } catch (e: any) {
      return `Error in ${name}: ${e?.message ?? String(e)}`
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -- tests/tools/registry.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/tools/registry.ts tests/tools/registry.test.ts
git commit -m "feat: ToolRegistry for pluggable Gemini function-call tools"
```

---

## Task 2: Port search_memory into a Tool

**Files:**
- Create: `src/tools/search-memory.ts`
- Test: `tests/tools/search-memory.test.ts`

**Context:** The current inline dispatch (src/gemini.ts:440–472 streaming, 498–512 non-streaming) embeds the query via `this.embed(query)`, calls `searchMessages(channelId, queryEmb, 10)` from `db.ts`, and joins results as `[timestamp] author_name: content`. The tool must reproduce this exactly.

- [ ] **Step 1: Write the failing tests**

Create `tests/tools/search-memory.test.ts`:

```typescript
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { ToolContext } from '../../src/tools/registry.ts'

// We import the tool lazily after setting up a db mock via module replacement.
// Simpler: test formatBinding + the tool's declaration shape + dispatch behavior
// through a fake gemini + monkey-patched searchMessages via a module-level stub.
//
// We can't easily stub ESM imports without a loader, so we test behavior that
// doesn't hit the real DB: declaration shape, empty-args handling, and the
// formatting of search results via a pure formatter we export.

import { searchMemoryTool, formatSearchResults } from '../../src/tools/search-memory.ts'

describe('searchMemoryTool', () => {
  test('declaration has correct name and required query arg', () => {
    assert.equal(searchMemoryTool.declaration.name, 'search_memory')
    assert.deepEqual(searchMemoryTool.declaration.parameters?.required, ['query'])
    const props = searchMemoryTool.declaration.parameters?.properties as Record<string, any>
    assert.ok(props.query, 'query property defined')
  })

  test('execute without channelId returns a helpful error string', async () => {
    const ctx: ToolContext = { gemini: { embed: async () => [] } as any }
    const result = await searchMemoryTool.execute({ query: 'x' }, ctx)
    assert.match(result, /channel/i)
  })

  test('execute without query arg returns a helpful error string', async () => {
    const ctx: ToolContext = {
      channelId: 'C1',
      gemini: { embed: async () => [] } as any
    }
    const result = await searchMemoryTool.execute({}, ctx)
    assert.match(result, /query/i)
  })
})

describe('formatSearchResults', () => {
  test('empty array returns the no-match string', () => {
    assert.equal(formatSearchResults([]), 'No matching messages found in memory.')
  })

  test('formats entries as [timestamp] author: content joined by newlines', () => {
    const out = formatSearchResults([
      { timestamp: '2026-01-01T00:00:00Z', author_name: 'Dan', content: 'hello world' } as any,
      { timestamp: '2026-01-02T00:00:00Z', author_name: 'Jeff', content: 'yo' } as any
    ])
    assert.equal(
      out,
      '[2026-01-01T00:00:00Z] Dan: hello world\n[2026-01-02T00:00:00Z] Jeff: yo'
    )
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- tests/tools/search-memory.test.ts`
Expected: FAIL with module not found.

- [ ] **Step 3: Implement the tool**

Create `src/tools/search-memory.ts`:

```typescript
import { SchemaType } from '@google/generative-ai'
import type { Tool } from './registry.ts'
import { searchMessages, type SearchResult } from '../db.ts'

export function formatSearchResults(results: SearchResult[]): string {
  if (results.length === 0) return 'No matching messages found in memory.'
  return results.map(r => `[${r.timestamp}] ${r.author_name}: ${r.content}`).join('\n')
}

export const searchMemoryTool: Tool = {
  name: 'search_memory',
  declaration: {
    name: 'search_memory',
    description: 'Search past Discord messages for context by semantic meaning. Use this when asked about past events, previous discussions, or if you need more context from history.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        query: { type: SchemaType.STRING, description: 'The semantic search query' }
      },
      required: ['query']
    }
  },
  async execute(args, ctx) {
    if (!ctx.channelId) {
      return 'search_memory requires a channel context; none was provided.'
    }
    const query = args.query
    if (typeof query !== 'string' || query.length === 0) {
      return 'search_memory requires a non-empty "query" string argument.'
    }
    console.error(`[RAG] Searching memory for query: "${query}" in channel ${ctx.channelId}`)
    const queryEmb = await ctx.gemini.embed(query)
    const results = searchMessages(ctx.channelId, queryEmb, 10)
    return formatSearchResults(results)
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -- tests/tools/search-memory.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/tools/search-memory.ts tests/tools/search-memory.test.ts
git commit -m "feat: port search_memory RAG to Tool interface"
```

---

## Task 3: IBKR briefing stub tool

**Files:**
- Create: `src/tools/ibkr-briefing.ts`
- Test: `tests/tools/ibkr-briefing.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/tools/ibkr-briefing.test.ts`:

```typescript
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { ToolContext } from '../../src/tools/registry.ts'
import { ibkrBriefingTool } from '../../src/tools/ibkr-briefing.ts'

const fakeCtx: ToolContext = { gemini: {} as any }

describe('ibkrBriefingTool', () => {
  test('declaration name is ibkr_briefing', () => {
    assert.equal(ibkrBriefingTool.declaration.name, 'ibkr_briefing')
  })

  test('declaration has empty properties and no required args', () => {
    const params = ibkrBriefingTool.declaration.parameters
    const props = params?.properties as Record<string, unknown>
    assert.deepEqual(props ?? {}, {})
    assert.deepEqual(params?.required ?? [], [])
  })

  test('execute returns a non-empty stub string', async () => {
    const result = await ibkrBriefingTool.execute({}, fakeCtx)
    assert.ok(result.length > 0)
    assert.match(result, /stub/i)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- tests/tools/ibkr-briefing.test.ts`
Expected: FAIL with module not found.

- [ ] **Step 3: Implement the stub**

Create `src/tools/ibkr-briefing.ts`:

```typescript
import { SchemaType } from '@google/generative-ai'
import type { Tool } from './registry.ts'

export const ibkrBriefingTool: Tool = {
  name: 'ibkr_briefing',
  declaration: {
    name: 'ibkr_briefing',
    description: 'Get a portfolio briefing from IBKR: positions, P&L, margin, top movers. Use when asked about portfolio state, holdings, margin status, or "how\'s the book".',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {},
      required: []
    }
  },
  async execute(_args, _ctx) {
    return '[stub: IBKR briefing not yet wired. Registry plumbing is working — this tool will be implemented when IBKR transport from HOST is settled.]'
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -- tests/tools/ibkr-briefing.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/tools/ibkr-briefing.ts tests/tools/ibkr-briefing.test.ts
git commit -m "feat: ibkr_briefing stub tool as first new registered tool"
```

---

## Task 4: Default registry assembly

**Files:**
- Create: `src/tools/index.ts`

- [ ] **Step 1: Implement the factory**

Create `src/tools/index.ts`:

```typescript
import { ToolRegistry } from './registry.ts'
import { searchMemoryTool } from './search-memory.ts'
import { ibkrBriefingTool } from './ibkr-briefing.ts'

export { ToolRegistry } from './registry.ts'
export type { Tool, ToolContext } from './registry.ts'

export function buildDefaultRegistry(): ToolRegistry {
  const r = new ToolRegistry()
  r.register(searchMemoryTool)
  r.register(ibkrBriefingTool)
  return r
}
```

- [ ] **Step 2: Add a smoke test**

Append to `tests/tools/registry.test.ts`:

```typescript
import { buildDefaultRegistry } from '../../src/tools/index.ts'

describe('buildDefaultRegistry', () => {
  test('registers search_memory and ibkr_briefing', () => {
    const r = buildDefaultRegistry()
    const names = r.getDeclarations().map(d => d.name)
    assert.deepEqual(names, ['search_memory', 'ibkr_briefing'])
  })
})
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `npm run test -- tests/tools/registry.test.ts`
Expected: PASS (8 tests now).

- [ ] **Step 4: Commit**

```bash
git add src/tools/index.ts tests/tools/registry.test.ts
git commit -m "feat: buildDefaultRegistry wires search_memory + ibkr_briefing"
```

---

## Task 5: Refactor GeminiClient to use the registry

This is the big one. Split it into sub-steps so it stays small and green.

**Files:**
- Modify: `src/gemini.ts` (constructor, `respond()`, add `runOneTurn()` helper)
- Modify: `src/gemma.ts` (build registry, pass to GeminiClient)

### 5a: Wire constructor to accept a registry

- [ ] **Step 1: Update GeminiClient constructor signature and internals**

In `src/gemini.ts`:

Replace the existing `GeminiClient` constructor (around line 346–370) with:

```typescript
export class GeminiClient {
  private model: ReturnType<GoogleGenerativeAI['getGenerativeModel']>
  private registry: ToolRegistry

  constructor(apiKey: string, modelName: string = 'gemini-2.0-flash', registry: ToolRegistry) {
    const genAI = new GoogleGenerativeAI(apiKey)
    this.registry = registry
    this.model = genAI.getGenerativeModel({
      model: modelName,
      tools: [
        { googleSearch: {} },
        { codeExecution: {} },
        { functionDeclarations: registry.getDeclarations() }
      ]
    })
  }
  // … existing embed() and respond() stay for now …
}
```

Add import at top of `src/gemini.ts`:

```typescript
import { ToolRegistry } from './tools/registry.ts'
```

(Keep the `import { searchMessages } from './db.ts'` for now; removed in 5c.)

- [ ] **Step 2: Update gemma.ts to build and pass the registry**

In `src/gemma.ts`:

Add import near the other `./` imports:

```typescript
import { buildDefaultRegistry } from './tools/index.ts'
```

Replace this line (around line 32):
```typescript
const gemini = new GeminiClient(GEMINI_API_KEY, MODEL_NAME)
```
with:
```typescript
const toolRegistry = buildDefaultRegistry()
const gemini = new GeminiClient(GEMINI_API_KEY, MODEL_NAME, toolRegistry)
```

- [ ] **Step 3: Run the full test suite**

Run: `npm run test`
Expected: PASS. The existing `respond()` still uses inline dispatch; the registry is held but unused. This is intentional — we're landing small steps.

- [ ] **Step 4: Commit**

```bash
git add src/gemini.ts src/gemma.ts
git commit -m "refactor: GeminiClient accepts ToolRegistry (not yet wired into respond)"
```

### 5b: Extract runOneTurn helper (no behavior change)

- [ ] **Step 1: Add the helper and refactor respond() to use it**

In `src/gemini.ts`, add this private method inside `GeminiClient` (above `respond`):

```typescript
// Result shape shared by streaming and non-streaming single turns.
private async runOneTurn(
  systemText: string,
  activeContents: Content[],
  onProgress?: (partial: ParsedResponse) => void
): Promise<{
  functionCall: any | null
  candidate: any
  response: any
  text: string
}> {
  if (onProgress) {
    const result = await this.model.generateContentStream({
      systemInstruction: { role: 'system', parts: [{ text: systemText }] },
      contents: activeContents
    })
    let accumulatedText = ''
    let functionCallReceived: any = null

    for await (const chunk of result.stream) {
      const parts = chunk.candidates?.[0]?.content?.parts as any[] | undefined
      const fnCallPart = parts?.find(p => p.functionCall)
      if (fnCallPart) functionCallReceived = fnCallPart.functionCall
      const textChunk = extractModelText(parts)
      if (textChunk && !functionCallReceived) {
        accumulatedText += textChunk
        onProgress(parseResponse(accumulatedText, true))
      }
    }

    const response = await result.response
    const candidate = response.candidates?.[0]
    const parts = candidate?.content?.parts as any[] | undefined
    // Prefer the streamed accumulated text; fall back to joined parts if empty.
    const text = accumulatedText || extractModelText(parts)
    const fnCall = functionCallReceived || parts?.find(p => p.functionCall)?.functionCall || null
    return { functionCall: fnCall, candidate, response, text }
  } else {
    const result = await this.model.generateContent({
      systemInstruction: { role: 'system', parts: [{ text: systemText }] },
      contents: activeContents
    })
    const candidate = result.response.candidates?.[0]
    const parts = candidate?.content?.parts as any[] | undefined
    const fnCall = parts?.find(p => p.functionCall)?.functionCall || null
    const text = extractModelText(parts)
    return { functionCall: fnCall, candidate, response: result.response, text }
  }
}
```

Now replace the entire body of `respond()` (lines ~380–521, everything inside the method) with:

```typescript
async respond(
  args: BuildRequestArgs,
  onProgress?: (partial: ParsedResponse) => void
): Promise<RespondResult> {
  const userTurn = buildUserTurn(args)
  const systemText = formatSystemPrompt(args.systemPrompt, args.thinkingMode ?? 'auto')

  let activeContents: Content[] = [...args.history, userTurn]
  let meta: RespondMetadata | null = null
  let finalParsed: ParsedResponse = { react: null, thinking: null, reply: null }

  for (let iteration = 0; iteration < 3; iteration++) {
    const turn = await this.runOneTurn(systemText, activeContents, onProgress)

    if (!turn.functionCall) {
      finalParsed = parseResponse(turn.text)
      meta = {
        groundingSources: extractGroundingSources(turn.candidate),
        codeArtifacts: extractCodeArtifacts(turn.candidate?.content?.parts),
        usage: extractUsage(turn.response),
        finishReason: typeof turn.candidate?.finishReason === 'string' ? turn.candidate.finishReason : null,
        flaggedSafety: extractFlaggedSafety(turn.candidate)
      }
      break
    }

    activeContents.push({ role: 'model', parts: [{ functionCall: turn.functionCall }] })

    // Dispatch through the registry. Inline branches removed.
    const result = await this.registry.dispatch(
      turn.functionCall.name,
      turn.functionCall.args ?? {},
      { channelId: args.channelId, gemini: this }
    )
    activeContents.push({
      role: 'user',
      parts: [{ functionResponse: { name: turn.functionCall.name, response: { result } } }]
    })
  }

  if (!meta) {
    throw new Error('Failed to complete response after maximum function call iterations.')
  }

  return { parsed: finalParsed, meta }
}
```

Remove the now-unused `import { searchMessages } from './db.ts'` from the top of `src/gemini.ts`.

- [ ] **Step 2: Run the full test suite**

Run: `npm run test`
Expected: PASS. Behavior is unchanged; tool dispatch now flows through the registry.

- [ ] **Step 3: Visual diff check**

Run: `git diff src/gemini.ts | head -200`
Expected: `respond()` is noticeably smaller; both tool loops are gone; `runOneTurn()` is new.

- [ ] **Step 4: Commit**

```bash
git add src/gemini.ts
git commit -m "refactor: respond() uses ToolRegistry, runOneTurn dedupes stream/non-stream"
```

---

## Task 6: Final verification

- [ ] **Step 1: Run the complete test suite**

Run: `npm run test`
Expected: All tests pass, including:
- `tests/tools/registry.test.ts` (8)
- `tests/tools/search-memory.test.ts` (5)
- `tests/tools/ibkr-briefing.test.ts` (3)
- All existing test files untouched (`access`, `attachments`, `chunk`, `gemini`, `history`, `persona`)

- [ ] **Step 2: Smoke-start the bot locally (only if env is set up)**

Run: `npm run start`
Expected: Prints `Gemma online as ... Slash commands registered.` and does not crash. Ctrl-C to stop.

If `.env` / `access.json` aren't set up on this machine, skip this step; the test suite is the primary gate.

- [ ] **Step 3: Confirm line count reduction in src/gemini.ts**

Run: `wc -l src/gemini.ts`
Expected: fewer than ~450 lines (was 522; saved ~80 from tool-loop dedup + removed inline dispatch).

- [ ] **Step 4: Done**

No final commit needed — Task 5b was the last code commit.

---

## Out of Scope (explicit — do NOT do these in this plan)

- Real IBKR transport wiring (HTTP wrapper, MCP-over-network, etc.).
- Token-aware context windowing.
- Cron / scheduled messaging.
- Multi-agent debate / agent handoff.
- Voice channel intake.
- Further splitting `gemini.ts` (response-parser extraction, etc.).
