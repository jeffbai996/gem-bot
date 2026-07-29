import assert from 'node:assert/strict'
import test from 'node:test'

import {
  displayWidth,
  formatAggregateTraceMarker,
  TRACE_RESULT_PAYLOAD_MAX,
  TRACE_ROW_MAX,
  truncateDigest,
  truncateDisplayWidthClean,
} from '../src/tool-trace.ts'
import { agyToolDisplayName } from '../src/agy-chat.ts'

test('tool calls fit 84 columns and output payloads fit 76 columns', () => {
  assert.equal(TRACE_ROW_MAX, 84)
  assert.equal(TRACE_RESULT_PAYLOAD_MAX, 76)
  assert.equal(`+ ● shell(${'x'.repeat(TRACE_ROW_MAX - 11)})`.length, TRACE_ROW_MAX)
  assert.equal(`  ⎿ ${'x'.repeat(TRACE_RESULT_PAYLOAD_MAX)}`.length, 80)
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

test('agy tool display truncation does not bake in an ellipsis', () => {
  const rendered = agyToolDisplayName('view_file', {
    AbsolutePath: `/tmp/${'x'.repeat(100)}`,
  })
  assert.match(rendered, /^Read\(.+\)$/)
  assert.ok(!rendered.includes('…'))
})

test('aggregate call marker is not styled as a tool invocation', () => {
  assert.equal(formatAggregateTraceMarker(1), '…(+1 earlier call)')
  assert.equal(formatAggregateTraceMarker(28), '…(+28 earlier calls)')
})
