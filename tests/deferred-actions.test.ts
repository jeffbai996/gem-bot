import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { DeferredActions } from '../src/deferred-actions.ts'

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

describe('DeferredActions', () => {
  test('persists and runs delayed message deletes', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemma-deferred-'))
    const file = path.join(dir, 'deferred-actions.json')
    let deleted = false
    const client = {
      channels: {
        fetch: async () => ({
          isTextBased: () => true,
          messages: {
            fetch: async () => ({
              delete: async () => { deleted = true },
            }),
          },
        }),
      },
    } as any

    const actions = new DeferredActions(file)
    actions.schedule(client, { channelId: 'c', messageId: 'm', action: 'delete', dueAt: Date.now() })
    await wait(20)

    assert.equal(deleted, true)
    assert.equal(await fs.readFile(file, 'utf8'), '[]')
    await fs.rm(dir, { recursive: true, force: true })
  })

  test('rearms persisted deletes after restart', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemma-deferred-'))
    const file = path.join(dir, 'deferred-actions.json')
    await fs.writeFile(file, JSON.stringify([{ channelId: 'c', messageId: 'm', action: 'delete', dueAt: Date.now() }]))

    let deleted = false
    const client = {
      channels: {
        fetch: async () => ({
          isTextBased: () => true,
          messages: {
            fetch: async () => ({
              delete: async () => { deleted = true },
            }),
          },
        }),
      },
    } as any

    new DeferredActions(file).rearm(client)
    await wait(20)

    assert.equal(deleted, true)
    assert.equal(await fs.readFile(file, 'utf8'), '[]')
    await fs.rm(dir, { recursive: true, force: true })
  })
})
