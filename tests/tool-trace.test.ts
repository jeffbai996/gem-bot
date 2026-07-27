import assert from 'node:assert/strict'
import test from 'node:test'

import {
  TRACE_RESULT_PAYLOAD_MAX,
  TRACE_ROW_MAX,
} from '../src/tool-trace.ts'

test('tool trace rows fit the 76-column Discord fence', () => {
  assert.equal(TRACE_ROW_MAX, 76)
  assert.equal(`+ ● shell(${'x'.repeat(65)})`.length, TRACE_ROW_MAX)
  assert.equal(`  ⎿ ${'x'.repeat(TRACE_RESULT_PAYLOAD_MAX)}`.length, TRACE_ROW_MAX)
})
