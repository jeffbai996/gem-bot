# Tool Registry & First Registered Tool — Design

**Date:** 2026-04-23
**Status:** Approved, ready for implementation plan

## Motivation

`GeminiClient.respond()` in `src/gemini.ts` hardcodes the `search_memory` function-call dispatch inline (lines 440–472 for the streaming path, 498–512 for the non-streaming path). Adding any new tool — IBKR, GitHub, scraping, cron actions — requires editing `respond()`, duplicating the branch in both streaming and non-streaming code paths. The method is already ~140 lines with heavy duplication between the two paths.

A `ToolRegistry` decouples `GeminiClient` from the set of tools it dispatches. Tools become modules that register themselves; `GeminiClient` knows only the registry. This is the keystone for future capability work (IBKR briefings, GitHub agents, scheduled jobs) — every one of those eventually needs a tool.

## Goals

1. Extract tool dispatch from `GeminiClient.respond()` into a `ToolRegistry`.
2. Port the existing `search_memory` (RAG) tool into the new pattern without behavior change.
3. Add `ibkr_briefing` as the first *new* registered tool. This session: stub implementation returning a placeholder string; real IBKR transport deferred to a follow-up.
4. Dedupe the streaming and non-streaming tool loops in `respond()`.
5. Tests green throughout.

## Non-Goals (Stashed)

- Real IBKR transport wiring (HTTP wrapper, auth, etc.). The stub proves the registry pattern.
- Token-aware context windowing (`history.ts` 20-message cap stays).
- Cron / scheduler / proactive messaging.
- Multi-agent debate / agent handoff.
- Voice channel intake.
- Further decomposition of `gemini.ts` (e.g. splitting the JSON parser into its own module).

## Architecture

### Module layout

```
src/
  tools/
    registry.ts        — ToolRegistry class, Tool/ToolContext interfaces
    search-memory.ts   — RAG tool, ported from inline dispatch
    ibkr-briefing.ts   — new; stub implementation
    index.ts           — buildDefaultRegistry(gemini) wires the two tools
  gemini.ts            — imports registry; no tool-specific logic inline
```

### Interfaces

```typescript
// src/tools/registry.ts
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
  private tools = new Map<string, Tool>()
  register(tool: Tool): void
  getDeclarations(): FunctionDeclaration[]
  async dispatch(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<string>
}
```

- `dispatch()` returns the string payload the model receives in the `functionResponse` part. Errors get serialized into the return string (not thrown) so the model can explain failures to the user, matching the current error-handling posture.
- Unknown tool names dispatch to a default string: `"Unknown tool: <name>"`.

### Tool module pattern

Each tool is a module exporting a `Tool` object. Example (stub form):

```typescript
// src/tools/ibkr-briefing.ts
import { SchemaType } from '@google/generative-ai'
import type { Tool } from './registry.ts'

export const ibkrBriefingTool: Tool = {
  name: 'ibkr_briefing',
  declaration: {
    name: 'ibkr_briefing',
    description: 'Get a portfolio briefing from IBKR: positions, P&L, margin, top movers. Use when asked about portfolio state, holdings, margin, or "how\'s the book".',
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

`search-memory.ts` follows the same shape; its `execute()` embeds the query via `ctx.gemini.embed()` and calls `searchMessages(ctx.channelId, queryEmb, 10)`, returning the formatted string that the current inline dispatch produces.

### Registry assembly

```typescript
// src/tools/index.ts
import { ToolRegistry } from './registry.ts'
import { searchMemoryTool } from './search-memory.ts'
import { ibkrBriefingTool } from './ibkr-briefing.ts'

