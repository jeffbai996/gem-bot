import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { isAddressedToAnotherBot } from '../src/mention-gate.ts'

describe('isAddressedToAnotherBot', () => {
  test('rejects a message exclusively mentioning another bot', () => {
    assert.equal(isAddressedToAnotherBot('gemma', [{ id: 'gpt', bot: true }]), true)
  })

  test('allows a message mentioning Gemma', () => {
    assert.equal(isAddressedToAnotherBot('gemma', [{ id: 'gemma', bot: true }]), false)
  })

  test('allows a message mentioning Gemma and another bot', () => {
    assert.equal(isAddressedToAnotherBot('gemma', [
      { id: 'gemma', bot: true },
      { id: 'gpt', bot: true }
    ]), false)
  })

  test('does not treat a human-only mention as bot addressing', () => {
    assert.equal(isAddressedToAnotherBot('gemma', [{ id: 'jeff', bot: false }]), false)
  })
})
