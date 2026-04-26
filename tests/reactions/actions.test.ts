import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { pin, deleteMessage, mute, unmute, markForEdit, regenerate, expand } from '../../src/reactions/actions.ts'
import { PendingEditsStore } from '../../src/reactions/pending-edits.ts'
import { PinnedFactsStore } from '../../src/pinned-facts.ts'

function makeMessage(overrides: Record<string, any> = {}): any {
  const reactionsAdded: string[] = []
  const m: any = {
    channelId: 'C1',
    id: 'M1',
    content: 'hello',
    channel: { name: 'general' },
    reactionsAdded,
    react: async (emoji: string) => { reactionsAdded.push(emoji); return null },
    delete: async () => { m.deleted = true },
    fetchReference: async () => overrides.fetchReferenceResult ?? null,
    deleted: false,
    ...overrides
  }
  return m
}

function makeAccess() {
  const calls: any[] = []
  return {
    calls,
    channelFlags: () => ({ thinking: 'auto', showCode: false }),
    setChannel: async (channelId: string, enabled: boolean, requireMention: boolean, flags: any) => {
      calls.push({ channelId, enabled, requireMention, flags })
    }
  } as any
}

async function tmpFactsFile() {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'actions-test-'))
  return path.join(d, 'pinned.md')
}

describe('pin', () => {
  test('appends to pinned facts and reacts ✅', async () => {
    const file = await tmpFactsFile()
    const facts = new PinnedFactsStore(file)
    const message = makeMessage({ content: 'pinned content' })
    await pin({ message, pinnedFacts: facts } as any)
    const got = await facts.readForChannel('C1')
    assert.equal(got.length, 1)
    assert.equal(got[0].content, 'pinned content')
    assert.deepEqual(message.reactionsAdded, ['✅'])
  })
})

describe('deleteMessage', () => {
  test('calls message.delete', async () => {
    const message = makeMessage()
    await deleteMessage({ message } as any)
    assert.equal(message.deleted, true)
  })

  test('swallows delete errors', async () => {
    const message = makeMessage({ delete: async () => { throw new Error('no perms') } })
    await deleteMessage({ message } as any)  // must not throw
  })
})

describe('mute', () => {
  test('calls setChannel with requireMention=true', async () => {
    const access = makeAccess()
    const message = makeMessage()
    await mute({ message, access } as any)
    assert.equal(access.calls.length, 1)
    assert.equal(access.calls[0].requireMention, true)
    assert.deepEqual(message.reactionsAdded, ['🤐'])
  })
})

describe('unmute', () => {
  test('calls setChannel with requireMention=false', async () => {
    const access = makeAccess()
    const message = makeMessage()
    await unmute({ message, access } as any)
    assert.equal(access.calls.length, 1)
    assert.equal(access.calls[0].requireMention, false)
    assert.deepEqual(message.reactionsAdded, ['🗣️'])
  })
})

describe('markForEdit', () => {
  test('writes pending-edits entry and reacts ⏳', async () => {
    const pendingEdits = new PendingEditsStore()
    const message = makeMessage()
    await markForEdit({ message, pendingEdits } as any)
    assert.equal(pendingEdits.get('C1'), 'M1')
    assert.deepEqual(message.reactionsAdded, ['⏳'])
  })
})

describe('regenerate', () => {
  test('no reference → reacts 🤷, no rerun', async () => {
    const message = makeMessage({ fetchReferenceResult: null })
    let rerunCalled = false
    const ctx = { message, rerunHandler: async () => { rerunCalled = true } } as any
    await regenerate(ctx)
    assert.equal(rerunCalled, false)
    assert.deepEqual(message.reactionsAdded, ['🤷'])
  })

  test('with reference → calls rerunHandler with target=message, expansion=false', async () => {
    const ref = { id: 'U1', content: 'original' }
    const message = makeMessage({ fetchReferenceResult: ref })
    let captured: any = null
    const ctx = {
      message,
      rerunHandler: async (orig: any, target: any, expansion: any) => {
        captured = { orig, target, expansion }
      }
    } as any
    await regenerate(ctx)
    assert.equal(captured.orig, ref)
    assert.equal(captured.target, message)
    assert.equal(captured.expansion, false)
  })
})

describe('expand', () => {
  test('with reference → rerunHandler with target=null, expansion=true', async () => {
    const ref = { id: 'U1', content: 'original' }
    const message = makeMessage({ fetchReferenceResult: ref })
    let captured: any = null
    const ctx = {
      message,
      rerunHandler: async (orig: any, target: any, expansion: any) => {
        captured = { orig, target, expansion }
      }
    } as any
    await expand(ctx)
    assert.equal(captured.target, null)
    assert.equal(captured.expansion, true)
  })

  test('no reference → 🤷, no rerun', async () => {
    const message = makeMessage({ fetchReferenceResult: null })
    let rerunCalled = false
    const ctx = { message, rerunHandler: async () => { rerunCalled = true } } as any
    await expand(ctx)
    assert.equal(rerunCalled, false)
    assert.deepEqual(message.reactionsAdded, ['🤷'])
  })
})
