import { describe, test } from 'node:test'
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
  test('registers search_memory + fetch_url + IBKR tools (or fallback stub)', async () => {
    const r = await buildDefaultRegistry()
    const names = r.getDeclarations().map(d => d.name)
    assert.ok(names.length >= 3, `expected at least 3 tools, got ${names.length}`)
    assert.equal(names[0], 'search_memory')
    assert.equal(names[1], 'fetch_url')
    // Index 2+ is either the `ibkr_briefing` fallback stub (MCP down) or
    // 32 IBKR MCP tool names (MCP up). Don't hard-code.
    assert.ok(names.includes('fetch_url'))
  })
})
