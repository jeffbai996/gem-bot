/**
 * Unit tests for VoiceManager — IPC client + gateway event handling.
 *
 * Uses a stub Client so we don't need a real Discord connection.
 * Uses a real unix socket server that speaks the gem-voice NDJSON protocol
 * so we can verify our wire-format.
 */
import { describe, test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { VoiceManager } from '../src/voice.ts'

// ---------- Stub Client + Shard ----------

class StubShard {
  sent: Array<{ op: number; d: unknown }> = []
  send(payload: { op: number; d: unknown }): void {
    this.sent.push(payload)
  }
}

class StubClient extends EventEmitter {
  user = { id: 'bot-user-123' }
  ws = {
    shards: {
      first: (): StubShard => this._shard,
    },
  }
  _shard: StubShard

  constructor() {
    super()
    this._shard = new StubShard()
  }

  emitRaw(packet: { t: string; d: unknown }): void {
    this.emit('raw', packet)
  }
}

// ---------- Fake gem-voice IPC server ----------

interface FakeServer {
  path: string
  server: net.Server
  received: Array<Record<string, unknown>>
  setReplyFor(action: string, reply: Record<string, unknown>): void
  close(): Promise<void>
}

function makeFakeServer(socketPath: string): Promise<FakeServer> {
  const received: Array<Record<string, unknown>> = []
  const replies = new Map<string, Record<string, unknown>>()
  const server = net.createServer((conn) => {
    let buf = ''
    conn.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8')
      let idx: number
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx)
        buf = buf.slice(idx + 1)
        if (!line.trim()) continue
        const msg = JSON.parse(line) as Record<string, unknown>
        received.push(msg)
        const action = msg.action as string | undefined
        if (!action) continue
        const baseReply = replies.get(action) || { ok: true }
        const reply = { id: msg.id, ...baseReply }
        conn.write(JSON.stringify(reply) + '\n')
      }
    })
  })

  return new Promise((resolve, reject) => {
    server.listen(socketPath, () => {
      resolve({
        path: socketPath,
        server,
        received,
        setReplyFor(action, reply) {
          replies.set(action, reply)
        },
        close() {
          return new Promise<void>((res) => {
            server.close(() => res())
          })
        },
      })
    })
    server.once('error', reject)
  })
}

// ---------- Tests ----------

