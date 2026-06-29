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

  // isUserAllowed: channel-independent user gate, used by /voice (a slash
  // command isn't tied to a text channel's enabled/requireMention flags — it's
  // about whether this person is on the allowlist at all).
  test('isUserAllowed: true for an allowlisted user regardless of channel', async () => {
    await writeAccess({ users: { U1: { allowed: true } }, channels: {} })
    mgr = new AccessManager()
    await mgr.load()
    assert.equal(mgr.isUserAllowed('U1'), true)
  })

  test('isUserAllowed: false for an unknown user', async () => {
    await writeAccess({ users: { U1: { allowed: true } }, channels: {} })
    mgr = new AccessManager()
    await mgr.load()
    assert.equal(mgr.isUserAllowed('U2'), false)
  })

  test('isUserAllowed: false for an explicitly disallowed user', async () => {
    await writeAccess({ users: { U1: { allowed: false } }, channels: {} })
    mgr = new AccessManager()
    await mgr.load()
    assert.equal(mgr.isUserAllowed('U1'), false)
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

  // Per-channel rendering flags. Defaults: thinking=auto, showCode/cache default
  // true, counter='token' (preserves the pre-split verbose=true footer). The
  // verbose flag was split into /gemini counter (footer) + the thinking mode
  // (🧠 reasoning block) on 2026-06-28. optInReply was removed 2026-05-02.
  test('channelFlags defaults when fields missing', async () => {
    await writeAccess({
      users: { U1: { allowed: true } },
      channels: { C1: { enabled: true, requireMention: false } }
    })
    mgr = new AccessManager()
    await mgr.load()
    const f = mgr.channelFlags('C1')
    assert.equal(f.thinking, 'off')
    assert.equal(f.showCode, true)
    assert.equal(f.trace, 'off')
    assert.equal(f.counter, 'both')
    assert.equal(f.cache, true)
  })

  test('trace defaults off and round-trips through setChannelFlags', async () => {
    await writeAccess({
      users: {},
      channels: { C1: { enabled: true, requireMention: false } }
    })
    mgr = new AccessManager()
    await mgr.load()
    // Default: off (opt-in, matches gpt-bot).
    assert.equal(mgr.channelFlags('C1').trace, 'off')
    // on
    const onCfg = await mgr.setChannelFlags('C1', { trace: 'on' })
    assert.equal(onCfg.trace, 'on')
    assert.equal(mgr.channelFlags('C1').trace, 'on')
    // collapse
    await mgr.setChannelFlags('C1', { trace: 'collapse' })
    assert.equal(mgr.channelFlags('C1').trace, 'collapse')
    // patching trace must not disturb other flags
    assert.equal(mgr.channelFlags('C1').thinking, 'off')
    assert.equal(mgr.channelFlags('C1').showCode, true)
  })

  test('setChannelFlags rejects invalid trace mode', async () => {
    await writeAccess({
      users: {},
      channels: { C1: { enabled: true, requireMention: false } }
    })
    mgr = new AccessManager()
    await mgr.load()
    await assert.rejects(
      () => mgr.setChannelFlags('C1', { trace: 'maybe' as any }),
      /trace.*off.*on.*collapse/
    )
  })

  test('channelFlags reads explicit values (incl. legacy thinking coercion)', async () => {
    // Legacy thinking modes on disk (always/never) coerce on read to the unified
    // triple: always→on, never→off. New values (on/off/collapse) pass through.
    await writeAccess({
      users: { U1: { allowed: true } },
      channels: {
        C1: { enabled: true, requireMention: false, thinking: 'always', showCode: true, counter: 'both', cache: true },
        C2: { enabled: true, requireMention: false, thinking: 'never', showCode: false, counter: 'off', cache: false }
      }
    })
    mgr = new AccessManager()
    await mgr.load()
    assert.deepEqual(mgr.channelFlags('C1'), { thinking: 'on', showCode: true, trace: 'off', counter: 'both', cache: true, cacheTtlSec: null, engine: null })
    assert.deepEqual(mgr.channelFlags('C2'), { thinking: 'off', showCode: false, trace: 'off', counter: 'off', cache: false, cacheTtlSec: null, engine: null })
  })

  test('legacy auto thinking coerces to off on read', async () => {
    await writeAccess({
      users: {},
      channels: { C1: { enabled: true, requireMention: false, thinking: 'auto' as any } }
    })
    mgr = new AccessManager()
    await mgr.load()
    assert.equal(mgr.channelFlags('C1').thinking, 'off')
  })

  test('channelFlags returns defaults for unknown channel', async () => {
    await writeAccess({ users: {}, channels: {} })
    mgr = new AccessManager()
    await mgr.load()
    assert.deepEqual(mgr.channelFlags('unknown'), { thinking: 'off', showCode: true, trace: 'off', counter: 'both', cache: true, cacheTtlSec: null, engine: null })
  })

  test('setChannel preserves optional flags when provided', async () => {
    await writeAccess({ users: {}, channels: {} })
    mgr = new AccessManager()
    await mgr.load()
    await mgr.setChannel('C1', true, false, { thinking: 'on', showCode: false })
    const f = mgr.channelFlags('C1')
    assert.equal(f.thinking, 'on')
    assert.equal(f.showCode, false)
  })

  test('setChannel with no flags applies new defaults', async () => {
    await writeAccess({ users: {}, channels: {} })
    mgr = new AccessManager()
    await mgr.load()
    await mgr.setChannel('C1', true, false)
    const f = mgr.channelFlags('C1')
    assert.equal(f.thinking, 'off')
    assert.equal(f.showCode, true)
    assert.equal(f.counter, 'both')
    assert.equal(f.cache, true)
  })

  test('setChannel preserves existing flags on reconfigure', async () => {
    // Re-running /gemini channel must not silently reset thinking/showCode/
    // counter/cache to defaults — those are set via /gemini set, /gemini
    // counter or /gemini cache and should survive.
    await writeAccess({ users: {}, channels: {} })
    mgr = new AccessManager()
    await mgr.load()
    await mgr.setChannel('C1', true, false, { thinking: 'off', showCode: false, counter: 'off', cache: false })
    // Now reconfigure with only the required args
    await mgr.setChannel('C1', true, true)
    const f = mgr.channelFlags('C1')
    assert.equal(f.thinking, 'off')
    assert.equal(f.showCode, false)
    assert.equal(f.counter, 'off')
    assert.equal(f.cache, false)
  })

  test('setChannel rejects invalid thinking mode', async () => {
    await writeAccess({ users: {}, channels: {} })
    mgr = new AccessManager()
    await mgr.load()
    await assert.rejects(
      () => mgr.setChannel('C1', true, false, { thinking: 'maybe' as any, showCode: false }),
      /thinking.*off.*on.*collapse/
    )
  })

  test('setChannelFlags patches thinking without touching requireMention', async () => {
    await writeAccess({
      users: {},
      channels: { C1: { enabled: true, requireMention: true, thinking: 'off', showCode: false } }
    })
    mgr = new AccessManager()
    await mgr.load()
    await mgr.setChannelFlags('C1', { thinking: 'on' })
    const raw = await fs.readFile(path.join(testDir, 'access.json'), 'utf8')
    const parsed = JSON.parse(raw)
    assert.equal(parsed.channels.C1.thinking, 'on')
    assert.equal(parsed.channels.C1.requireMention, true)  // preserved
    assert.equal(parsed.channels.C1.enabled, true)         // preserved
    assert.equal(parsed.channels.C1.showCode, false)       // preserved
  })

  test('setChannelFlags patches showCode independently', async () => {
    await writeAccess({
      users: {},
      channels: { C1: { enabled: true, requireMention: false, thinking: 'off', showCode: false } }
    })
    mgr = new AccessManager()
    await mgr.load()
    await mgr.setChannelFlags('C1', { showCode: true })
    const f = mgr.channelFlags('C1')
    assert.equal(f.showCode, true)
    assert.equal(f.thinking, 'off')  // preserved
  })

  test('setChannelFlags throws on unconfigured channel', async () => {
    await writeAccess({ users: {}, channels: {} })
    mgr = new AccessManager()
    await mgr.load()
    await assert.rejects(
      () => mgr.setChannelFlags('unknown', { thinking: 'on' }),
      /not configured/
    )
  })

  test('setChannelFlags rejects invalid thinking mode', async () => {
    await writeAccess({
      users: {},
      channels: { C1: { enabled: true, requireMention: false, thinking: 'off', showCode: false } }
    })
    mgr = new AccessManager()
    await mgr.load()
    await assert.rejects(
      () => mgr.setChannelFlags('C1', { thinking: 'maybe' as any }),
      /thinking.*off.*on.*collapse/
    )
  })

  test('setChannelFlags persists an explicit engine pick', async () => {
    await writeAccess({
      users: {},
      channels: { C1: { enabled: true, requireMention: false, thinking: 'auto' } }
    })
    mgr = new AccessManager()
    await mgr.load()
    await mgr.setChannelFlags('C1', { engine: 'agy' })
    // round-trips through disk, not just the in-memory copy
    const reloaded = new AccessManager()
    await reloaded.load()
    assert.equal(reloaded.channelFlags('C1').engine, 'agy')
  })

  test('setChannelFlags engine:null clears the pick back to env default', async () => {
    await writeAccess({
      users: {},
      channels: { C1: { enabled: true, requireMention: false, thinking: 'auto', engine: 'agy' } }
    })
    mgr = new AccessManager()
    await mgr.load()
    assert.equal(mgr.channelFlags('C1').engine, 'agy')
    await mgr.setChannelFlags('C1', { engine: null })
    // null sentinel drops the field entirely → channelFlags reports null (= env default)
    assert.equal(mgr.channelFlags('C1').engine, null)
    const raw = JSON.parse(await fs.readFile(path.join(testDir, 'access.json'), 'utf8'))
    assert.equal('engine' in raw.channels.C1, false)
  })

  test('setChannelFlags persists a counter mode', async () => {
    await writeAccess({
      users: {},
      channels: { C1: { enabled: true, requireMention: false, thinking: 'auto' } }
    })
    mgr = new AccessManager()
    await mgr.load()
    await mgr.setChannelFlags('C1', { counter: 'both' })
    const reloaded = new AccessManager()
    await reloaded.load()
    assert.equal(reloaded.channelFlags('C1').counter, 'both')
  })

  test('setChannelFlags rejects an invalid counter mode', async () => {
    await writeAccess({
      users: {},
      channels: { C1: { enabled: true, requireMention: false, thinking: 'auto' } }
    })
    mgr = new AccessManager()
    await mgr.load()
    await assert.rejects(
      () => mgr.setChannelFlags('C1', { counter: 'verbose' as any }),
      /counter.*off.*token.*both/
    )
  })

  test('setChannelFlags rejects an invalid engine', async () => {
    await writeAccess({
      users: {},
      channels: { C1: { enabled: true, requireMention: false, thinking: 'auto' } }
    })
    mgr = new AccessManager()
    await mgr.load()
    await assert.rejects(
      () => mgr.setChannelFlags('C1', { engine: 'gpt' as any }),
      /engine.*agy.*api/
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
