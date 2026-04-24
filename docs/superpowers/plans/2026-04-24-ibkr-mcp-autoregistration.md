# IBKR MCP Auto-Registration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Replace the single IBKR stub tool with auto-registration of all 32 MCP tools from `<your-ibkr-mcp-server>` via streamable-HTTP MCP transport.

**Architecture:** Add `@modelcontextprotocol/sdk`. On `buildDefaultRegistry()`, connect to `IBKR_MCP_URL` (default `http://127.0.0.1:8000/mcp`), `listTools()`, convert each JSON Schema to Gemini's Schema format, register. On connect failure, register a single "IBKR unreachable" fallback tool and keep booting.

**Tech Stack:** TypeScript, Node.js via tsx, `@modelcontextprotocol/sdk`, `@google/generative-ai`, `node:test`.

**Spec:** `docs/superpowers/specs/2026-04-24-ibkr-mcp-autoregistration-design.md`

---

## File Structure

**New:**
- `src/tools/mcp-schema.ts` — JSON Schema → Gemini Schema converter.
- `src/tools/mcp-client.ts` — `connectMcpClient(url)`.
- `src/tools/ibkr-tools.ts` — `loadIbkrTools(client)`.
- `src/tools/ibkr-unreachable-stub.ts` — fallback Tool.
- `tests/tools/mcp-schema.test.ts` — converter tests.

**Modified:**
- `src/tools/index.ts` — `buildDefaultRegistry` async, tries MCP connect.
- `src/gemma.ts` — `await buildDefaultRegistry()`.
- `tests/tools/registry.test.ts` — await smoke test, relax assertions.
- `package.json` — add `@modelcontextprotocol/sdk`.

**Deleted:**
- `src/tools/ibkr-briefing.ts`
- `tests/tools/ibkr-briefing.test.ts`

---

## Task 0: Install MCP SDK

- [ ] **Step 1: Install**

Run: `npm install @modelcontextprotocol/sdk`
Expected: package added, `package-lock.json` updated.

- [ ] **Step 2: Verify import works**

Run a one-liner to confirm the SDK resolves:
```bash
node --import tsx -e "import('@modelcontextprotocol/sdk/client/index.js').then(m => console.log('ok', Object.keys(m)))"
```
Expected: prints `ok ['Client', ...]`

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add @modelcontextprotocol/sdk for MCP client support"
```

---

## Task 1: Schema converter (pure, testable)

**Files:**
- Create: `src/tools/mcp-schema.ts`
- Test: `tests/tools/mcp-schema.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/tools/mcp-schema.test.ts`:

```typescript
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { SchemaType } from '@google/generative-ai'
import { mcpSchemaToGemini } from '../../src/tools/mcp-schema.ts'

