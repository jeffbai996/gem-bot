import { describe, test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { searchSquadMemoryTool } from '../../src/tools/search-squad-memory.ts'

// The tool talks to the squad-store HTTP API. We stub globalThis.fetch and
// assert (a) which URL each mode hits and (b) that the JSON shape is parsed.
const realFetch = globalThis.fetch
let lastUrl = ''

function stubFetch(handler: (url: string) => { status?: number; json: any }) {
  globalThis.fetch = (async (input: any) => {
    lastUrl = String(input)
    const { status = 200, json } = handler(lastUrl)
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 404 ? 'Not Found' : 'OK',
      json: async () => json,
    } as any
  }) as any
}

beforeEach(() => { lastUrl = '' })
afterEach(() => { globalThis.fetch = realFetch })

describe('search_squad_memory declaration', () => {
  test('all three args optional (query/recent/id), none required', () => {
    const params = searchSquadMemoryTool.declaration.parameters as any
    assert.deepEqual(params.required, [])
    assert.ok(params.properties.query)
    assert.ok(params.properties.recent)
    assert.ok(params.properties.id)
  })
})

describe('semantic query mode', () => {
  test('hits /api/recall with q= and renders the body', async () => {
    stubFetch(() => ({
      json: { ok: true, count: 1, entries: [{ id: 7, type: 'project', name: 'thing', text: 'body text here' }] },
    }))
    const out = await searchSquadMemoryTool.execute({ query: 'who is paul' }, {} as any)
    assert.match(lastUrl, /\/api\/recall\?q=who/)
    assert.doesNotMatch(lastUrl, /recent=1/)
    assert.match(out, /#7/)
    assert.match(out, /body text here/)
  })

  test('empty query with no other arg returns guidance', async () => {
    const out = await searchSquadMemoryTool.execute({}, {} as any)
    assert.match(out, /query|recent|id/i)
  })
})

describe('recent mode', () => {
  test('recent:true hits /api/recall?recent=1 and ignores query', async () => {
    stubFetch(() => ({
      json: { ok: true, source: 'recent', count: 2, entries: [
        { id: 198, type: 'project', name: 'newest', text: 'the latest thing' },
        { id: 197, type: 'project', name: 'older', text: 'prior thing' },
      ] },
    }))
    const out = await searchSquadMemoryTool.execute({ recent: true, query: 'ignored' }, {} as any)
    assert.match(lastUrl, /recent=1/)
    assert.match(out, /newest memories first/)
    assert.match(out, /#198/)
    assert.match(out, /#197/)
  })
})

describe('read-by-id mode', () => {
  test('numeric id hits /api/memory/<id> (not /api/files)', async () => {
    stubFetch(() => ({
      json: { ok: true, memory: { id: 198, type: 'project', name: 'm198', text: 'memory 198 body' } },
    }))
    const out = await searchSquadMemoryTool.execute({ id: 198 }, {} as any)
    assert.match(lastUrl, /\/api\/memory\/198/)
    assert.doesNotMatch(lastUrl, /\/api\/files/)
    assert.match(out, /#198/)
    assert.match(out, /memory 198 body/)
  })

  test('id takes precedence over query and recent', async () => {
    stubFetch(() => ({ json: { ok: true, memory: { id: 5, text: 'x' } } }))
    await searchSquadMemoryTool.execute({ id: 5, recent: true, query: 'q' }, {} as any)
    assert.match(lastUrl, /\/api\/memory\/5/)
  })

  test('404 on a missing memory id returns a clean not-found string', async () => {
    stubFetch(() => ({ status: 404, json: {} }))
    const out = await searchSquadMemoryTool.execute({ id: 999999 }, {} as any)
    assert.match(out, /No squad memory with id 999999/)
  })
})
