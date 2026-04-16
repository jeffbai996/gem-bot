import { describe, test } from 'bun:test'
import assert from 'node:assert/strict'
import { formatHistory, type HistoryMessage } from '../src/history.ts'

describe('formatHistory', () => {
  const SELF = 'bot-id-gemma'

  test('empty history returns empty array', () => {
    assert.deepEqual(formatHistory([], SELF), [])
  })

  test('formats user and bot messages with correct roles', () => {
    const msgs: HistoryMessage[] = [
      { authorId: 'U1', authorName: 'Alice', content: 'hello', attachments: [] },
      { authorId: SELF, authorName: 'Gemma', content: 'hi there', attachments: [] },
      { authorId: 'U1', authorName: 'Alice', content: 'how are you', attachments: [] }
    ]
    const result = formatHistory(msgs, SELF)
    assert.equal(result.length, 3)
    assert.equal(result[0].role, 'user')
    assert.equal(result[0].parts[0].text, 'Alice: hello')
    assert.equal(result[1].role, 'model')
    assert.equal(result[1].parts[0].text, 'hi there')
    assert.equal(result[2].role, 'user')
    assert.equal(result[2].parts[0].text, 'Alice: how are you')
  })

  test('references attachments in text without uploading', () => {
    const msgs: HistoryMessage[] = [
      {
        authorId: 'U1',
        authorName: 'Alice',
        content: 'check this out',
        attachments: [{ name: 'chart.png', mimeType: 'image/png' }]
      }
    ]
    const result = formatHistory(msgs, SELF)
    assert.equal(result[0].parts[0].text, 'Alice: check this out [previous image: chart.png]')
  })

  test('handles message with only attachment (no text)', () => {
    const msgs: HistoryMessage[] = [
      {
        authorId: 'U1',
        authorName: 'Alice',
        content: '',
        attachments: [{ name: 'clip.mp4', mimeType: 'video/mp4' }]
      }
    ]
    const result = formatHistory(msgs, SELF)
    assert.equal(result[0].parts[0].text, 'Alice: [previous video: clip.mp4]')
  })

  test('handles multiple attachments', () => {
    const msgs: HistoryMessage[] = [
      {
        authorId: 'U1',
        authorName: 'Alice',
        content: 'screenshots',
        attachments: [
          { name: 'a.png', mimeType: 'image/png' },
          { name: 'b.png', mimeType: 'image/png' }
        ]
      }
    ]
    const result = formatHistory(msgs, SELF)
    assert.equal(
      result[0].parts[0].text,
      'Alice: screenshots [previous image: a.png] [previous image: b.png]'
    )
  })
})
