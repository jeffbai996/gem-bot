import { describe, test, after } from 'node:test'
import assert from 'node:assert/strict'
import { Type } from '@google/genai'
import { ToolRegistry, type Tool, type ToolContext } from '../../src/tools/registry.ts'

function makeTool(name: string, executeImpl?: (args: any, ctx: ToolContext) => Promise<string>): Tool {
  return {
    name,
    declaration: {
      name,
      description: `test tool ${name}`,
      parameters: { type: Type.OBJECT, properties: {}, required: [] }
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
    const ctx: ToolContext = { channelId: 'C1', gemini: {} as any }
    await reg.dispatch('spy', { query: 'hello' }, ctx)
    assert.deepEqual(seenArgs, { query: 'hello' })
    assert.equal((seenCtx as ToolContext).channelId, 'C1')
  })
})

import { buildDefaultRegistry } from '../../src/tools/index.ts'

describe('buildDefaultRegistry', () => {
  // buildDefaultRegistry connects an MCP client (StreamableHTTP) to the IBKR
  // server when it's reachable. That transport keeps the event loop alive, so
  // node:test never exits unless we close it — the registry exposes close() for
  // exactly this. Without it the whole `npm test` run hangs on this file.
  let built: Awaited<ReturnType<typeof buildDefaultRegistry>> | null = null
  after(async () => { await built?.close() })

  test('registers search_memory + fetch_url + IBKR tools (or fallback stub)', async () => {
    const r = await buildDefaultRegistry()
    built = r
    const names = r.getDeclarations().map(d => d.name)
    assert.ok(names.length >= 3, `expected at least 3 tools, got ${names.length}`)
    // Assert membership, not position — the registry order shifts as squad-store
    // tools (search_squad_memory, read_squad_file) get added, and a positional
    // check (names[1] === 'fetch_url') goes stale every time. What matters is
    // that the core tools are all registered.
    assert.ok(names.includes('search_memory'), 'search_memory registered')
    assert.ok(names.includes('fetch_url'), 'fetch_url registered')
    // IBKR is either the `ibkr_briefing` fallback stub (MCP down) or the full
    // MCP tool set (MCP up) — assert the briefing surface exists either way.
    assert.ok(names.includes('ibkr_briefing'), 'ibkr_briefing registered')
  })
})
