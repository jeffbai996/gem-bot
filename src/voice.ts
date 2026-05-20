/**
 * VoiceManager — bridges discord.js voice state events to the gem-voice IPC daemon.
 *
 * Architecture:
 *   - gemma.ts owns the Discord token and the main gateway connection.
 *   - When user runs /voice join, we send a VOICE_STATE_UPDATE on our shard
 *     (channel_id: <vc>) to request joining their voice channel.
 *   - Discord responds with VOICE_STATE_UPDATE (gives our session_id) and
 *     VOICE_SERVER_UPDATE (gives endpoint + voice token).
 *   - Once we have both, build the IPC payload and send to gem-voice.
 *   - gem-voice opens the voice WS itself with those credentials.
 *
 * /voice leave → send VOICE_STATE_UPDATE (channel_id: null) to detach + send
 * leave to gem-voice.
 */
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import type { Client } from 'discord.js'

function getSocketPath(): string {
  return process.env.GEM_VOICE_SOCKET_PATH
    || path.join(process.env.XDG_RUNTIME_DIR || '/tmp', 'gem-voice.sock')
}

function getCredentialTimeoutMs(): number {
  return parseInt(process.env.GEM_VOICE_CREDENTIAL_TIMEOUT_MS || '10000', 10)
}

interface VoiceStateUpdateData {
  guild_id: string
  channel_id: string | null
  user_id: string
  session_id: string
}

interface VoiceServerUpdateData {
  guild_id: string
  endpoint: string | null
  token: string
}

interface PendingJoin {
  guildId: string
  channelId: string
  ownerUserId: string
  persona: JoinOptions['persona']
  modelConfig: JoinOptions['modelConfig']
  resolve: (result: { ok: true } | { ok: false; error: string }) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
  sessionId?: string
  endpoint?: string
  token?: string
}

export interface JoinOptions {
  guildId: string
  channelId: string
  ownerUserId: string
  persona: { name: string; system_prompt: string; memory_query?: string }
  modelConfig?: { model?: string; voice?: string; language?: string }
}

interface IpcResponse {
  id: string
  ok: boolean
  error?: string
  session_id?: string
  was_active?: boolean
}

export class VoiceManager extends EventEmitter {
  private client: Client
  private pendingJoin: PendingJoin | null = null
  private ipcConnection: net.Socket | null = null
  private ipcRequestCounter = 0
  private ipcPendingRequests = new Map<string, (resp: IpcResponse) => void>()
  private ipcRecvBuffer = ''
  private activeGuildId: string | null = null
  private activeBotUserId: string | null = null

  constructor(client: Client) {
    super()
    this.client = client
  }

  /**
   * Wire up raw gateway event taps. discord.js delivers raw dispatch events
   * via `client.on('raw')`. We listen for VOICE_STATE_UPDATE + VOICE_SERVER_UPDATE
   * to capture the credentials we need to forward to gem-voice.
   */
  attach(): void {
    this.client.on('raw', (packet: { t?: string; d?: unknown }) => {
      // Debug: log any voice-related raw event we see. Removes once stable.
      if (packet.t === 'VOICE_STATE_UPDATE' || packet.t === 'VOICE_SERVER_UPDATE') {
        const d = packet.d as Record<string, unknown> | undefined
        console.error(`[voice] raw event: ${packet.t}`, JSON.stringify({
          guild_id: d?.guild_id,
          channel_id: d?.channel_id,
          user_id: d?.user_id,
          has_session: !!d?.session_id,
          has_endpoint: !!d?.endpoint,
          has_token: !!d?.token,
        }))
      }
      if (packet.t === 'VOICE_STATE_UPDATE') {
        this.handleVoiceStateUpdate(packet.d as VoiceStateUpdateData)
      } else if (packet.t === 'VOICE_SERVER_UPDATE') {
        this.handleVoiceServerUpdate(packet.d as VoiceServerUpdateData)
      }
    })
  }

