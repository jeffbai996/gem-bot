import test from 'node:test'
import assert from 'node:assert/strict'
import { TurnOutput } from '../src/turn-output.ts'
import { reportTurnError } from '../src/error-report.ts'

test('terminal error waits for stale edits and sends a receipt when their card vanished', async () => {
  const output = new TurnOutput()
  const messages: string[] = []
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  void output.run(async () => { await pending; messages.push('Thinking…') })
  const terminal = (async () => {
    await output.close()
    await reportTurnError('Connection failed', {
      active: [{ edit: async () => { throw new Error('Unknown Message') }, delete: async () => {} }],
      send: async text => { messages.push(text) },
    })
  })()
  await output.run(async () => { messages.push('late tool callback') })
  assert.deepEqual(messages, [])
  release()
  await terminal
  assert.deepEqual(messages, ['Thinking…', 'Connection failed'])
})

test('every overlapping write is drained, including a rejected write', async () => {
  const output = new TurnOutput()
  let release!: () => void
  let finished = false
  const pending = new Promise<void>(resolve => { release = resolve })
  const old = output.run(async () => { await pending; finished = true })
  await output.run(async () => { throw new Error('deleted') }).catch(() => {})
  const drain = output.close()
  assert.equal(finished, false)
  release()
  await drain
  await old
  assert.equal(finished, true)
})
