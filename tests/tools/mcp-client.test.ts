import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { withReconnect } from '../../src/tools/mcp-client.ts'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'

// Build a fake MCP Client with controllable callTool behaviour.
function fakeClient(opts: {
  callTool?: (params: any) => Promise<any>
  close?: () => Promise<void>
} = {}): Client {
  return {
    callTool: opts.callTool ?? (async () => ({ content: [{ type: 'text', text: 'ok' }] })),
    listTools: async () => ({ tools: [] }),
    close: opts.close ?? (async () => {}),
  } as unknown as Client
}

describe('withReconnect', () => {
  test('forwards successful callTool result', async () => {
    const c = fakeClient({
      callTool: async () => ({ content: [{ type: 'text', text: 'result' }] }),
    })
    const wrapped = withReconnect(c, 'http://test/mcp')
    const res = await wrapped.callTool({ name: 'search', arguments: {} })
    assert.deepEqual(res, { content: [{ type: 'text', text: 'result' }] })
  })

  test('re-throws non-reconnect errors immediately', async () => {
    const c = fakeClient({
      callTool: async () => { throw new Error('tool returned bad data') },
    })
    const wrapped = withReconnect(c, 'http://test/mcp')
    await assert.rejects(() => wrapped.callTool({ name: 'search', arguments: {} }), /bad data/)
  })

  test('reconnects and retries on session-expiry errors', async () => {
    let callCount = 0
    const c = fakeClient({
      callTool: async () => {
        callCount++
        if (callCount === 1) throw new Error('session not found: session expired')
        return { content: [{ type: 'text', text: 'after reconnect' }] }
      },
    })
    let reconnected = false
    const freshClient = fakeClient({
      callTool: async () => {
        reconnected = true
        return { content: [{ type: 'text', text: 'fresh result' }] }
      },
    })
    const connector = async (_url: string) => freshClient
    const wrapped = withReconnect(c, 'http://test/mcp', connector)
    const res = await wrapped.callTool({ name: 'search', arguments: {} })
    assert.ok(reconnected, 'should have reconnected')
    assert.deepEqual(res, { content: [{ type: 'text', text: 'fresh result' }] })
  })

  test('subsequent calls after reconnect use fresh client', async () => {
    let failFirst = true
    const original = fakeClient({
      callTool: async () => {
        if (failFirst) { failFirst = false; throw new Error('ECONNRESET') }
        throw new Error('original should not be called after reconnect')
      },
    })
    const freshCalls: string[] = []
    const fresh = fakeClient({
      callTool: async (params: any) => {
        freshCalls.push(params.name)
        return { content: [{ type: 'text', text: 'fresh' }] }
      },
    })
    const wrapped = withReconnect(original, 'http://test/mcp', async () => fresh)
    // First call triggers reconnect, fresh handles the retry
    await wrapped.callTool({ name: 'tool_a', arguments: {} })
    // Second call — current is now fresh, so it goes directly without reconnect
    await wrapped.callTool({ name: 'tool_b', arguments: {} })
    assert.deepEqual(freshCalls, ['tool_a', 'tool_b'])
  })

  test('reconnect errors that match ECONNREFUSED also trigger reconnect', async () => {
    const c = fakeClient({
      callTool: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:8001') },
    })
    let reconnected = false
    const fresh = fakeClient({ callTool: async () => { reconnected = true; return { content: [] } } })
    const wrapped = withReconnect(c, 'http://test/mcp', async () => fresh)
    await wrapped.callTool({ name: 'ibkr_quote', arguments: {} })
    assert.ok(reconnected)
  })

  test('listTools and close forward to current client', async () => {
    let closed = false
    const c = fakeClient({ close: async () => { closed = true } })
    const wrapped = withReconnect(c, 'http://test/mcp')
    await wrapped.close()
    assert.ok(closed)
  })
})