describe('mcpSchemaToGemini', () => {
  test('string primitive', () => {
    assert.deepEqual(
      mcpSchemaToGemini({ type: 'string' }),
      { type: SchemaType.STRING }
    )
  })

  test('integer → NUMBER (Gemini has no INTEGER)', () => {
    assert.deepEqual(
      mcpSchemaToGemini({ type: 'integer' }),
      { type: SchemaType.NUMBER }
    )
  })

  test('number and boolean primitives', () => {
    assert.deepEqual(mcpSchemaToGemini({ type: 'number' }), { type: SchemaType.NUMBER })
    assert.deepEqual(mcpSchemaToGemini({ type: 'boolean' }), { type: SchemaType.BOOLEAN })
  })

  test('array of strings', () => {
    assert.deepEqual(
      mcpSchemaToGemini({ type: 'array', items: { type: 'string' } }),
      { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } }
    )
  })

  test('object with properties and required', () => {
    const out = mcpSchemaToGemini({
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'ticker' },
        qty: { type: 'integer' }
      },
      required: ['symbol']
    })
    assert.deepEqual(out, {
      type: SchemaType.OBJECT,
      properties: {
        symbol: { type: SchemaType.STRING, description: 'ticker' },
        qty: { type: SchemaType.NUMBER }
      },
      required: ['symbol']
    })
  })

  test('enum preserved on string', () => {
    const out = mcpSchemaToGemini({ type: 'string', enum: ['a', 'b', 'c'] })
    assert.deepEqual(out, { type: SchemaType.STRING, enum: ['a', 'b', 'c'] })
  })

  test('description preserved', () => {
    assert.deepEqual(
      mcpSchemaToGemini({ type: 'string', description: 'x' }),
      { type: SchemaType.STRING, description: 'x' }
    )
  })

  test('nullable union stripped to non-null type', () => {
    assert.deepEqual(
      mcpSchemaToGemini({ type: ['string', 'null'] }),
      { type: SchemaType.STRING }
    )
  })

  test('anyOf returns null', () => {
    assert.equal(
      mcpSchemaToGemini({ anyOf: [{ type: 'string' }, { type: 'number' }] }),
      null
    )
  })

  test('oneOf returns null', () => {
    assert.equal(
      mcpSchemaToGemini({ oneOf: [{ type: 'string' }, { type: 'number' }] }),
      null
    )
  })

  test('missing type returns null', () => {
    assert.equal(mcpSchemaToGemini({ description: 'no type' }), null)
  })

  test('empty object schema → OBJECT with empty properties', () => {
    assert.deepEqual(
      mcpSchemaToGemini({ type: 'object' }),
      { type: SchemaType.OBJECT, properties: {}, required: [] }
    )
  })

  test('object with unrepresentable property skips that property', () => {
    const out = mcpSchemaToGemini({
      type: 'object',
      properties: {
        good: { type: 'string' },
        bad: { anyOf: [{ type: 'string' }, { type: 'number' }] }
      }
    })
    assert.deepEqual(out, {
      type: SchemaType.OBJECT,
      properties: { good: { type: SchemaType.STRING } },
      required: []
    })
  })
})
```

- [ ] **Step 2: Run — expect failure**

Run: `npm run test -- 'tests/tools/mcp-schema.test.ts'`
Expected: module not found.

- [ ] **Step 3: Implement**

Create `src/tools/mcp-schema.ts`:

```typescript
import { SchemaType, type Schema } from '@google/generative-ai'

type JSONSchema = Record<string, any>

// Returns null if the schema cannot be represented in Gemini's Schema type.
// Callers at object-property level should skip null results and log a warning.
export function mcpSchemaToGemini(schema: unknown): Schema | null {
  if (!schema || typeof schema !== 'object') return null
  const s = schema as JSONSchema

  // Gemini does not support anyOf / oneOf. Bail.
  if (s.anyOf || s.oneOf) return null

  // Normalize nullable unions like {type: ["string", "null"]} to the non-null type
  let type = s.type
  if (Array.isArray(type)) {
    const nonNull = type.filter((t: string) => t !== 'null')
    if (nonNull.length !== 1) return null
    type = nonNull[0]
  }

  if (typeof type !== 'string') return null

  const out: Schema = {} as Schema

  switch (type) {
    case 'string':
      out.type = SchemaType.STRING
      break
    case 'number':
    case 'integer':
      out.type = SchemaType.NUMBER
      break
    case 'boolean':
      out.type = SchemaType.BOOLEAN
      break
    case 'array': {
      out.type = SchemaType.ARRAY
      const itemSchema = s.items ? mcpSchemaToGemini(s.items) : null
      if (itemSchema) (out as any).items = itemSchema
      break
    }
    case 'object': {
      out.type = SchemaType.OBJECT
      const props: Record<string, Schema> = {}
      for (const [k, v] of Object.entries(s.properties ?? {})) {
        const converted = mcpSchemaToGemini(v)
        if (converted) {
          props[k] = converted
        } else {
          console.error(`[mcp-schema] skipping unrepresentable property "${k}"`)
        }
      }
      ;(out as any).properties = props
      const required: string[] = Array.isArray(s.required) ? s.required.filter((r: string) => r in props) : []
      ;(out as any).required = required
      break
    }
    default:
      return null
  }

  if (typeof s.description === 'string') (out as any).description = s.description
  if (Array.isArray(s.enum)) (out as any).enum = s.enum
  return out
}
```

- [ ] **Step 4: Run — expect pass**

Run: `npm run test -- 'tests/tools/mcp-schema.test.ts'`
Expected: all 13 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/tools/mcp-schema.ts tests/tools/mcp-schema.test.ts
git commit -m "feat: mcpSchemaToGemini converts JSON Schema to Gemini Schema"
```

---

## Task 2: MCP client wrapper

**Files:**
- Create: `src/tools/mcp-client.ts`

- [ ] **Step 1: Implement**

Create `src/tools/mcp-client.ts`:

```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

export async function connectMcpClient(url: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(url))
  const client = new Client(
    { name: 'gemma-discord-bot', version: '1.0.0' },
    { capabilities: {} }
  )
  await client.connect(transport)
  return client
}
```

