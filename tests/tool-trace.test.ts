import assert from 'node:assert/strict'
import test from 'node:test'

import {
  displayWidth,
  formatAggregateTraceMarker,
  renderTraceCards,
  TRACE_RESULT_PAYLOAD_MAX,
  TRACE_ROW_MAX,
  truncateDigest,
  truncateDisplayWidthClean,
} from '../src/tool-trace.ts'
import { agyToolDisplayName } from '../src/agy-chat.ts'

test('tool calls fit 87 columns and output payloads fit 84 columns', () => {
  assert.equal(TRACE_ROW_MAX, 87)
  assert.equal(TRACE_RESULT_PAYLOAD_MAX, 84)
  assert.equal(`+ ● shell(${'x'.repeat(TRACE_ROW_MAX - 11)})`.length, TRACE_ROW_MAX)
  assert.equal(`  ⎿ ${'x'.repeat(TRACE_RESULT_PAYLOAD_MAX)}`.length, 88)
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

test('full traces paginate every row instead of dropping overflow', () => {
  const lines = Array.from(
    { length: 60 },
    (_, i) => `+ ● shell(command-${i}-${'x '.repeat(32)})`,
  )
  const cards = renderTraceCards(lines, 'collapse')

  assert.ok(cards.length > 1)
  assert.match(cards[0], /command-0-/)
  assert.match(cards.at(-1) ?? '', /command-59-/)
  assert.doesNotMatch(cards.join('\n'), /earlier calls|more lines/)
  assert.ok(cards.every(card => card.length <= 2000))
})

test('live traces keep exactly one rolling code-block window', () => {
  const lines = Array.from(
    { length: 60 },
    (_, i) => `+ ● shell(command-${i}-${'x '.repeat(32)})`,
  )
  const cards = renderTraceCards(lines, 'live')

  assert.equal(cards.length, 1)
  assert.match(cards[0], /^🔧 \*\*Tool trace\*\*\n```diff/)
  assert.match(cards[0], /command-59-/)
  assert.doesNotMatch(cards[0], /command-0-/)
  assert.ok(cards[0].length <= 2000)
})
