import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installLogTimestamps } from '../src/log-timestamps.ts'

test('every console line gains an ISO timestamp', () => {
  const seen: unknown[][] = []
  const original = console.error
  console.error = (...args: unknown[]) => { seen.push(args) }
  try {
    installLogTimestamps()
    console.error('[agy] warm-up ok')
  } finally {
    console.error = original
  }
  assert.equal(seen.length, 1)
  assert.match(String(seen[0][0]), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  assert.equal(seen[0][1], '[agy] warm-up ok')
})

test('installing twice does not wrap twice', () => {
  // The latch is module-level, so a second install must be a no-op. Assert on
  // the function identity rather than on output: by this point the shim is
  // already installed from the test above, and stubbing console.error to
  // observe it would replace the very wrapper under test.
  installLogTimestamps()
  const afterFirst = console.error
  installLogTimestamps()
  assert.equal(console.error, afterFirst, 'a second install re-wrapped console.error')
})
