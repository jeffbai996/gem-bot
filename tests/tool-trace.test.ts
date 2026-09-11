import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
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

test('tool calls fit 88 columns and output payloads fit 85 columns', () => {
  assert.equal(TRACE_ROW_MAX, 88)
  assert.equal(TRACE_RESULT_PAYLOAD_MAX, 85)
  assert.equal(`+ ● shell(${'x'.repeat(TRACE_ROW_MAX - 11)})`.length, TRACE_ROW_MAX)
  assert.equal(`  ⎿ ${'x'.repeat(TRACE_RESULT_PAYLOAD_MAX)}`.length, 89)
})

test('running tool calls do not spend trace width on synthetic ellipses', async () => {
  const source = await readFile(new URL('../src/gemma.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /call\.running\s*\?\s*['"]\.\.\.['"]/) // no synthetic live suffix
})

test('a truncated tool argument says it was truncated', () => {
  // Reverses fa9497f (2026-07-29), which stripped the ellipsis from argument
  // clips. Jeff 2026-09-10, on a trace row reading `find ... -name
  // "image-generation.`: "for calls that are too long, use … like the other
  // bots". A silent cut reads as a command that was genuinely that strange.
  // The mark comes out of the same budget, so no column moves.
  assert.equal(truncateDigest('abcdefgh', 5), 'abcd…')
  assert.equal(truncateDigest('abc', 5), 'abc')
  assert.equal(truncateDigest('abc', 0), '')
})

test('final tool-call row truncation does not restore an ellipsis', () => {
  const row = `+ ● Read(${'x'.repeat(TRACE_ROW_MAX)})`
  const rendered = truncateDisplayWidthClean(row, TRACE_ROW_MAX)
  assert.equal(displayWidth(rendered), TRACE_ROW_MAX)
  assert.ok(!rendered.endsWith('…'))
})

test('agy tool display marks a clipped argument', () => {
  const rendered = agyToolDisplayName('view_file', {
    AbsolutePath: `/tmp/${'x'.repeat(100)}`,
  })
  assert.match(rendered, /^Read\(.+…\)$/)
  // The whole row still fits the column it was budgeted for.
  assert.ok(rendered.length <= 62 + 'Read('.length)
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

test('tool traces preserve long technical identifiers', () => {
  const commit = '4e1b5741661d7854bd1bf8435d3f5f4e67da9012'
  const cards = renderTraceCards([
    `  ${commit} refs/heads/main`,
    '  userdata-5f52326e8f5b4f799ce388bc5d84d310.json.bak',
  ], 'on')
  const rendered = cards.join('\n')

  assert.match(rendered, new RegExp(commit))
  assert.match(rendered, /refs\/heads\/main/)
  assert.match(rendered, /userdata-5f52326e8f5b4f799ce388bc5d84d310/)
  assert.doesNotMatch(rendered, /<REDACTED>/)
})

test('tool traces redact PII and explicitly labelled credentials', () => {
  const ssn = ['123', '45', '6789'].join('-')
  const credential = ['sk', 'test_abcdefghijklmnopqrstuvwxyz123456'].join('-')
  const cards = renderTraceCards([
    '  contact user@example.com or 202-555-0147',
    `  ssn ${ssn}`,
    `  token=${credential}`,
  ], 'on')
  const rendered = cards.join('\n')

  assert.doesNotMatch(rendered, /user@example\.com|202-555-0147/)
  assert.ok(!rendered.includes(ssn))
  assert.ok(!rendered.includes(credential))
  assert.equal(rendered.match(/<REDACTED>/g)?.length, 4)
})
