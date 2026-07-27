import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveLiveUpdateInterval } from '../src/live-update.ts'
import { DEFAULT_LIVE_END_LINGER_MS } from '../src/tool-trace.ts'

test('live update interval keeps the gpt-style 1.5-second cadence', () => {
  assert.equal(resolveLiveUpdateInterval(undefined), 1500)
  assert.equal(resolveLiveUpdateInterval('8000'), 8000)
  assert.equal(resolveLiveUpdateInterval('nope'), 1500)
})

test('completed live thinking lingers for ten seconds by default', () => {
  assert.equal(DEFAULT_LIVE_END_LINGER_MS, 10_000)
})
