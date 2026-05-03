import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { GeminiCacheManager } from '../src/cache.ts'

// Mock the GoogleGenAI client surface — only `caches.create` is touched. We
// drive (re)usability of caches by hashed key, not by talking to the API.
function makeFakeClient(opts: { name?: string, fail?: boolean } = {}): any {
  const created: any[] = []
  const client = {
    caches: {
      create: async (req: any) => {
        if (opts.fail) throw new Error('boom')
        created.push(req)
        return { name: opts.name ?? `cachedContents/abc${created.length}` }
      }
    },
    _created: created
  }
  return client
}

// 4096+ tokens by char/4 estimate — long enough to clear gemini-3-pro-preview's
// minimum so the cache path isn't short-circuited.
const LONG_PREFIX = 'x'.repeat(20000)

describe('GeminiCacheManager', () => {
  test('returns null below model min token threshold', async () => {
    const mgr = new GeminiCacheManager()
    const client = makeFakeClient()
    // 100 chars / 4 = 25 tokens, well below 4096 floor for pro
    const out = await mgr.getOrCreate(client, 'gemini-3-pro-preview', 'short', [], {})
    assert.equal(out, null)
    assert.equal(client._created.length, 0)
  })

  test('returns null for unknown models without calling create', async () => {
    const mgr = new GeminiCacheManager()
    const client = makeFakeClient()
    const out = await mgr.getOrCreate(client, 'gemini-4-fictional', LONG_PREFIX, [], {})
    assert.equal(out, null)
    assert.equal(client._created.length, 0)
  })

  test('creates on first call, reuses on second (same key)', async () => {
    const mgr = new GeminiCacheManager()
    const client = makeFakeClient({ name: 'cachedContents/xyz' })
    const a = await mgr.getOrCreate(client, 'gemini-3-pro-preview', LONG_PREFIX, [], {})
    const b = await mgr.getOrCreate(client, 'gemini-3-pro-preview', LONG_PREFIX, [], {})
    assert.equal(a, 'cachedContents/xyz')
    assert.equal(b, 'cachedContents/xyz')
    assert.equal(client._created.length, 1)
  })

  test('different systemText hashes produce separate caches', async () => {
    const mgr = new GeminiCacheManager()
    const client = makeFakeClient()
    const a = await mgr.getOrCreate(client, 'gemini-3-pro-preview', LONG_PREFIX, [], {})
    const b = await mgr.getOrCreate(client, 'gemini-3-pro-preview', LONG_PREFIX + 'extra', [], {})
    assert.notEqual(a, b)
    assert.equal(client._created.length, 2)
  })

  test('records hit count and last-used timestamp', async () => {
    const mgr = new GeminiCacheManager()
    const client = makeFakeClient()
    await mgr.getOrCreate(client, 'gemini-3-pro-preview', LONG_PREFIX, [], {})
    await mgr.getOrCreate(client, 'gemini-3-pro-preview', LONG_PREFIX, [], {})
    await mgr.getOrCreate(client, 'gemini-3-pro-preview', LONG_PREFIX, [], {})
    const list = mgr.list()
    assert.equal(list.length, 1)
    // 1 create + 2 hits
    assert.equal(list[0].hitCount, 2)
  })

  test('recordCachedTokens backfills the actual billed size', async () => {
    const mgr = new GeminiCacheManager()
    const client = makeFakeClient({ name: 'cachedContents/m1' })
    await mgr.getOrCreate(client, 'gemini-3-pro-preview', LONG_PREFIX, [], {})
    mgr.recordCachedTokens('cachedContents/m1', 4321)
    const list = mgr.list()
    assert.equal(list[0].cachedTokens, 4321)
  })

  test('passes ttlSec through to caches.create', async () => {
    const mgr = new GeminiCacheManager()
    const client = makeFakeClient()
    await mgr.getOrCreate(client, 'gemini-3-pro-preview', LONG_PREFIX, [], {}, 12345)
    assert.equal(client._created.length, 1)
    assert.equal(client._created[0].config.ttl, '12345s')
  })

  test('fails open on api error', async () => {
    const mgr = new GeminiCacheManager()
    const client = makeFakeClient({ fail: true })
    const out = await mgr.getOrCreate(client, 'gemini-3-pro-preview', LONG_PREFIX, [], {})
    assert.equal(out, null)
  })

  test('clear drops all entries', async () => {
    const mgr = new GeminiCacheManager()
    const client = makeFakeClient()
    await mgr.getOrCreate(client, 'gemini-3-pro-preview', LONG_PREFIX, [], {})
    assert.equal(mgr.list().length, 1)
    mgr.clear()
    assert.equal(mgr.list().length, 0)
  })

  test('default TTL is exposed for /gemini cache info', () => {
    const ttl = GeminiCacheManager.defaultTtlSec()
    assert.equal(typeof ttl, 'number')
    assert.ok(ttl >= 60, 'default TTL should be at least 60s')
  })
})