No tests — thin wrapper, network-dependent, covered by smoke test.

- [ ] **Step 2: Smoke test the module loads**

Run: `node --import tsx -e "import('./src/tools/mcp-client.ts').then(m => console.log('ok', typeof m.connectMcpClient))"`
Expected: `ok function`.

- [ ] **Step 3: Commit**

```bash
git add src/tools/mcp-client.ts
git commit -m "feat: connectMcpClient wraps MCP streamable-HTTP transport"
```

---

## Task 3: IBKR tool loader + unreachable stub

**Files:**
- Create: `src/tools/ibkr-tools.ts`
- Create: `src/tools/ibkr-unreachable-stub.ts`

- [ ] **Step 1: Implement the fallback stub**

Create `src/tools/ibkr-unreachable-stub.ts`:

```typescript
import { SchemaType } from '@google/generative-ai'
import type { Tool } from './registry.ts'

// Registered only when MCP connect fails at boot. Gives the model a valid
// function-call target so it can tell the user IBKR is unreachable instead
// of silently having no tool available.
export const ibkrUnreachableStub: Tool = {
  name: 'ibkr_briefing',
  declaration: {
    name: 'ibkr_briefing',
    description: 'Get a portfolio briefing from IBKR. Currently UNREACHABLE — IBKR MCP server is not running. Calling this tool will return an error string explaining the situation.',
    parameters: { type: SchemaType.OBJECT, properties: {}, required: [] }
  },
  async execute() {
    return 'IBKR MCP server is not reachable. Tell the user their IBKR connection is offline and they should start the server at <your-ibkr-mcp-server>.'
  }
}
```

- [ ] **Step 2: Implement the loader**

Create `src/tools/ibkr-tools.ts`:

```typescript
import { SchemaType } from '@google/generative-ai'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { Tool } from './registry.ts'
import { mcpSchemaToGemini } from './mcp-schema.ts'

export async function loadIbkrTools(client: Client): Promise<Tool[]> {
  const { tools: mcpTools } = await client.listTools()
  const out: Tool[] = []
  for (const t of mcpTools) {
    const convertedSchema = mcpSchemaToGemini(t.inputSchema)
    const params = convertedSchema ?? { type: SchemaType.OBJECT, properties: {}, required: [] }
    out.push({
      name: t.name,
      declaration: {
        name: t.name,
        description: t.description ?? `MCP tool ${t.name}`,
        parameters: params
      },
      async execute(args, _ctx) {
        const res = await client.callTool({ name: t.name, arguments: args })
        const parts = (res.content as any[]) ?? []
        return parts.map(p => p?.type === 'text' ? p.text : JSON.stringify(p)).join('\n') || '[empty response]'
      }
    })
  }
  return out
}
```

- [ ] **Step 3: Verify existing tests still pass (these new files not yet imported)**

Run: `npm run test`
Expected: all tests pass unchanged.

- [ ] **Step 4: Commit**

```bash
git add src/tools/ibkr-tools.ts src/tools/ibkr-unreachable-stub.ts
git commit -m "feat: loadIbkrTools + IBKR unreachable fallback stub"
```

---

## Task 4: Make buildDefaultRegistry async + connect MCP

**Files:**
- Modify: `src/tools/index.ts`

- [ ] **Step 1: Replace index.ts contents**

Replace `src/tools/index.ts` with:

```typescript
import { ToolRegistry } from './registry.ts'
import { searchMemoryTool } from './search-memory.ts'
import { connectMcpClient } from './mcp-client.ts'
import { loadIbkrTools } from './ibkr-tools.ts'
import { ibkrUnreachableStub } from './ibkr-unreachable-stub.ts'

export { ToolRegistry } from './registry.ts'
export type { Tool, ToolContext } from './registry.ts'

export async function buildDefaultRegistry(): Promise<ToolRegistry> {
  const r = new ToolRegistry()
  r.register(searchMemoryTool)

  const ibkrUrl = process.env.IBKR_MCP_URL || 'http://127.0.0.1:8000/mcp'
  try {
    const client = await connectMcpClient(ibkrUrl)
    const tools = await loadIbkrTools(client)
    for (const t of tools) r.register(t)
    console.error(`[ibkr] registered ${tools.length} tools from MCP at ${ibkrUrl}`)
  } catch (e: any) {
    console.error(`[ibkr] MCP connect failed at ${ibkrUrl}: ${e?.message ?? e}. Registering fallback stub.`)
    r.register(ibkrUnreachableStub)
  }

  return r
}
```

