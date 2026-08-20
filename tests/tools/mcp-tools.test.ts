import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { loadMcpTools, isMutatingTool } from '../../src/tools/mcp-tools.ts'

// A stand-in for an MCP Client: only listTools/callTool are exercised.
function fakeClient(names: string[]) {
  const calls: { name: string; args: unknown }[] = []
  return {
    calls,
    async listTools() {
      return { tools: names.map(n => ({ name: n, description: `does ${n}`, inputSchema: undefined })) }
    },
    async callTool({ name, arguments: args }: any) {
      calls.push({ name, args })
      return { content: [{ type: 'text', text: `ran ${name}` }] }
    }
  } as any
}

const VECGREP = [
  'search', 'timeline', 'incident', 'browse', 'get_source', 'related',
  'write', 'edit', 'propose_write', 'propose_edit', 'propose_delete', 'propose_merge'
]

describe('isMutatingTool', () => {
  test('flags the writers', () => {
    for (const n of ['write', 'edit', 'propose_write', 'propose_delete', 'propose_merge'])
      assert.equal(isMutatingTool(n), true, n)
  })
  test('leaves the readers alone', () => {
    for (const n of ['search', 'timeline', 'incident', 'browse', 'get_source',
                     'related', 'stats', 'list_corpora', 'summarize_corpus'])
      assert.equal(isMutatingTool(n), false, n)
  })
  test('does not match a reader that merely contains a verb', () => {
    // 'rewrite_history' would be mutating, but 'get_written_by' is a read.
    assert.equal(isMutatingTool('get_written_by'), false)
  })
})

describe('loadMcpTools', () => {
  test('wraps every tool when no filter is given', async () => {
    const tools = await loadMcpTools(fakeClient(VECGREP))
    assert.equal(tools.length, VECGREP.length)
  })

  test('skip keeps the writers OUT of the registry entirely', async () => {
    const tools = await loadMcpTools(fakeClient(VECGREP), { skip: isMutatingTool })
    const names = tools.map(t => t.name)
    assert.deepEqual(names, ['search', 'timeline', 'incident', 'browse', 'get_source', 'related'])
    // The point of filtering at load rather than dispatch: an unregistered
    // tool cannot be invoked at all, so a prompt-injected call has nothing
    // to reach.
    for (const w of ['write', 'propose_delete']) assert.ok(!names.includes(w), w)
  })

  test('a wrapped tool forwards to callTool and returns its text', async () => {
    const c = fakeClient(['search'])
    const [tool] = await loadMcpTools(c)
    const out = await tool.execute({ q: 'ben' }, {} as any)
    assert.equal(out, 'ran search')
    assert.deepEqual(c.calls, [{ name: 'search', args: { q: 'ben' } }])
  })

  test('an empty response says so rather than returning nothing', async () => {
    const c = fakeClient(['search'])
    c.callTool = async () => ({ content: [] })
    const [tool] = await loadMcpTools(c)
    assert.equal(await tool.execute({}, {} as any), '[empty response]')
  })

  test('declarations carry a description Gemini can read', async () => {
    const [tool] = await loadMcpTools(fakeClient(['search']))
    assert.equal(tool.declaration.name, 'search')
    assert.match(tool.declaration.description ?? '', /does search/)
  })
})
