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

  // Per-channel rendering flags. Defaults: thinking=auto, showCode/verbose/
  // cache all default to true. optInReply was removed 2026-05-02 — the gate
  // wasn't worth its UX confusion.
  test('channelFlags defaults when fields missing', async () => {
    await writeAccess({
      users: { U1: { allowed: true } },
      channels: { C1: { enabled: true, requireMention: false } }
    })
    mgr = new AccessManager()
    await mgr.load()
    const f = mgr.channelFlags('C1')
    assert.equal(f.thinking, 'auto')
    assert.equal(f.showCode, true)
    assert.equal(f.verbose, true)
    assert.equal(f.cache, true)
  })

  test('channelFlags reads explicit values', async () => {
    await writeAccess({
      users: { U1: { allowed: true } },
      channels: {
        C1: { enabled: true, requireMention: false, thinking: 'always', showCode: true, verbose: true, cache: true },
        C2: { enabled: true, requireMention: false, thinking: 'never', showCode: false, verbose: false, cache: false }
      }
    })
    mgr = new AccessManager()
    await mgr.load()
    assert.deepEqual(mgr.channelFlags('C1'), { thinking: 'always', showCode: true, verbose: true, cache: true, cacheTtlSec: null })
    assert.deepEqual(mgr.channelFlags('C2'), { thinking: 'never', showCode: false, verbose: false, cache: false, cacheTtlSec: null })
  })

  test('channelFlags returns defaults for unknown channel', async () => {
    await writeAccess({ users: {}, channels: {} })
    mgr = new AccessManager()
    await mgr.load()
    assert.deepEqual(mgr.channelFlags('unknown'), { thinking: 'auto', showCode: true, verbose: true, cache: true, cacheTtlSec: null })
  })

  test('setChannel preserves optional flags when provided', async () => {
    await writeAccess({ users: {}, channels: {} })
    mgr = new AccessManager()
    await mgr.load()
    await mgr.setChannel('C1', true, false, { thinking: 'always', showCode: false })
    const f = mgr.channelFlags('C1')
    assert.equal(f.thinking, 'always')
    assert.equal(f.showCode, false)
  })

  test('setChannel with no flags applies new defaults', async () => {
    await writeAccess({ users: {}, channels: {} })
    mgr = new AccessManager()
    await mgr.load()
    await mgr.setChannel('C1', true, false)
    const f = mgr.channelFlags('C1')
    assert.equal(f.thinking, 'auto')
    assert.equal(f.showCode, true)
    assert.equal(f.verbose, true)
    assert.equal(f.cache, true)
  })

  test('setChannel preserves existing flags on reconfigure', async () => {
    // Re-running /gemini channel must not silently reset thinking/showCode/
    // verbose/cache to defaults — those are set via /gemini set or
    // /gemini cache and should survive.
    await writeAccess({ users: {}, channels: {} })
    mgr = new AccessManager()
    await mgr.load()
    await mgr.setChannel('C1', true, false, { thinking: 'never', showCode: false, verbose: false, cache: false })
    // Now reconfigure with only the required args
    await mgr.setChannel('C1', true, true)
    const f = mgr.channelFlags('C1')
    assert.equal(f.thinking, 'never')
    assert.equal(f.showCode, false)
    assert.equal(f.verbose, false)
    assert.equal(f.cache, false)
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

  test('setChannelFlags patches thinking without touching requireMention', async () => {
    await writeAccess({
      users: {},
      channels: { C1: { enabled: true, requireMention: true, thinking: 'auto', showCode: false } }
    })
    mgr = new AccessManager()
    await mgr.load()
    await mgr.setChannelFlags('C1', { thinking: 'always' })
    const raw = await fs.readFile(path.join(testDir, 'access.json'), 'utf8')
    const parsed = JSON.parse(raw)
    assert.equal(parsed.channels.C1.thinking, 'always')
    assert.equal(parsed.channels.C1.requireMention, true)  // preserved
    assert.equal(parsed.channels.C1.enabled, true)         // preserved
    assert.equal(parsed.channels.C1.showCode, false)       // preserved
  })

  test('setChannelFlags patches showCode independently', async () => {
    await writeAccess({
      users: {},
      channels: { C1: { enabled: true, requireMention: false, thinking: 'never', showCode: false } }
    })
    mgr = new AccessManager()
    await mgr.load()
    await mgr.setChannelFlags('C1', { showCode: true })
    const f = mgr.channelFlags('C1')
    assert.equal(f.showCode, true)
    assert.equal(f.thinking, 'never')  // preserved
  })

  test('setChannelFlags throws on unconfigured channel', async () => {
    await writeAccess({ users: {}, channels: {} })
    mgr = new AccessManager()
    await mgr.load()
    await assert.rejects(
      () => mgr.setChannelFlags('unknown', { thinking: 'always' }),
      /not configured/
    )
  })

  test('setChannelFlags rejects invalid thinking mode', async () => {
    await writeAccess({
      users: {},
      channels: { C1: { enabled: true, requireMention: false, thinking: 'auto', showCode: false } }
    })
    mgr = new AccessManager()
    await mgr.load()
    await assert.rejects(
      () => mgr.setChannelFlags('C1', { thinking: 'maybe' as any }),
      /thinking.*always.*auto.*never/
    )
  })

  describe('canReact', () => {
    test('allowed user in enabled channel can react', async () => {
      await writeAccess({ users: {}, channels: {} })
      mgr = new AccessManager()
      await mgr.load()
      await mgr.allowUser('U1')
      await mgr.setChannel('C1', true, false)
      assert.equal(mgr.canReact('U1', 'C1'), true)
    })

    test('not-allowed user cannot react', async () => {
      await writeAccess({ users: {}, channels: {} })
      mgr = new AccessManager()
      await mgr.load()
      await mgr.setChannel('C1', true, false)
      assert.equal(mgr.canReact('U1', 'C1'), false)
    })

    test('disabled channel blocks reaction', async () => {
      await writeAccess({ users: {}, channels: {} })
      mgr = new AccessManager()
      await mgr.load()
      await mgr.allowUser('U1')
      await mgr.setChannel('C1', false, false)
      assert.equal(mgr.canReact('U1', 'C1'), false)
    })

    test('require-mention setting does not affect canReact', async () => {
      await writeAccess({ users: {}, channels: {} })
      mgr = new AccessManager()
      await mgr.load()
      await mgr.allowUser('U1')
      await mgr.setChannel('C1', true, true)
      assert.equal(mgr.canReact('U1', 'C1'), true)
    })
  })
})