- [ ] **Step 2: Verify tests are red (registry.test.ts smoke expects sync)**

Run: `npm run test -- 'tests/tools/registry.test.ts'`
Expected: FAIL — `buildDefaultRegistry` now returns a Promise, not a ToolRegistry, so `.getDeclarations()` is undefined. We'll fix this in Task 6 along with gemma.ts.

- [ ] **Step 3: Do NOT commit yet** — next task fixes the callers.

---

## Task 5: Delete the old ibkr-briefing stub

**Files:**
- Delete: `src/tools/ibkr-briefing.ts`
- Delete: `tests/tools/ibkr-briefing.test.ts`

- [ ] **Step 1: Remove**

```bash
git rm src/tools/ibkr-briefing.ts tests/tools/ibkr-briefing.test.ts
```

- [ ] **Step 2: Do NOT commit yet** — combine with Task 6 commit to keep the tree test-green per commit from Task 6 onward.

---

## Task 6: Await in gemma.ts + update smoke test

**Files:**
- Modify: `src/gemma.ts`
- Modify: `tests/tools/registry.test.ts`

- [ ] **Step 1: Update gemma.ts**

In `src/gemma.ts`, change:

```typescript
const toolRegistry = buildDefaultRegistry()
const gemini = new GeminiClient(GEMINI_API_KEY, MODEL_NAME, toolRegistry)
```

to:

```typescript
const toolRegistry = await buildDefaultRegistry()
const gemini = new GeminiClient(GEMINI_API_KEY, MODEL_NAME, toolRegistry)
```

The file is already an ES module with top-level `await` elsewhere (`await access.load()`), so `await` at module top is fine.

- [ ] **Step 2: Update registry.test.ts smoke test**

Find:

```typescript
describe('buildDefaultRegistry', () => {
  test('registers search_memory and ibkr_briefing', () => {
    const r = buildDefaultRegistry()
    const names = r.getDeclarations().map(d => d.name)
    assert.deepEqual(names, ['search_memory', 'ibkr_briefing'])
  })
})
```

Replace with:

```typescript
describe('buildDefaultRegistry', () => {
  test('registers search_memory first; IBKR tools or fallback stub second', async () => {
    const r = await buildDefaultRegistry()
    const names = r.getDeclarations().map(d => d.name)
    assert.ok(names.length >= 2, `expected at least 2 tools, got ${names.length}`)
    assert.equal(names[0], 'search_memory')
    // Second tool is either `ibkr_briefing` (fallback stub when MCP is down)
    // or one of the 32 IBKR MCP tool names (when MCP server is up).
    // We don't hard-code the list — just assert there's *something* registered.
    assert.ok(names.length > 1, 'IBKR tools or fallback stub should be registered')
  })
})
```

- [ ] **Step 3: Run tests**

Run: `npm run test`
Expected: all pass.  The smoke test will likely hit the fallback branch (MCP server not running locally during test), logging a connect error to stderr — that's expected.

- [ ] **Step 4: Commit all of Tasks 4, 5, 6 together**

```bash
git add src/tools/index.ts src/gemma.ts tests/tools/registry.test.ts
git commit -m "feat: async buildDefaultRegistry auto-loads IBKR MCP tools with fallback"
```

---

## Task 7: Final verification

- [ ] **Step 1: Full test run**

Run: `npm run test`
Expected: all tests pass (count will change: ~125 tests; `ibkr-briefing.test.ts` removed, `mcp-schema.test.ts` added with 13 tests).

- [ ] **Step 2: Smoke-start if IBKR env available**

If `IBKR_MCP_URL` is reachable (e.g. ibkr-mcp is running locally):
```bash
npm run start
```
Expected output includes `[ibkr] registered N tools from MCP at http://127.0.0.1:8000/mcp`.

If not running: expect `[ibkr] MCP connect failed ... Registering fallback stub.` and bot still boots.

Ctrl-C.

- [ ] **Step 3: Confirm no stale imports**

Run Grep for `ibkr-briefing` across `src/` and `tests/`.
Expected: zero matches.

- [ ] **Step 4: Done**

---

## Out of Scope (explicit)

- Reconnect-on-disconnect.
- Per-tool access control.
- Response caching.
- Registering other MCP servers.
- Supporting `anyOf`/`oneOf` (logged & skipped).
