import { describe, test, beforeEach } from 'node:test'
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

  // Per-channel rendering flags: thinking (always|auto|never) and showCode
  // (toggle for rendering code-execution artifacts). Old configs without
  // these fields default to "auto" + false respectively — back-compat.
  test('channelFlags defaults when fields missing', async () => {
    await writeAccess({
      users: { U1: { allowed: true } },
      channels: { C1: { enabled: true, requireMention: false } }
    })
    mgr = new AccessManager()
    await mgr.load()
    const f = mgr.channelFlags('C1')
    assert.equal(f.thinking, 'auto')
    assert.equal(f.showCode, false)
  })

  test('channelFlags reads explicit values', async () => {
    await writeAccess({
      users: { U1: { allowed: true } },
      channels: {
        C1: { enabled: true, requireMention: false, thinking: 'always', showCode: true },
        C2: { enabled: true, requireMention: false, thinking: 'never', showCode: false }
      }
    })
    mgr = new AccessManager()
    await mgr.load()
    assert.deepEqual(mgr.channelFlags('C1'), { thinking: 'always', showCode: true })
    assert.deepEqual(mgr.channelFlags('C2'), { thinking: 'never', showCode: false })
  })

  test('channelFlags returns defaults for unknown channel', async () => {
    await writeAccess({ users: {}, channels: {} })
    mgr = new AccessManager()
    await mgr.load()
    assert.deepEqual(mgr.channelFlags('unknown'), { thinking: 'auto', showCode: false })
  })

  test('setChannel preserves optional flags when provided', async () => {
    await writeAccess({ users: {}, channels: {} })
    mgr = new AccessManager()
    await mgr.load()
    await mgr.setChannel('C1', true, false, { thinking: 'always', showCode: true })
    const f = mgr.channelFlags('C1')
    assert.equal(f.thinking, 'always')
    assert.equal(f.showCode, true)
  })

  test('setChannel with no flags defaults to auto/false', async () => {
    await writeAccess({ users: {}, channels: {} })
    mgr = new AccessManager()
    await mgr.load()
    await mgr.setChannel('C1', true, false)
    const f = mgr.channelFlags('C1')
    assert.equal(f.thinking, 'auto')
    assert.equal(f.showCode, false)
  })

  test('setChannel rejects invalid thinking mode', async () => {
    await writeAccess({ users: {}, channels: {} })
    mgr = new AccessManager()
    await mgr.load()
    await assert.rejects(
      () => mgr.setChannel('C1', true, false, { thinking: 'maybe' as any, showCode: false }),
      /thinking.*always.*auto.*never/
    )
  })
})
