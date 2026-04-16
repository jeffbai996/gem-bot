import { describe, test, beforeEach } from 'bun:test'
import assert from 'node:assert/strict'
import { AccessManager } from '../src/access.ts'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'

const testDir = path.join(os.tmpdir(), `gemma-access-test-${process.pid}`)

async function writeAccess(obj: unknown) {
  await fs.mkdir(testDir, { recursive: true })
  await fs.writeFile(path.join(testDir, 'access.json'), JSON.stringify(obj), 'utf8')
}

describe('AccessManager', () => {
  let mgr: AccessManager

  beforeEach(async () => {
    process.env.DISCORD_STATE_DIR = testDir
    await fs.rm(testDir, { recursive: true, force: true })
  })

  test('denies unknown user in unknown channel', async () => {
    await writeAccess({ users: {}, channels: {} })
    mgr = new AccessManager()
    await mgr.load()
    assert.equal(mgr.canHandle({ channelId: 'C1', userId: 'U1', isMention: false }), false)
  })

  test('denies allowed user in unknown channel', async () => {
    await writeAccess({ users: { U1: { allowed: true } }, channels: {} })
    mgr = new AccessManager()
    await mgr.load()
    assert.equal(mgr.canHandle({ channelId: 'C1', userId: 'U1', isMention: false }), false)
  })

  test('allows known user in enabled channel without requireMention', async () => {
    await writeAccess({
      users: { U1: { allowed: true } },
      channels: { C1: { enabled: true, requireMention: false } }
    })
    mgr = new AccessManager()
    await mgr.load()
    assert.equal(mgr.canHandle({ channelId: 'C1', userId: 'U1', isMention: false }), true)
  })

  test('denies known user in requireMention channel without mention', async () => {
    await writeAccess({
      users: { U1: { allowed: true } },
      channels: { C1: { enabled: true, requireMention: true } }
    })
    mgr = new AccessManager()
    await mgr.load()
    assert.equal(mgr.canHandle({ channelId: 'C1', userId: 'U1', isMention: false }), false)
    assert.equal(mgr.canHandle({ channelId: 'C1', userId: 'U1', isMention: true }), true)
  })

  test('denies when channel is disabled', async () => {
    await writeAccess({
      users: { U1: { allowed: true } },
      channels: { C1: { enabled: false, requireMention: false } }
    })
    mgr = new AccessManager()
    await mgr.load()
    assert.equal(mgr.canHandle({ channelId: 'C1', userId: 'U1', isMention: false }), false)
  })

  test('creates empty access.json if missing', async () => {
    await fs.mkdir(testDir, { recursive: true })
    mgr = new AccessManager()
    await mgr.load()
    const raw = await fs.readFile(path.join(testDir, 'access.json'), 'utf8')
    const parsed = JSON.parse(raw)
    assert.deepEqual(parsed, { users: {}, channels: {} })
  })

  test('reload picks up edits without process restart', async () => {
    await writeAccess({ users: {}, channels: {} })
    mgr = new AccessManager()
    await mgr.load()
    assert.equal(mgr.canHandle({ channelId: 'C1', userId: 'U1', isMention: false }), false)

    await writeAccess({
      users: { U1: { allowed: true } },
      channels: { C1: { enabled: true, requireMention: false } }
    })
    await mgr.load()
    assert.equal(mgr.canHandle({ channelId: 'C1', userId: 'U1', isMention: false }), true)
  })
})
