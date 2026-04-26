import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { PendingEditsStore } from '../../src/reactions/pending-edits.ts'

describe('PendingEditsStore', () => {
  test('set + get returns the bot message id', () => {
    const s = new PendingEditsStore()
    s.set('C1', 'M1', 60_000)
    assert.equal(s.get('C1'), 'M1')
  })

  test('get after ttl expiry returns null', () => {
    const s = new PendingEditsStore()
    s.set('C1', 'M1', -1)
    assert.equal(s.get('C1'), null)
  })

  test('expired entry is removed lazily', () => {
    const s = new PendingEditsStore()
    s.set('C1', 'M1', -1)
    s.get('C1')
    s.set('C1', 'M2', 60_000)
    assert.equal(s.get('C1'), 'M2')
  })

  test('clear removes entry', () => {
    const s = new PendingEditsStore()
    s.set('C1', 'M1', 60_000)
    s.clear('C1')
    assert.equal(s.get('C1'), null)
  })

  test('different channels are independent', () => {
    const s = new PendingEditsStore()
    s.set('C1', 'M1', 60_000)
    s.set('C2', 'M2', 60_000)
    assert.equal(s.get('C1'), 'M1')
    assert.equal(s.get('C2'), 'M2')
  })

  test('get on never-set channel returns null', () => {
    const s = new PendingEditsStore()
    assert.equal(s.get('nope'), null)
  })
})
