import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { handleReaction } from '../../src/reactions/handler.ts'

function makeReaction(emoji: string, authorId: string, msgOpts: any = {}) {
  return {
    partial: false,
    emoji: { name: emoji },
    message: {
      author: { id: authorId },
      channelId: 'C1',
      id: 'M1',
      content: 'hi',
      channel: { name: 'general' },
      react: async () => {},
      delete: async () => {},
      fetchReference: async () => null,
      ...msgOpts
    },
    fetch: async () => {}
  } as any
}

const botUser = { id: 'BOT' }
const allowedUser = { id: 'U1', bot: false, partial: false } as any

const accessAllow = { canReact: () => true }
const accessDeny = { canReact: () => false }

describe('handleReaction', () => {
  test('non-bot message → ignored', async () => {
    let called = false
    const reaction = makeReaction('🔁', 'someone-else')
    reaction.message.fetchReference = async () => { called = true; return null }
    await handleReaction(reaction, allowedUser, {
      client: { user: botUser } as any,
      buildContext: () => ({} as any),
      access: accessAllow
    })
    assert.equal(called, false)
  })

  test('disallowed user → ignored', async () => {
    let called = false
    const reaction = makeReaction('🔁', botUser.id)
    reaction.message.fetchReference = async () => { called = true; return null }
    await handleReaction(reaction, allowedUser, {
      client: { user: botUser } as any,
      buildContext: () => ({} as any),
      access: accessDeny
    })
    assert.equal(called, false)
  })

  test('unknown emoji → ignored', async () => {
    let called = false
    const reaction = makeReaction('🤣', botUser.id)
    reaction.message.fetchReference = async () => { called = true; return null }
    await handleReaction(reaction, allowedUser, {
      client: { user: botUser } as any,
      buildContext: () => ({} as any),
      access: accessAllow
    })
    assert.equal(called, false)
  })

  test('bot reactor → ignored', async () => {
    let called = false
    const reaction = makeReaction('🔁', botUser.id)
    reaction.message.fetchReference = async () => { called = true; return null }
    const botReactor = { id: 'B', bot: true, partial: false } as any
    await handleReaction(reaction, botReactor, {
      client: { user: botUser } as any,
      buildContext: () => ({} as any),
      access: accessAllow
    })
    assert.equal(called, false)
  })

  test('valid bot-message + allowed user + 📌 → pin runs', async () => {
    const reactionsAdded: string[] = []
    const reaction = makeReaction('📌', botUser.id, {
      react: async (e: string) => { reactionsAdded.push(e) }
    })
    let appendedContent = ''
    const ctx = {
      message: reaction.message,
      pinnedFacts: { append: async (_c: string, _n: string, content: string) => { appendedContent = content } }
    } as any
    await handleReaction(reaction, allowedUser, {
      client: { user: botUser } as any,
      buildContext: () => ctx,
      access: accessAllow
    })
    assert.equal(appendedContent, 'hi')
    assert.deepEqual(reactionsAdded, ['✅'])
  })

  test('action throw is caught, not propagated', async () => {
    const reaction = makeReaction('❌', botUser.id, {
      delete: async () => { throw new Error('no perms') }
    })
    // Should resolve cleanly without throwing
    await handleReaction(reaction, allowedUser, {
      client: { user: botUser } as any,
      buildContext: () => ({ message: reaction.message } as any),
      access: accessAllow
    })
  })
})
