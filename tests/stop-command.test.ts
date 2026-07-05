import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isHardStopMessage } from '../src/stop-command.ts'

test('hard stop recognizes lone X, x, and cancel emoji only', () => {
  assert.equal(isHardStopMessage('X'), true)
  assert.equal(isHardStopMessage('x'), true)
  assert.equal(isHardStopMessage('  X  '), true)
  assert.equal(isHardStopMessage('❌'), true)
  assert.equal(isHardStopMessage('❌️'), true)

  assert.equal(isHardStopMessage('x lol'), false)
  assert.equal(isHardStopMessage('text'), false)
  assert.equal(isHardStopMessage(''), false)
})
