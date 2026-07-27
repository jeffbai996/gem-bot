import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { extractPresenceDirective } from '../src/presence.ts'

describe('extractPresenceDirective', () => {
  test('extracts and strips a complete directive', () => {
    assert.deepEqual(
      extractPresenceDirective('status changed [[presence: 📡 waiting on gemini 4]]'),
      { reply: 'status changed', presence: '📡 waiting on gemini 4' },
    )
  })

  test('normalizes whitespace and caps Discord custom status length', () => {
    const longStatus = `🧪 ${'testing '.repeat(30)}`
    const result = extractPresenceDirective(`[[presence: ${longStatus}]]`)

    assert.equal(result.reply, '')
    assert.equal(result.presence?.length, 128)
    assert.ok(!result.presence?.includes('\n'))
  })

  test('uses the last directive and strips every directive', () => {
    assert.deepEqual(
      extractPresenceDirective('[[presence: 💤 old]]ready[[presence: ⚡ new]]'),
      { reply: 'ready', presence: '⚡ new' },
    )
  })

  test('hides an incomplete trailing directive while streaming', () => {
    assert.deepEqual(
      extractPresenceDirective('changing it now [[presence: 📡 wait'),
      { reply: 'changing it now', presence: null },
    )
  })

  test('passes ordinary replies through unchanged', () => {
    assert.deepEqual(
      extractPresenceDirective('nothing special here'),
      { reply: 'nothing special here', presence: null },
    )
  })
})
