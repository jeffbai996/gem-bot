# IBKR MCP Auto-Registration — Design

**Date:** 2026-04-24
**Status:** Approved (auto mode), ready for implementation plan

## Motivation

`src/tools/ibkr-briefing.ts` is a stub. The real IBKR tool surface already exists as an MCP server at `<your-ibkr-mcp-server>` — 32 read-only tools (briefing, positions, margin, what-if, stress test, technicals, etc.) over streamable HTTP on port 8000. Gemma runs on the same box as IBKR MCP (HOST, per user confirmation).

With the `ToolRegistry` from the previous session, registering 32 MCP tools is a loop, not 32 bespoke files. Auto-registration at boot is strictly better than a single stub replacement: the plumbing is built once, all 32 tools are live immediately, and the same pattern extends to future MCP servers.

## Goals

1. Connect to IBKR MCP server at boot via `@modelcontextprotocol/sdk` streamable-HTTP transport.
2. List available MCP tools, convert each tool's JSON Schema to Gemini's `FunctionDeclaration` schema, register each as a `Tool` on the existing `ToolRegistry`.
3. Dispatch: IBKR tool `execute()` forwards to `mcpClient.callTool()` and returns the text content.
4. Graceful degradation: if MCP connect fails at boot, log warning, register a single fallback stub named `ibkr_briefing` that tells the model IBKR is unreachable. Other registered tools (`search_memory`) keep working.
5. Delete the current stub-only `ibkr-briefing.ts` since it's replaced by auto-registration (or the unreachable-fallback).

## Non-Goals (Stashed)

- Reconnect-on-disconnect retry loop. If MCP goes down mid-session, tools error until bot restart.
- Per-tool access control (allowlist of which IBKR tools are callable). All 32 available to all allowed users.
- Response caching (briefings regenerate each call).
- Registering other MCP servers (code-review-tool, etc.) — same pattern, future work.
- Schema features Gemini doesn't support: `anyOf`/`oneOf`. Log and skip the property.
- Reconnection if the IBKR server restarts. Bot restart required.

## Architecture

### Module layout

```
src/tools/
  mcp-client.ts                — connectMcpClient(url) -> Client instance
  mcp-schema.ts                — mcpSchemaToGemini() — JSON Schema → Gemini Schema
  ibkr-tools.ts                — loadIbkrTools(client) -> Tool[]
  ibkr-unreachable-stub.ts     — NEW; fallback Tool used when MCP connect fails
  ibkr-briefing.ts             — DELETED
  index.ts                     — buildDefaultRegistry is now async, tries MCP connect
src/gemma.ts                   — await buildDefaultRegistry() (was sync)
tests/tools/
  mcp-schema.test.ts           — new, unit tests for the converter
  ibkr-briefing.test.ts        — DELETED along with the source file
```

### Transport

MCP streamable-HTTP URL: `http://127.0.0.1:8000/mcp` by default (FastMCP mounts `streamable_http_app()` at `/mcp`). Configurable via `IBKR_MCP_URL` env var.

### Interfaces

```typescript
// src/tools/mcp-client.ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

export async function connectMcpClient(url: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(url))
  const client = new Client({ name: 'gemma-discord-bot', version: '1.0.0' }, { capabilities: {} })
  await client.connect(transport)
  return client
}
```

```typescript
// src/tools/mcp-schema.ts
import { SchemaType, type Schema } from '@google/generative-ai'

// Convert an MCP tool's JSON Schema to Gemini's FunctionDeclaration schema.
// Returns null if the schema can't be represented (e.g. anyOf/oneOf at top level).
export function mcpSchemaToGemini(schema: unknown): Schema | null
```

```typescript
// src/tools/ibkr-tools.ts
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { Tool } from './registry.ts'

export async function loadIbkrTools(client: Client): Promise<Tool[]> {
  const { tools: mcpTools } = await client.listTools()
  const out: Tool[] = []
  for (const t of mcpTools) {
    const params = mcpSchemaToGemini(t.inputSchema) ?? { type: SchemaType.OBJECT, properties: {}, required: [] }
    out.push({
      name: t.name,
      declaration: {
        name: t.name,
        description: t.description ?? '',
        parameters: params
      },
      async execute(args, _ctx) {
        const res = await client.callTool({ name: t.name, arguments: args })
        // MCP returns content as array of {type: 'text', text: string} blocks
        const parts = (res.content as any[]) ?? []
        return parts.map(p => p.type === 'text' ? p.text : JSON.stringify(p)).join('\n') || '[empty response]'
      }
    })
  }
  return out
}
```

