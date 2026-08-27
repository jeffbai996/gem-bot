import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describeAgyFailure } from '../src/agy-fallback-reason.ts'

test('a quota wall is named, with its reset window', () => {
  const raw = 'agy exited code 1: Error: Individual quota reached. Please upgrade '
    + 'your subscription to increase your limits. Resets in 30m10s.'
  assert.equal(describeAgyFailure(raw), 'antigravity quota exhausted, resets in 30m10s')
})

test('a quota wall without a reset window still says quota', () => {
  assert.equal(
    describeAgyFailure('Error: quota exceeded'),
    'antigravity quota exhausted',
  )
})

test('the idle watchdog reads as a timeout, not a mystery', () => {
  assert.equal(
    describeAgyFailure('agy idle watchdog fired after 98s'),
    'antigravity timed out',
  )
})

test('a missing binary is named', () => {
  assert.equal(
    describeAgyFailure('spawn failed: ENOENT'),
    'antigravity binary missing',
  )
})

test('an unknown failure shows a trimmed fragment rather than a guess', () => {
  const out = describeAgyFailure('something nobody has seen before')
  assert.match(out, /^antigravity failed: something nobody has seen before$/)
})

test('a very long unknown failure is truncated, not dropped', () => {
  const out = describeAgyFailure('x'.repeat(400))
  assert.ok(out.length < 120, out.length.toString())
  assert.ok(out.endsWith('…'))
})

test('an empty failure falls back to the old wording', () => {
  assert.equal(describeAgyFailure(''), 'antigravity unavailable')
})
