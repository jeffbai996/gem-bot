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
  assert.equal(activeTurns.canRequestBarge(c, started + BARGE_GRACE_MS + 10_000), true)
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
  activeTurns.done(c1)

  const c2 = cid()
  activeTurns.register(c2, () => {})
  assert.equal(activeTurns.stop(c2), true)
  assert.equal(activeTurns.consumeStopped(c2), true, 'user stop clears the queue')
  activeTurns.done(c2)
})

test('done() clears liveness so a finished turn can never be barged', () => {
  const c = cid()
  activeTurns.register(c, () => {})
  activeTurns.deferStopFor(c, { clearQueue: false })
  activeTurns.done(c)
  assert.equal(activeTurns.canBarge(c, Date.now() + 999_999), false)
  assert.equal(activeTurns.stopIfPending(c), false)
})

test('waitForIdle: resolves only after the last active turn ends', async () => {
  const c1 = cid()
  const c2 = cid()
  activeTurns.register(c1, () => {})
  activeTurns.register(c2, () => {})
  let resolved = false
  const p = activeTurns.waitForIdle().then(() => { resolved = true })
  activeTurns.done(c1)
  await Promise.resolve()
  assert.equal(resolved, false)
  activeTurns.done(c2)
  await p
  assert.equal(resolved, true)
})

test('waitForIdle: resolves immediately when already idle', async () => {
  await activeTurns.waitForIdle()
})

test('deferStopFor: records a pending barge without killing until boundary', () => {
  const c = cid()
  let killed = false
  activeTurns.register(c, () => { killed = true })
  assert.equal(activeTurns.deferStopFor(c, { clearQueue: false }), true)
  assert.equal(killed, false)
  assert.equal(activeTurns.isActive(c), true)
  assert.equal(activeTurns.stopIfPending(c), true)
  assert.equal(killed, true)
  assert.equal(activeTurns.isActive(c), true, 'teardown still owns the channel')
  assert.equal(activeTurns.consumeStopped(c), false, 'barge keeps the queue')
  activeTurns.done(c)
})

test('deferred barge waits for an active tool and fires when the tool ends', () => {
  const c = cid()
  let killed = false
  activeTurns.register(c, () => { killed = true })
  activeTurns.setBusy(c, 'shell')
  assert.equal(activeTurns.deferStopFor(c, { clearQueue: false }), true)
  assert.equal(activeTurns.stopIfPending(c), false, 'partial output is not safe mid-tool')
  assert.equal(killed, false)
  activeTurns.clearBusy(c)
  assert.equal(killed, true, 'tool completion is the safe steering boundary')
  assert.equal(activeTurns.consumeSteered(c) !== null, true)
  activeTurns.done(c)
})

test('aborting starts teardown but the turn remains active until done', () => {
  const c = cid()
  activeTurns.register(c, () => {})
  assert.equal(activeTurns.stopFor(c, { clearQueue: false }), true)
  assert.equal(activeTurns.isActive(c), true, 'abort is not the end of async teardown')
  activeTurns.done(c)
  assert.equal(activeTurns.isActive(c), false)
})

test('deferStopFor(clearQueue:true): pending user stop clears queue at boundary', () => {
  const c = cid()
  activeTurns.register(c, () => {})
  assert.equal(activeTurns.deferStopFor(c, { clearQueue: true }), true)
  assert.equal(activeTurns.consumeStopped(c), false, 'not stopped until boundary')
  assert.equal(activeTurns.stopIfPending(c), true)
  assert.equal(activeTurns.consumeStopped(c), true)
})

test('deferStopFor and stopIfPending: false when no turn is running or pending', () => {
  const c = cid()
  assert.equal(activeTurns.deferStopFor(c, { clearQueue: false }), false)
  assert.equal(activeTurns.stopIfPending(c), false)
})