describe('VoiceManager', () => {
  let socketPath: string
  let fakeServer: FakeServer
  let client: StubClient
  let voice: VoiceManager

  beforeEach(async () => {
    socketPath = path.join(os.tmpdir(), `gv-test-${process.pid}-${Date.now()}.sock`)
    process.env.GEM_VOICE_SOCKET_PATH = socketPath
    process.env.GEM_VOICE_CREDENTIAL_TIMEOUT_MS = '500'
    fakeServer = await makeFakeServer(socketPath)
    client = new StubClient()
    voice = new VoiceManager(client as unknown as import('discord.js').Client)
    voice.attach()
  })

  afterEach(async () => {
    voice.close()
    await fakeServer.close()
  })

  test('start() sends VOICE_STATE_UPDATE op4 with channel_id', async () => {
    fakeServer.setReplyFor('join', { ok: true, session_id: 'sess-fake' })

    const startPromise = voice.start({
      guildId: 'guild-1',
      channelId: 'vc-1',
      ownerUserId: 'owner-99',
      persona: { name: 'Gem', system_prompt: 'You are Gem.' },
    })

    // Simulate Discord delivering both voice events
    client.emitRaw({
      t: 'VOICE_STATE_UPDATE',
      d: {
        guild_id: 'guild-1',
        channel_id: 'vc-1',
        user_id: 'bot-user-123',
        session_id: 'sess-from-discord',
      },
    })
    client.emitRaw({
      t: 'VOICE_SERVER_UPDATE',
      d: {
        guild_id: 'guild-1',
        endpoint: 'us-east-1.discord.media:443',
        token: 'voice-token-abc',
      },
    })

    const result = await startPromise
    assert.equal(result.ok, true)

    // Shard should have received an op4 with the channel
    assert.equal(client._shard.sent.length, 1)
    assert.equal(client._shard.sent[0].op, 4)
    const d = client._shard.sent[0].d as { guild_id: string; channel_id: string | null }
    assert.equal(d.guild_id, 'guild-1')
    assert.equal(d.channel_id, 'vc-1')
  })

  test('start() forwards full IPC join payload to gem-voice', async () => {
    fakeServer.setReplyFor('join', { ok: true, session_id: 'sess-fake' })

    const startPromise = voice.start({
      guildId: 'guild-2',
      channelId: 'vc-2',
      ownerUserId: 'owner-99',
      persona: { name: 'TestPersona', system_prompt: 'be test' },
      modelConfig: { voice: 'CustomVoice' },
    })

    client.emitRaw({
      t: 'VOICE_STATE_UPDATE',
      d: { guild_id: 'guild-2', channel_id: 'vc-2', user_id: 'bot-user-123', session_id: 'sess-from-discord' },
    })
    client.emitRaw({
      t: 'VOICE_SERVER_UPDATE',
      d: { guild_id: 'guild-2', endpoint: 'us-east-2.discord.media:443', token: 'token-xyz' },
    })

    const result = await startPromise
    assert.equal(result.ok, true)

    // Find the join message
    const joinMsg = fakeServer.received.find((m) => m.action === 'join')
    assert.ok(joinMsg, 'expected gem-voice to receive a join message')
    const creds = joinMsg.vc_credentials as Record<string, string>
    assert.equal(creds.guild_id, 'guild-2')
    assert.equal(creds.channel_id, 'vc-2')
    assert.equal(creds.user_id, 'bot-user-123')
    assert.equal(creds.session_id, 'sess-from-discord')
    assert.equal(creds.endpoint, 'us-east-2.discord.media:443')
    assert.equal(creds.token, 'token-xyz')
    assert.equal(joinMsg.owner_user_id, 'owner-99')
    const persona = joinMsg.persona as Record<string, string>
    assert.equal(persona.name, 'TestPersona')
    assert.equal(persona.system_prompt, 'be test')
    const modelConfig = joinMsg.model_config as Record<string, string>
    assert.equal(modelConfig.voice, 'CustomVoice')
  })

  test('start() times out if credentials never arrive', async () => {
    // No emitRaw — credentials never come.
    const result = await voice.start({
      guildId: 'guild-3',
      channelId: 'vc-3',
      ownerUserId: 'owner-99',
      persona: { name: 'P', system_prompt: 'p' },
    })
    // With the real 10s timeout this would be slow — instead override the
    // pendingJoin timer by... actually this test will take 10s. Skip it
    // unless we want slow tests in CI. For now, just verify it eventually
    // resolves with ok:false.
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.match(result.error, /timeout/i)
    }
  })

  test('ignores voice state updates from other users', async () => {
    fakeServer.setReplyFor('join', { ok: true })
    const startPromise = voice.start({
      guildId: 'guild-4',
      channelId: 'vc-4',
      ownerUserId: 'owner-99',
      persona: { name: 'P', system_prompt: 'p' },
    })

    // Someone else's voice state — should be ignored
    client.emitRaw({
      t: 'VOICE_STATE_UPDATE',
      d: { guild_id: 'guild-4', channel_id: 'vc-4', user_id: 'someone-else', session_id: 'not-ours' },
    })

    // No join should have been sent yet
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(fakeServer.received.length, 0)

    // Now our state arrives
    client.emitRaw({
      t: 'VOICE_STATE_UPDATE',
      d: { guild_id: 'guild-4', channel_id: 'vc-4', user_id: 'bot-user-123', session_id: 'sess-our' },
    })
    client.emitRaw({
      t: 'VOICE_SERVER_UPDATE',
      d: { guild_id: 'guild-4', endpoint: 'ep:443', token: 'tok' },
    })

    const result = await startPromise
    assert.equal(result.ok, true)
  })

  test('stop() sends VOICE_STATE_UPDATE with channel_id=null + IPC leave', async () => {
    fakeServer.setReplyFor('join', { ok: true })
    fakeServer.setReplyFor('leave', { ok: true, was_active: true })

    const startPromise = voice.start({
      guildId: 'guild-5',
      channelId: 'vc-5',
      ownerUserId: 'owner-99',
      persona: { name: 'P', system_prompt: 'p' },
    })
    client.emitRaw({
      t: 'VOICE_STATE_UPDATE',
      d: { guild_id: 'guild-5', channel_id: 'vc-5', user_id: 'bot-user-123', session_id: 's' },
    })
    client.emitRaw({
      t: 'VOICE_SERVER_UPDATE',
      d: { guild_id: 'guild-5', endpoint: 'ep:443', token: 'tok' },
    })
    await startPromise

    client._shard.sent.length = 0

    const stopResult = await voice.stop()
    assert.equal(stopResult.ok, true)
    if (stopResult.ok) {
      assert.equal(stopResult.wasActive, true)
    }

    // Shard should have received an op4 with channel_id=null
    assert.equal(client._shard.sent.length, 1)
    const d = client._shard.sent[0].d as { guild_id: string; channel_id: string | null }
    assert.equal(d.guild_id, 'guild-5')
    assert.equal(d.channel_id, null)

    // IPC server should have received a leave action
    const leaveMsg = fakeServer.received.find((m) => m.action === 'leave')
    assert.ok(leaveMsg, 'expected leave action')
  })

  test('start() rejects second join while one is in flight', async () => {
    fakeServer.setReplyFor('join', { ok: true })
    voice.start({
      guildId: 'guild-6',
      channelId: 'vc-6',
      ownerUserId: 'owner-99',
      persona: { name: 'P', system_prompt: 'p' },
    })
    // Don't await — second start while first is pending
    const second = await voice.start({
      guildId: 'guild-6',
      channelId: 'vc-6b',
      ownerUserId: 'owner-99',
      persona: { name: 'P', system_prompt: 'p' },
    })
    assert.equal(second.ok, false)
    if (!second.ok) {
      assert.match(second.error, /already/i)
    }
  })
})
