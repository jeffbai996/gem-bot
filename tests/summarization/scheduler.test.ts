import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { SummarizationScheduler } from '../../src/summarization/scheduler.ts'

class FakeStore {
  data = new Map<string, any>()
  get(channelId: string) { return this.data.get(channelId) ?? null }
  upsert(channelId: string, summary: string, lastId: string) {
    this.data.set(channelId, { channelId, summary, lastSummarizedMessageId: lastId, updatedAt: new Date().toISOString() })
  }
}

function gemini(returns: string) {
  return { completeText: async () => returns } as any
}

function makeMessages(ids: string[]) {
  return ids.map(id => ({ authorName: 'u', content: 'c', timestamp: '2026-01-01T00:00:00Z', messageId: id }))
}

async function settle(s: SummarizationScheduler, channelId: string) {
  await (s as any).inFlight.get(channelId)
}

describe('SummarizationScheduler', () => {
  test('below threshold does not upsert', async () => {
    const store = new FakeStore()
    let called = false
    const s = new SummarizationScheduler({
      store: store as any,
      fetchSinceForSummarization: async () => { called = true; return makeMessages(['M1']) },
      gemini: gemini('x'),
      threshold: 50
    })
    s.scheduleIfNeeded('C1')
    await settle(s, 'C1')
    assert.equal(called, true)
    assert.equal(store.get('C1'), null)
  })

  test('at threshold upserts', async () => {
    const store = new FakeStore()
    const s = new SummarizationScheduler({
      store: store as any,
      fetchSinceForSummarization: async () => makeMessages(Array.from({ length: 50 }, (_, i) => `M${i + 1}`)),
      gemini: gemini('summary text'),
      threshold: 50
    })
    s.scheduleIfNeeded('C1')
    await settle(s, 'C1')
    const got = store.get('C1')
    assert.equal(got.summary, 'summary text')
    assert.equal(got.lastSummarizedMessageId, 'M50')
  })

  test('concurrent calls dedupe per channel', async () => {
    let runs = 0
    const store = new FakeStore()
    let resolveFetch: ((v: any) => void) | null = null
    const fetchPromise = new Promise<any[]>(r => { resolveFetch = r })
    const s = new SummarizationScheduler({
      store: store as any,
      fetchSinceForSummarization: async () => { runs++; return fetchPromise },
      gemini: gemini('x'),
      threshold: 1
    })
    s.scheduleIfNeeded('C1')
    s.scheduleIfNeeded('C1')
    s.scheduleIfNeeded('C1')
    resolveFetch!(makeMessages(['M1']))
    await settle(s, 'C1')
    assert.equal(runs, 1)
  })

  test('different channels run independently', async () => {
    const store = new FakeStore()
    const calls: string[] = []
    const s = new SummarizationScheduler({
      store: store as any,
      fetchSinceForSummarization: async (cid) => { calls.push(cid); return makeMessages(['M1']) },
      gemini: gemini('x'),
      threshold: 1
    })
    s.scheduleIfNeeded('C1')
    s.scheduleIfNeeded('C2')
    await settle(s, 'C1')
    await settle(s, 'C2')
    assert.deepEqual(calls.sort(), ['C1', 'C2'])
  })

  test('after run completes, can run again', async () => {
    const store = new FakeStore()
    let runs = 0
    const s = new SummarizationScheduler({
      store: store as any,
      fetchSinceForSummarization: async () => { runs++; return makeMessages(['M1']) },
      gemini: gemini('x'),
      threshold: 1
    })
    s.scheduleIfNeeded('C1')
    await settle(s, 'C1')
    s.scheduleIfNeeded('C1')
    await settle(s, 'C1')
    assert.equal(runs, 2)
  })

  test('errors are caught and logged, do not propagate', async () => {
    const store = new FakeStore()
    const s = new SummarizationScheduler({
      store: store as any,
      fetchSinceForSummarization: async () => { throw new Error('db down') },
      gemini: gemini('x'),
      threshold: 1
    })
    // Must not throw
    s.scheduleIfNeeded('C1')
    await settle(s, 'C1')
    assert.equal(store.get('C1'), null)
  })
})
