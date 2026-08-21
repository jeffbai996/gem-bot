import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { selectTodos, formatTodos, listSquadTodosTool } from '../../src/tools/list-squad-todos.ts'

const DOCKET = [
  { id: 'aaa', text: 'ship the alert relay', status: 'open', priority: 'low', owner: '' },
  { id: 'bbb', text: 'fix the nightly sync', status: 'open', priority: 'high', owner: 'alice' },
  { id: 'ccc', text: 'flagged thing', status: 'open', priority: 'low', flag: true },
  { id: 'ddd', text: 'already shipped', status: 'done', priority: 'med', owner: 'bob' },
  { id: 'eee', title: '', text: '', note: 'no title, only a note', status: 'open' },
]

describe('selectTodos', () => {
  test('open is the default, so the docket is what is live', () => {
    const ids = selectTodos(DOCKET).map(t => t.id)
    assert.ok(!ids.includes('ddd'))
    assert.equal(ids.length, 4)
  })

  test('status all includes closed work', () => {
    assert.equal(selectTodos(DOCKET, { status: 'all' }).length, 5)
  })

  test('owner filter is exact, not substring', () => {
    assert.deepEqual(selectTodos(DOCKET, { owner: 'alice' }).map(t => t.id), ['bbb'])
    assert.deepEqual(selectTodos(DOCKET, { owner: 'ali' }).map(t => t.id), [])
  })

  test('q searches the title, note and owner', () => {
    assert.deepEqual(selectTodos(DOCKET, { q: 'nightly' }).map(t => t.id), ['bbb'])
    assert.deepEqual(selectTodos(DOCKET, { q: 'only a note' }).map(t => t.id), ['eee'])
    assert.deepEqual(selectTodos(DOCKET, { q: 'bob', status: 'all' }).map(t => t.id), ['ddd'])
  })

  test('flagged first, then priority — the top of the list is the top of the docket', () => {
    // 'eee' carries no priority and so ranks as med, which is the store's own
    // default — above 'aaa' at low. An entry nobody triaged is not the least
    // important thing on the docket.
    assert.deepEqual(selectTodos(DOCKET).map(t => t.id), ['ccc', 'bbb', 'eee', 'aaa'])
  })

  test('limit is clamped rather than trusted', () => {
    assert.equal(selectTodos(DOCKET, { limit: 1 }).length, 1)
    assert.equal(selectTodos(DOCKET, { limit: 0 }).length, 1)
    assert.equal(selectTodos(DOCKET, { limit: 9999 }).length, 4)
  })
})

describe('formatTodos', () => {
  test('an empty result says so instead of returning nothing', () => {
    assert.match(formatTodos([]), /No matching to-dos/)
  })

  test('a line carries the id, status and owner', () => {
    const line = formatTodos([DOCKET[1] as any])
    assert.match(line, /#bbb/)
    assert.match(line, /\[open\/high\]/)
    assert.match(line, /owner:alice/)
  })

  test('an entry with no title is labelled, not blank', () => {
    assert.match(formatTodos([DOCKET[4] as any]), /\(untitled\)/)
  })

  test('a long note is clipped so one entry cannot swallow the list', () => {
    const out = formatTodos([{ id: 'x', text: 't', note: 'y'.repeat(1000) } as any])
    assert.ok(out.length < 400, out.length)
    assert.match(out, /…/)
  })
})

describe('the tool itself', () => {
  test('is declared read-only in its description', () => {
    assert.match(listSquadTodosTool.declaration.description ?? '', /read-only/i)
  })

  test('requires no arguments — the bare docket is the common ask', () => {
    assert.deepEqual(listSquadTodosTool.declaration.parameters?.required, [])
  })

  test('a store that does not answer never reads as an empty docket', async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async () => { throw new Error('connection refused') }) as any
    try {
      const out = await listSquadTodosTool.execute({}, {} as any)
      assert.match(out, /error/i)
      assert.doesNotMatch(out, /No matching to-dos/)
    } finally {
      globalThis.fetch = original
    }
  })
})
