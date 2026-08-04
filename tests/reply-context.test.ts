import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { formatPinContext, formatReplyContext, resolvePinContext, resolveReplyContext } from '../src/reply-context.ts'

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

  test('renders a pin system message with the pinned message body', async () => {
    const message = {
      type: 6,
      reference: { messageId: 'pinned' },
      async fetchReference() {
        return {
          id: 'pinned', author: { id: 'alice', username: 'alice', bot: false },
          content: 'pin this', attachments: new Map(),
        }
      },
    }
    assert.equal(await resolveReplyContext(message), null)
    assert.match(formatPinContext(await resolvePinContext(message)), /pin this/)
  })
})
