import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  LiveProgressBuffer,
  liveProgressDwellMs,
  resolveLiveUpdateInterval,
} from '../src/live-update.ts'
import { DEFAULT_LIVE_END_LINGER_MS } from '../src/tool-trace.ts'

test('live update interval keeps the gpt-style 1.5-second cadence', () => {
  assert.equal(resolveLiveUpdateInterval(undefined), 1500)
  assert.equal(resolveLiveUpdateInterval('8000'), 8000)
  assert.equal(resolveLiveUpdateInterval('nope'), 1500)
})

test('completed live thinking lingers for ten seconds by default', () => {
  assert.equal(DEFAULT_LIVE_END_LINGER_MS, 10_000)
})

test('public action narration gets paragraph-scale read time', () => {
  assert.equal(liveProgressDwellMs('short status'), 0)
  assert.equal(liveProgressDwellMs('first line\nsecond line'), 10_000)
  assert.equal(liveProgressDwellMs('word '.repeat(50)), 15_000)
  assert.equal(liveProgressDwellMs('word '.repeat(100)), 30_000)
})

test('live progress coalesces updates while the visible paragraph dwells', () => {
  const progress = new LiveProgressBuffer()
  progress.push('first line\nsecond line', 1_000)
  progress.push('intermediate replacement\nstill working', 5_000)
  progress.push('latest replacement\nstill working', 8_000)

  assert.equal(progress.value(9_000), 'first line\nsecond line')
  assert.equal(progress.value(11_000), 'latest replacement\nstill working')
})
