import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { AccessManager } from '../src/access.js'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'

describe('AccessManager', () => {
  let manager: AccessManager
  const testDir = path.join(os.tmpdir(), 'discord-mcp-test')

  beforeEach(async () => {
    process.env.DISCORD_STATE_DIR = testDir
    await fs.rm(testDir, { recursive: true, force: true })
    manager = new AccessManager()
    await manager.init()
  })

  it('should initialize with default access', () => {
    assert.equal(manager.access.dmPolicy, 'pairing')
    assert.deepEqual(manager.access.allowFrom, [])
  })

  it('should allow DMs from allowlisted users', () => {
    manager.access.allowFrom.push('user123')
    const result = manager.canHandle('channel_dm', 'user123', true, false)
    assert.equal(result, 'allow')
  })

  it('should require pairing for unknown users by default', () => {
    const result = manager.canHandle('channel_dm', 'unknown_user', true, false)
    assert.equal(result, 'pair')
  })

  it('should drop unknown users if dmPolicy is allowlist', () => {
    manager.access.dmPolicy = 'allowlist'
    const result = manager.canHandle('channel_dm', 'unknown_user', true, false)
    assert.equal(result, 'deny')
  })

  it('should allow channel messages if in group and mentioned', () => {
    manager.access.groups['guild_chan_1'] = { requireMention: true, allowFrom: [] }
    
    // Not mentioned
    assert.equal(manager.canHandle('guild_chan_1', 'user1', false, false), 'deny')
    // Mentioned
    assert.equal(manager.canHandle('guild_chan_1', 'user1', false, true), 'allow')
  })

  it('should generate and save pairing codes', async () => {
    const code = await manager.generatePairing('sender999', 'chat888')
    assert.equal(code.length, 6)
    
    // Verify it was saved to the pending list
    assert.ok(manager.access.pending[code])
    assert.equal(manager.access.pending[code].senderId, 'sender999')
  })
})