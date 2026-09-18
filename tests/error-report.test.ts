import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reportTurnError } from '../src/error-report.ts'

const card = (opts: { editThrows?: boolean } = {}) => {
  const calls: string[] = []
  return {
    calls,
    edit: async (text: string) => {
      calls.push('edit:' + text)
      if (opts.editThrows) throw new Error('Unknown Message')
      return undefined
    },
    delete: async () => { calls.push('delete'); return undefined },
  }
}

test('the error text replaces the thinking placeholder', async () => {
  const placeholder = card()
  const sent: string[] = []
  const out = await reportTurnError('⚠️ agy stopped', {
    active: [placeholder], send: async t => { sent.push(t) },
  })
  assert.equal(out.via, 'edited')
  assert.deepEqual(placeholder.calls, ['edit:⚠️ agy stopped'])
  assert.deepEqual(sent, [], 'no second message when the edit worked')
})

test('a failed edit still gets the error to the user', async () => {
  // The bug: `.edit(msg).catch(() => {})` swallowed this, so the turn showed
  // ❌ with no text at all (Jeff 2026-09-16).
  const placeholder = card({ editThrows: true })
  const sent: string[] = []
  const out = await reportTurnError('⚠️ agy stopped', {
    active: [placeholder], send: async t => { sent.push(t) },
  })
  assert.equal(out.via, 'sent')
  assert.equal(out.editFailed, true)
  assert.deepEqual(sent, ['⚠️ agy stopped'])
})

test('a card we could not write to is removed, not left frozen', async () => {
  const placeholder = card({ editThrows: true })
  await reportTurnError('boom', { active: [placeholder], send: async () => {} })
  assert.ok(placeholder.calls.includes('delete'),
    'a stranded "💭 Thinking…" is the same bug in a different hat')
})

test('with no placeholder it posts a new message', async () => {
  const sent: string[] = []
  const out = await reportTurnError('boom', { active: [], send: async t => { sent.push(t) } })
  assert.equal(out.via, 'sent')
  assert.deepEqual(sent, ['boom'])
})

test('extra chunks and trace cards are always cleared', async () => {
  const placeholder = card()
  const extra = card()
  const trace = card()
  await reportTurnError('boom', {
    active: [placeholder, extra], traces: [trace], send: async () => {},
  })
  assert.ok(extra.calls.includes('delete'))
  assert.ok(trace.calls.includes('delete'))
  assert.ok(!placeholder.calls.includes('delete'), 'the edited card stays; it IS the error')
})

test('a failed edit is reported, never swallowed', async () => {
  const logged: string[] = []
  await reportTurnError('boom', {
    active: [card({ editThrows: true })],
    send: async () => {},
    log: (m) => { logged.push(m) },
  })
  assert.equal(logged.length, 1)
  assert.match(logged[0], /edit failed/)
})

test('losing both routes is logged and never throws', async () => {
  const logged: string[] = []
  const out = await reportTurnError('boom', {
    active: [card({ editThrows: true })],
    send: async () => { throw new Error('missing permissions') },
    log: (m) => { logged.push(m) },
  })
  assert.equal(out.via, 'lost')
  assert.equal(logged.length, 2, 'the edit failure AND the send failure')
})

test('a delete that fails does not sink the report', async () => {
  const placeholder = card()
  const extra = {
    edit: async () => undefined,
    delete: async () => { throw new Error('Unknown Message') },
  }
  const out = await reportTurnError('boom', {
    active: [placeholder, extra], send: async () => {},
  })
  assert.equal(out.via, 'edited')
})