  private handleVoiceStateUpdate(data: VoiceStateUpdateData): void {
    if (!this.pendingJoin) return
    if (!this.client.user) return
    // Only care about our own bot's voice state, not other users in the vc.
    if (data.user_id !== this.client.user.id) return
    if (data.guild_id !== this.pendingJoin.guildId) return

    this.pendingJoin.sessionId = data.session_id
    this.tryCompletePendingJoin()
  }

  private handleVoiceServerUpdate(data: VoiceServerUpdateData): void {
    if (!this.pendingJoin) return
    if (data.guild_id !== this.pendingJoin.guildId) return

    this.pendingJoin.endpoint = data.endpoint || undefined
    this.pendingJoin.token = data.token
    this.tryCompletePendingJoin()
  }

  private async tryCompletePendingJoin(): Promise<void> {
    const p = this.pendingJoin
    if (!p) return
    if (!p.sessionId || !p.endpoint || !p.token) return
    if (!this.client.user) return

    // Clear pendingJoin first so a late event doesn't double-fire.
    this.pendingJoin = null
    clearTimeout(p.timer)

    try {
      const resp = await this.sendIpcRequest({
        action: 'join',
        vc_credentials: {
          guild_id: p.guildId,
          channel_id: p.channelId,
          user_id: this.client.user.id,
          session_id: p.sessionId,
          endpoint: p.endpoint,
          token: p.token,
        },
        owner_user_id: p.ownerUserId,
        persona: p.persona,
        model_config: p.modelConfig || {},
      })
      if (!resp.ok) {
        p.resolve({ ok: false, error: resp.error || 'unknown ipc error' })
        return
      }
      this.activeGuildId = p.guildId
      this.activeBotUserId = this.client.user.id
      p.resolve({ ok: true })
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      p.resolve({ ok: false, error: `ipc error: ${msg}` })
    }
  }

  /**
   * Send a JOIN_VOICE_CHANNEL gateway op to bring the bot into the vc, then
   * wait for VOICE_STATE_UPDATE + VOICE_SERVER_UPDATE to arrive with the
   * credentials we'll forward to gem-voice.
   */
  async start(options: JoinOptions): Promise<{ ok: true } | { ok: false; error: string }> {
    if (this.pendingJoin || this.activeGuildId) {
      return { ok: false, error: 'already in a voice session' }
    }

    // Stash persona + model so tryCompletePendingJoin can include them in IPC
    // by retrieving from pendingJoin.
    return new Promise((resolve, reject) => {
      const timeoutMs = getCredentialTimeoutMs()
      const timer = setTimeout(() => {
        if (this.pendingJoin) {
          this.pendingJoin = null
          resolve({ ok: false, error: `timeout waiting for voice credentials (${timeoutMs}ms)` })
        }
      }, timeoutMs)

      this.pendingJoin = {
        guildId: options.guildId,
        channelId: options.channelId,
        ownerUserId: options.ownerUserId,
        persona: options.persona,
        modelConfig: options.modelConfig,
        resolve,
        reject,
        timer,
      }

      // Send Opcode 4 (Update Voice State) on our shard.
      // Payload: { op: 4, d: { guild_id, channel_id, self_mute, self_deaf } }
      // discord.js exposes this via WebSocketShard.send().
      const shard = this.client.ws.shards.first()
      if (!shard) {
        clearTimeout(timer)
        this.pendingJoin = null
        resolve({ ok: false, error: 'no active gateway shard' })
        return
      }
      console.error(`[voice] sending op4 — guild=${options.guildId} channel=${options.channelId}`)
      shard.send({
        op: 4,
        d: {
          guild_id: options.guildId,
          channel_id: options.channelId,
          self_mute: false,
          self_deaf: false,
        },
      })
      console.error(`[voice] op4 sent, waiting up to ${timeoutMs}ms for VOICE_STATE_UPDATE + VOICE_SERVER_UPDATE`)
    })
  }

