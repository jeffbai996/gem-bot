import assert from 'node:assert/strict'
import test from 'node:test'

import {
  displayWidth,
  TRACE_RESULT_PAYLOAD_MAX,
  TRACE_ROW_MAX,
  truncateDigest,
  truncateDisplayWidthClean,
} from '../src/tool-trace.ts'

test('tool trace rows fit the 80-column Discord fence', () => {
  assert.equal(TRACE_ROW_MAX, 80)
  assert.equal(`+ ● shell(${'x'.repeat(TRACE_ROW_MAX - 11)})`.length, TRACE_ROW_MAX)
  assert.equal(`  ⎿ ${'x'.repeat(TRACE_RESULT_PAYLOAD_MAX)}`.length, TRACE_ROW_MAX)
})

test('truncated tool arguments end cleanly without an ellipsis', () => {
  assert.equal(truncateDigest('abcdefgh', 5), 'abcde')
  assert.equal(truncateDigest('abc', 5), 'abc')
  assert.equal(truncateDigest('abc', 0), '')
})

test('final tool-call row truncation does not restore an ellipsis', () => {
  const row = `+ ● Read(${'x'.repeat(TRACE_ROW_MAX)})`
  const rendered = truncateDisplayWidthClean(row, TRACE_ROW_MAX)
  assert.equal(displayWidth(rendered), TRACE_ROW_MAX)
  assert.ok(!rendered.endsWith('…'))
})
