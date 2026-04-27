import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { runSummarization } from '../../src/summarization/summarizer.ts'

describe('runSummarization', () => {
  test('returns model output trimmed and lastMessageId of newest message', async () => {
    let capturedSystem = ''
    let capturedUser = ''
    const gemini = {
      completeText: async (sys: string, user: string) => {
        capturedSystem = sys
        capturedUser = user
        return '  the new summary text  '
      }
    }
    const out = await runSummarization(null, [
      { authorName: 'a', content: 'hi', timestamp: '2026-01-01T00:00:00Z', messageId: 'M1' },
      { authorName: 'b', content: 'yo', timestamp: '2026-01-01T00:01:00Z', messageId: 'M2' }
    ], gemini as any)
    assert.equal(out.summary, 'the new summary text')
    assert.equal(out.lastMessageId, 'M2')
    assert.match(capturedSystem, /summarizing a Discord channel/)
    assert.match(capturedUser, /hi/)
  })

  test('includes prior summary in user payload when present', async () => {
    let capturedUser = ''
    const gemini = {
      completeText: async (_sys: string, user: string) => { capturedUser = user; return 'updated' }
    }
    await runSummarization('OLD STORY', [
      { authorName: 'a', content: 'new', timestamp: '2026-01-02T00:00:00Z', messageId: 'M3' }
    ], gemini as any)
    assert.match(capturedUser, /PREVIOUS SUMMARY/)
    assert.match(capturedUser, /OLD STORY/)
    assert.match(capturedUser, /NEW MESSAGES/)
  })

  test('throws when newMessages is empty', async () => {
    const gemini = { completeText: async () => 'x' }
    await assert.rejects(() => runSummarization(null, [], gemini as any), /empty/)
  })

  test('formats messages with timestamp and author', async () => {
    let capturedUser = ''
    const gemini = {
      completeText: async (_sys: string, user: string) => { capturedUser = user; return 'x' }
    }
    await runSummarization(null, [
      { authorName: 'alice', content: 'first thing', timestamp: '2026-01-01T00:00:00Z', messageId: 'M1' }
    ], gemini as any)
    assert.match(capturedUser, /\[2026-01-01T00:00:00Z\] alice: first thing/)
  })
})
