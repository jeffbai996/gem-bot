import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { formatReplyContext, resolveReplyContext } from '../src/reply-context.ts'

describe('reply context', () => {
  test('includes referenced text and attachment metadata', async () => {
    const context = await resolveReplyContext({
      reference: { messageId: 'old' },
      async fetchReference() {
        return {
          id: 'old', author: { id: 'gem', username: 'gem', bot: true },
          content: 'old answer',
          attachments: new Map([['x', {
            name: 'image.png', url: 'https://example.invalid/image.png',
            size: 42, contentType: 'image/png',
          }]]),
        }
      },
    })
    assert.match(formatReplyContext(context), /old answer/)
    assert.match(formatReplyContext(context), /image\.png/)
  })

  test('returns null for a deleted reference', async () => {
    assert.equal(await resolveReplyContext({
      reference: { messageId: 'gone' },
      async fetchReference() { throw new Error('gone') },
    }), null)
  })
})
