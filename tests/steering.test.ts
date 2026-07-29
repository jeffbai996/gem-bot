import assert from 'node:assert/strict'
import test from 'node:test'
import { renderSteeredMessage, steeredMarker } from '../src/steering.ts'
import { displayWidth, TRACE_ROW_MAX, truncateDisplayWidth } from '../src/tool-trace.ts'

test('formats steering and caps wide trace text', () => {
  assert.equal(steeredMarker(5_000), '↪ **Steered after 5s**')
  assert.equal(
    renderSteeredMessage('💭 **Thinking...**\nChecking the queue.', 5_000),
    '↪ **Steered after 5s**\nChecking the queue.',
  )
  const line = truncateDisplayWidth('a'.repeat(TRACE_ROW_MAX - 3) + '中文', TRACE_ROW_MAX)
  assert.equal(displayWidth(line), TRACE_ROW_MAX)
})