  /**
   * Detach from the voice channel and tell gem-voice to end the session.
   */
  async stop(): Promise<{ ok: true; wasActive: boolean } | { ok: false; error: string }> {
    if (!this.activeGuildId) {
      // Try to send the IPC leave anyway in case state is desynced — it's idempotent.
      try {
        const resp = await this.sendIpcLeave()
        return { ok: true, wasActive: resp.was_active || false }
      } catch {
        return { ok: true, wasActive: false }
      }
    }

    const guildId = this.activeGuildId
    this.activeGuildId = null
    this.activeBotUserId = null

    // Send IPC leave first (gem-voice closes its voice WS).
    let wasActive = false
    try {
      const resp = await this.sendIpcLeave()
      wasActive = resp.was_active || false
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      return { ok: false, error: `ipc leave failed: ${msg}` }
    }

    // Then send VOICE_STATE_UPDATE with channel_id: null to detach our shard
    // from the vc on Discord's side.
    const shard = this.client.ws.shards.first()
    if (shard) {
      shard.send({
        op: 4,
        d: {
          guild_id: guildId,
          channel_id: null,
          self_mute: false,
          self_deaf: false,
        },
      })
    }

    return { ok: true, wasActive }
  }

  // -------- IPC client --------

  private async ensureIpcConnected(): Promise<net.Socket> {
    if (this.ipcConnection && !this.ipcConnection.destroyed) {
      return this.ipcConnection
    }
    return new Promise((resolve, reject) => {
      const sockPath = getSocketPath()
      const sock = net.createConnection(sockPath)
      sock.once('connect', () => {
        this.ipcConnection = sock
        sock.on('data', (chunk: Buffer) => this.handleIpcData(chunk))
        sock.on('close', () => {
          this.ipcConnection = null
          // Fail all in-flight requests
          for (const cb of this.ipcPendingRequests.values()) {
            cb({ id: '', ok: false, error: 'ipc connection closed' })
          }
          this.ipcPendingRequests.clear()
        })
        sock.on('error', (e: Error) => {
          console.error('[voice] ipc socket error:', e.message)
        })
        resolve(sock)
      })
      sock.once('error', (e: Error) => {
        reject(new Error(`could not connect to gem-voice socket at ${sockPath}: ${e.message}`))
      })
    })
  }

  private handleIpcData(chunk: Buffer): void {
    this.ipcRecvBuffer += chunk.toString('utf8')
    let newlineIdx: number
    while ((newlineIdx = this.ipcRecvBuffer.indexOf('\n')) !== -1) {
      const line = this.ipcRecvBuffer.slice(0, newlineIdx)
      this.ipcRecvBuffer = this.ipcRecvBuffer.slice(newlineIdx + 1)
      if (!line.trim()) continue
      try {
        const msg = JSON.parse(line) as IpcResponse & { event?: string }
        if (msg.event) {
          // Unsolicited event from gem-voice (user_speech_end, model_speech_end, etc.)
          this.emit('event', msg)
          continue
        }
        const id = msg.id
        const handler = this.ipcPendingRequests.get(id)
        if (handler) {
          this.ipcPendingRequests.delete(id)
          handler(msg)
        }
      } catch (e: unknown) {
        const errMsg = e instanceof Error ? e.message : String(e)
        console.error('[voice] failed to parse ipc line:', line, errMsg)
      }
    }
  }

  private async sendIpcRequest(payload: Record<string, unknown>): Promise<IpcResponse> {
    const sock = await this.ensureIpcConnected()
    const id = `req-${++this.ipcRequestCounter}`
    payload.id = id
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.ipcPendingRequests.delete(id)
        reject(new Error('ipc request timeout'))
      }, 15_000)
      this.ipcPendingRequests.set(id, (resp) => {
        clearTimeout(timer)
        resolve(resp)
      })
      sock.write(JSON.stringify(payload) + '\n')
    })
  }

  private async sendIpcLeave(): Promise<IpcResponse> {
    return this.sendIpcRequest({ action: 'leave' })
  }

  /**
   * Close the IPC socket connection. Used for test cleanup and graceful
   * shutdown. Safe to call multiple times.
   */
  close(): void {
    if (this.ipcConnection && !this.ipcConnection.destroyed) {
      this.ipcConnection.destroy()
    }
    this.ipcConnection = null
  }
}

export { getSocketPath as VOICE_SOCKET_PATH_RESOLVER }
