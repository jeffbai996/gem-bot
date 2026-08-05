import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  formatPinContext, formatReplyContext, formatThreadContext,
  resolvePinContext, resolveReplyContext, resolveThreadContext,
} from '../src/reply-context.ts'

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

  test('renders thread creation and starter system messages as useful context', async () => {
    const created = {
      id: 'system', type: 18, content: 'starter text', channelId: 'parent',
      reference: { channelId: 'thread' }, thread: { id: 'thread', name: 'project room', parentId: 'parent', appliedTags: ['tag-one'] },
      async fetchReference() { throw new Error('not a reply') },
    }
    assert.equal(await resolveReplyContext(created), null)
    assert.match(formatThreadContext(await resolveThreadContext(created)), /project room/)
    assert.match(formatThreadContext(await resolveThreadContext(created)), /tag-one/)

    const starter = {
      id: 'starter', type: 21, content: '', channelId: 'thread',
      channel: { name: 'project room', parentId: 'parent', appliedTags: ['tag-two'] }, reference: { messageId: 'source', channelId: 'parent' },
      async fetchReference() { return { id: 'source', author: { id: 'alice', username: 'alice', bot: false }, content: 'original idea', attachments: new Map([['x', { name: 'plan.pdf', url: 'https://example.invalid/plan.pdf', size: 55, contentType: 'application/pdf' }]]) } },
    }
    const context = await resolveThreadContext(starter)
    assert.match(formatThreadContext(context), /original idea/)
    assert.match(formatThreadContext(context), /tag-two/)
    assert.equal(context?.source?.attachments[0]?.name, 'plan.pdf')
  })
})