```typescript
// src/tools/index.ts
import { ToolRegistry } from './registry.ts'
import { searchMemoryTool } from './search-memory.ts'
import { connectMcpClient } from './mcp-client.ts'
import { loadIbkrTools } from './ibkr-tools.ts'
import { ibkrUnreachableStub } from './ibkr-unreachable-stub.ts'  // new, inline

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
    console.error(`[ibkr] MCP connect failed at ${ibkrUrl}: ${e?.message ?? e}. Registering fallback.`)
    r.register(ibkrUnreachableStub)
  }

  return r
}
```

The unreachable-stub module contains only the fallback Tool — tiny, kept separate for testability.

### Schema converter

JSON Schema → Gemini Schema mapping:

| JSON Schema                                | Gemini Schema                                  |
|---|---|
| `{type: "string"}`                         | `{type: STRING}`                               |
| `{type: "number"}` / `"integer"`           | `{type: NUMBER}`                               |
| `{type: "boolean"}`                        | `{type: BOOLEAN}`                              |
| `{type: "array", items: X}`                | `{type: ARRAY, items: recurse(X)}`             |
| `{type: "object", properties, required}`   | `{type: OBJECT, properties: recurse each, required}` |
| `{enum: [...], ...}`                       | preserve `enum`                                |
| `{description}`                            | preserve                                       |
| `{type: ["string", "null"]}`               | treat as `{type: "string"}`                    |
| `{anyOf: [...]}` / `{oneOf: [...]}`        | not representable → return `null` for that node |
| Unknown / missing type                     | return `null`                                  |

At the *object property* level, a `null` conversion means "skip this property and log a warning." At the top level, a `null` conversion means the whole tool becomes parameter-less (empty object).

### Error paths

| When | Behavior |
|---|---|
| MCP connect fails at boot | Log warning, register `ibkr_unreachable` stub, bot keeps booting |
| `listTools` throws | Same as connect fail — log, stub fallback |
| `callTool` throws at runtime | `ToolRegistry.dispatch` catches, returns `"Error in <name>: <msg>"` — existing pattern |
| Property schema has `anyOf` | Skip property, log warning, tool still registers with reduced params |
| Top-level schema unrepresentable | Register tool with empty-object params, log warning |

### Async boot

`buildDefaultRegistry` becomes async (was sync). Change in `gemma.ts`:
```typescript
const toolRegistry = await buildDefaultRegistry()
```
This is the only caller.

## Testing

`tests/tools/mcp-schema.test.ts` — pure unit tests, no network:

1. Primitive string → `{type: STRING}`
2. Integer → `{type: NUMBER}` (Gemini has no integer type)
3. Boolean, array of strings, array of objects
4. Nested object with required fields
5. Enum preserved
6. Description preserved
7. `{type: ["string", "null"]}` → `{type: STRING}` (null stripped)
8. `{anyOf: [...]}` → returns null
9. Missing `type` → returns null
10. Empty object schema → `{type: OBJECT, properties: {}}`

`tests/tools/registry.test.ts` — update the `buildDefaultRegistry` smoke test. It's currently synchronous and asserts `['search_memory', 'ibkr_briefing']`. After this change: await it, and expect `search_memory` + either the IBKR tool set (if the MCP server happens to be running during `npm test`) or the unreachable stub (the common case). Simplest: assert `search_memory` is first and at least one more tool exists.

No network-backed tests. The `ibkr-tools.ts` module is glue — manually smoke-tested via bot startup.

`tests/tools/ibkr-briefing.test.ts` is deleted along with the source file.

## Dependencies

Add `@modelcontextprotocol/sdk` to `package.json` dependencies. Version: whatever npm install resolves (pin after).

## Migration plan

1. `npm install @modelcontextprotocol/sdk`.
2. Create `src/tools/mcp-schema.ts` + tests. Land as its own commit.
3. Create `src/tools/mcp-client.ts`. Land.
4. Create `src/tools/ibkr-tools.ts` + `src/tools/ibkr-unreachable-stub.ts`. Land.
5. Update `src/tools/index.ts`: make `buildDefaultRegistry` async, register IBKR block, delete stub import. Land.
6. Delete `src/tools/ibkr-briefing.ts` and `tests/tools/ibkr-briefing.test.ts`. Land.
7. Update `src/gemma.ts`: await `buildDefaultRegistry()`. Land.
8. Update `tests/tools/registry.test.ts` smoke test for async + relaxed expectations. Land.
9. Run full suite; smoke-start if env available.

Each step is a commit. Tests green each step.

## Open questions resolved

- **URL default:** `http://127.0.0.1:8000/mcp`. Overridable via `IBKR_MCP_URL`.
- **Graceful degradation:** bot never crashes on IBKR-down. Stub fallback gives the model a reply.
- **Tool name collisions:** IBKR MCP tools don't share names with `search_memory`, so no collision-handling code needed beyond the existing `register()` throw.
- **Dashboard-flavored tools:** the IBKR MCP server also has custom REST routes for its dashboard. We don't touch those — only the MCP tools list matters.