export function buildDefaultRegistry(): ToolRegistry {
  const r = new ToolRegistry()
  r.register(searchMemoryTool)
  r.register(ibkrBriefingTool)
  return r
}
```

`gemma.ts` calls `buildDefaultRegistry()` once at boot and passes the registry to `new GeminiClient(...)`.

## GeminiClient changes

### Constructor

```typescript
constructor(apiKey: string, modelName: string, registry: ToolRegistry) {
  // …existing setup…
  this.model = genAI.getGenerativeModel({
    model: modelName,
    tools: [
      { googleSearch: {} },
      { codeExecution: {} },
      { functionDeclarations: registry.getDeclarations() }
    ]
  })
  this.registry = registry
}
```

### respond() — loop dedup

The current `respond()` has two near-identical tool loops. After refactor:

```
for iteration in 0..3:
  { text, functionCall, candidate, response } = await runOneTurn(activeContents, onProgress)
  if no functionCall:
    finalParsed = parseResponse(text)
    meta = { …extract from candidate/response… }
    return { parsed: finalParsed, meta }
  activeContents.push({ role: 'model', parts: [{ functionCall }] })
  const result = await this.registry.dispatch(functionCall.name, functionCall.args, { channelId: args.channelId, gemini: this })
  activeContents.push({
    role: 'user',
    parts: [{ functionResponse: { name: functionCall.name, response: { result } } }]
  })
throw new Error('max tool-call iterations exceeded')
```

`runOneTurn()` is a private helper that branches on `onProgress` internally — callers don't care. Its return shape is the same whether streaming or not. This collapses ~140 lines into ~50.

## Data flow

```
user message
  → GeminiClient.respond(args)
    → runOneTurn()  [stream or single-shot internally]
    → if functionCall: registry.dispatch(name, args, ctx) → string
    → loop
  → final parsed JSON { react, thinking, reply }
  → gemma.ts renders to Discord
```

Nothing changes in the response parsing, streaming, chunking, or Discord side. The refactor is strictly internal to the tool dispatch step.

## Error handling

Matches existing behavior:

- Tool throws → `dispatch()` catches and returns a string like `"Error in ibkr_briefing: <message>"`. Model sees it in the `functionResponse` and explains to the user.
- Unknown tool name → `"Unknown tool: <name>"` (current code does this inline).
- Max iterations → `throw new Error('max tool-call iterations exceeded')` — unchanged from current.

## Testing

New test files:

- `tests/tools/registry.test.ts` — register adds to map; duplicate name throws; `getDeclarations()` returns array in registration order; `dispatch()` routes by name; `dispatch()` on unknown name returns the unknown-tool string; `dispatch()` swallows `execute()` errors and returns an error string.
- `tests/tools/search-memory.test.ts` — with a fake `GeminiClient.embed` and a seeded in-memory DB, `execute()` returns the expected formatted string; empty results returns the "No matching messages" string.
- `tests/tools/ibkr-briefing.test.ts` — `execute()` returns the stub string; `declaration.name === 'ibkr_briefing'`; declaration has empty `properties` and no required args.

Existing tests (`tests/gemini.test.ts`) continue to pass. If any existing test relies on internals of the inline dispatch, update it to the registry path.

## Migration plan

1. Add `src/tools/registry.ts` with interfaces and class. No callers yet.
2. Add `src/tools/search-memory.ts` — reuses `embed` from `GeminiClient` via `ctx.gemini`, calls `searchMessages` from `db.ts`.
3. Add `src/tools/ibkr-briefing.ts` as the stub.
4. Add `src/tools/index.ts` with `buildDefaultRegistry()`.
5. Modify `GeminiClient` constructor to take a `ToolRegistry`. Modify `respond()` to use `registry.dispatch()` and factor `runOneTurn()`. Remove inline `search_memory` branches.
6. Modify `gemma.ts` to build the registry and pass it in.
7. Add three new test files under `tests/tools/`.
8. Run `npm run test`; fix any regressions.
9. Commit.

## Open questions resolved during design

- **IBKR transport:** stubbed. Real transport deferred to a follow-up task once HOST → IBKR MCP path is settled.
- **`runOneTurn()` streaming branch:** the helper internally runs either `generateContentStream` (when `onProgress` is provided) or `generateContent`. Both paths return a common shape `{ text, functionCall, candidate, response }`. Streaming path still calls `onProgress(parseResponse(accumulatedText, true))` as it goes.
- **Tool argument typing:** `Record<string, unknown>` on `execute()`. Each tool is responsible for validating its own args (current code does too — see `fnCall.args.query` in `search_memory`).
