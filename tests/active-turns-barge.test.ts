import { test } from 'node:test'
import assert from 'node:assert/strict'
import { activeTurns, BARGE_GRACE_MS } from '../src/active-turns.ts'

// Barge guard (Jeff 2026-07-01). gem-bot leans on the grace window alone (its tools
// run in Google's sandbox, no local-FS "unsafe for code" case), but the setBusy hooks
// exist for parity with gpt-bot and are covered here too. Unique channel id per test
// isolates per-channel state; `canBarge(cid, now)` takes an explicit clock.

let n = 0
const cid = () => `gem-barge-test-${n++}`

test('canBarge: false when no turn is active', () => {
  assert.equal(activeTurns.canBarge(cid()), false)
})

test('canBarge: false inside the grace window, true after it', () => {
  const c = cid()
  activeTurns.register(c, () => {})
  const started = Date.now()
  assert.equal(activeTurns.canBarge(c, started + BARGE_GRACE_MS - 1), false, 'just under grace')
  assert.equal(activeTurns.canBarge(c, started + BARGE_GRACE_MS), true, 'at grace boundary')
  activeTurns.done(c)
})

test('canBarge: setBusy blocks a barge even past grace (parity hook)', () => {
  const c = cid()
  activeTurns.register(c, () => {})
  const started = Date.now()
  activeTurns.setBusy(c, 'shell')
  assert.equal(activeTurns.canBarge(c, started + BARGE_GRACE_MS + 10_000), false)
  activeTurns.clearBusy(c)
  assert.equal(activeTurns.canBarge(c, started + BARGE_GRACE_MS + 10_000), true)
  activeTurns.done(c)
})

test('stopFor(clearQueue:false) kills without marking stopped; stop() marks stopped', () => {
  const c1 = cid()
  let killed = false
  activeTurns.register(c1, () => { killed = true })
  assert.equal(activeTurns.stopFor(c1, { clearQueue: false }), true)
  assert.equal(killed, true, 'killer fired')
  assert.equal(activeTurns.consumeStopped(c1), false, 'barge keeps the queue')

  const c2 = cid()
  activeTurns.register(c2, () => {})
  assert.equal(activeTurns.stop(c2), true)
  assert.equal(activeTurns.consumeStopped(c2), true, 'user stop clears the queue')
})

test('done() clears liveness so a finished turn can never be barged', () => {
  const c = cid()
  activeTurns.register(c, () => {})
  activeTurns.done(c)
  assert.equal(activeTurns.canBarge(c, Date.now() + 999_999), false)
})
