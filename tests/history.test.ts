import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { formatHistory, type HistoryMessage } from '../src/history.ts'

// Narrow a parts entry to the text variant so .text access typechecks.
// formatHistory always emits exactly one text part as parts[0]; the fileData
// variants come from cached attachments which these tests don't exercise.
function textOf(part: { text: string } | { fileData: { mimeType: string, fileUri: string } }): string {
  if (!('text' in part)) throw new Error('expected text part, got fileData')
  return part.text
}

describe('formatHistory', () => {
  const SELF = 'bot-id-gemma'

  test('empty history returns empty array', () => {
    assert.deepEqual(formatHistory([], SELF), [])
  })

  test('formats user and bot messages with correct roles', () => {
    const msgs: HistoryMessage[] = [
      { id: 'm1', authorId: 'U1', authorName: 'Alice', content: 'hello', attachments: [] },
      { id: 'm2', authorId: SELF, authorName: 'Gemma', content: 'hi there', attachments: [] },
      { id: 'm3', authorId: 'U1', authorName: 'Alice', content: 'how are you', attachments: [] }
    ]
    const result = formatHistory(msgs, SELF)
    assert.equal(result.length, 3)
    assert.equal(result[0].role, 'user')
    assert.equal(textOf(result[0].parts[0]), 'Alice: hello')
    assert.equal(result[1].role, 'model')
    assert.equal(textOf(result[1].parts[0]), 'hi there')
    assert.equal(result[2].role, 'user')
    assert.equal(textOf(result[2].parts[0]), 'Alice: how are you')
  })

  test('references attachments in text without uploading', () => {
    const msgs: HistoryMessage[] = [
      {
        id: 'm1',
        authorId: 'U1',
        authorName: 'Alice',
        content: 'check this out',
        attachments: [{ name: 'chart.png', url: 'https://cdn.example/chart.png', mimeType: 'image/png' }]
      }
    ]
    const result = formatHistory(msgs, SELF)
    assert.equal(textOf(result[0].parts[0]), 'Alice: check this out [previous image: chart.png]')
  })

  test('handles message with only attachment (no text)', () => {
    const msgs: HistoryMessage[] = [
      {
        id: 'm1',
        authorId: 'U1',
        authorName: 'Alice',
        content: '',
        attachments: [{ name: 'clip.mp4', url: 'https://cdn.example/clip.mp4', mimeType: 'video/mp4' }]
      }
    ]
    const result = formatHistory(msgs, SELF)
    assert.equal(textOf(result[0].parts[0]), 'Alice: [previous video: clip.mp4]')
  })

  test('handles multiple attachments', () => {
    const msgs: HistoryMessage[] = [
      {
        id: 'm1',
        authorId: 'U1',
        authorName: 'Alice',
        content: 'screenshots',
        attachments: [
          { name: 'a.png', url: 'https://cdn.example/a.png', mimeType: 'image/png' },
          { name: 'b.png', url: 'https://cdn.example/b.png', mimeType: 'image/png' }
        ]
      }
    ]
    const result = formatHistory(msgs, SELF)
    assert.equal(
      textOf(result[0].parts[0]),
      'Alice: screenshots [previous image: a.png] [previous image: b.png]'
    )
  })
})
