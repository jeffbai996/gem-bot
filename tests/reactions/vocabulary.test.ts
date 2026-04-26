import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { actionFor, REACTION_ACTIONS } from '../../src/reactions/vocabulary.ts'

describe('actionFor', () => {
  test('all 7 emojis map correctly', () => {
    assert.equal(actionFor('🔁'), 'regenerate')
    assert.equal(actionFor('🔍'), 'expand')
    assert.equal(actionFor('📌'), 'pin')
    assert.equal(actionFor('❌'), 'delete')
    assert.equal(actionFor('🔇'), 'mute')
    assert.equal(actionFor('🔊'), 'unmute')
    assert.equal(actionFor('✏️'), 'markForEdit')
  })

  test('unknown emoji returns null', () => {
    assert.equal(actionFor('🤣'), null)
    assert.equal(actionFor('🐻'), null)
    assert.equal(actionFor(''), null)
  })

  test('REACTION_ACTIONS has exactly 7 entries', () => {
    assert.equal(Object.keys(REACTION_ACTIONS).length, 7)
  })
})
