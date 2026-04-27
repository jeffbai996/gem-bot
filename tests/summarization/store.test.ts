import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { SummaryStore } from '../../src/summarization/store.ts'

class FakeDb {
  data = new Map<string, any>()
  upsert = (id: string, summary: string, lastId: string) => {
    this.data.set(id, { channel_id: id, summary, last_summarized_message_id: lastId, updated_at: new Date().toISOString() })
  }
  get = (id: string) => this.data.get(id) ?? null
}

describe('SummaryStore', () => {
  test('get returns null when channel absent', () => {
    const fake = new FakeDb()
    const s = new SummaryStore({ getSummary: fake.get, upsertSummary: fake.upsert })
    assert.equal(s.get('nope'), null)
  })

  test('upsert + get round-trip', () => {
    const fake = new FakeDb()
    const s = new SummaryStore({ getSummary: fake.get, upsertSummary: fake.upsert })
    s.upsert('C1', 'a summary', 'M99')
    const got = s.get('C1')!
    assert.equal(got.channelId, 'C1')
    assert.equal(got.summary, 'a summary')
    assert.equal(got.lastSummarizedMessageId, 'M99')
    assert.ok(got.updatedAt)
  })

  test('upsert overwrites prior entry', () => {
    const fake = new FakeDb()
    const s = new SummaryStore({ getSummary: fake.get, upsertSummary: fake.upsert })
    s.upsert('C1', 'first', 'M1')
    s.upsert('C1', 'second', 'M2')
    assert.equal(s.get('C1')!.summary, 'second')
    assert.equal(s.get('C1')!.lastSummarizedMessageId, 'M2')
  })
})
