import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { actionFor, REACTION_ACTIONS, isValidOutboundReactEmoji } from '../../src/reactions/vocabulary.ts'

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

describe('isValidOutboundReactEmoji', () => {
  test('accepts plain unicode emojis', () => {
    assert.equal(isValidOutboundReactEmoji('👍'), true)
    assert.equal(isValidOutboundReactEmoji('🤔'), true)
    assert.equal(isValidOutboundReactEmoji('✅'), true)
    assert.equal(isValidOutboundReactEmoji('❤'), true)
  })

  test('accepts emojis with variation selector (U+FE0F)', () => {
    assert.equal(isValidOutboundReactEmoji('✏️'), true)   // pencil + VS16
    assert.equal(isValidOutboundReactEmoji('❤️'), true)    // heart + VS16
  })

  test('accepts ZWJ sequences (multi-codepoint composed emojis)', () => {
    assert.equal(isValidOutboundReactEmoji('🏳️‍🌈'), true)         // pride flag
    assert.equal(isValidOutboundReactEmoji('👨‍👩‍👧‍👦'), true)  // family
  })

  test('rejects custom Discord emoji formats', () => {
    assert.equal(isValidOutboundReactEmoji('pack11_sticker_14'), false)
    assert.equal(isValidOutboundReactEmoji('green:1492450556277559326'), false)
    assert.equal(isValidOutboundReactEmoji(':smile:'), false)
    assert.equal(isValidOutboundReactEmoji('<:custom:123>'), false)
  })

  test('rejects multiple emojis or extra text', () => {
    assert.equal(isValidOutboundReactEmoji('👍👍'), false)
    assert.equal(isValidOutboundReactEmoji('👍 nice'), false)
    assert.equal(isValidOutboundReactEmoji('hi'), false)
  })

  test('rejects empty/null/undefined/non-string', () => {
    assert.equal(isValidOutboundReactEmoji(''), false)
    assert.equal(isValidOutboundReactEmoji(null), false)
    assert.equal(isValidOutboundReactEmoji(undefined), false)
    assert.equal(isValidOutboundReactEmoji(123), false)
    assert.equal(isValidOutboundReactEmoji({}), false)
  })
})
