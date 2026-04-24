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
    const ctx: ToolContext = { channelId: 'C1', gemini: {} as any }
    await reg.dispatch('spy', { query: 'hello' }, ctx)
    assert.deepEqual(seenArgs, { query: 'hello' })
    assert.equal((seenCtx as ToolContext).channelId, 'C1')
  })
})

import { buildDefaultRegistry } from '../../src/tools/index.ts'

describe('buildDefaultRegistry', () => {
  test('registers search_memory first; IBKR tools or fallback stub second', async () => {
    const r = await buildDefaultRegistry()
    const names = r.getDeclarations().map(d => d.name)
    assert.ok(names.length >= 2, `expected at least 2 tools, got ${names.length}`)
    assert.equal(names[0], 'search_memory')
    // Second slot is either the fallback `ibkr_briefing` stub (MCP down) or
    // one of 32 IBKR MCP tool names (MCP up). Don't hard-code the list.
  })
})
