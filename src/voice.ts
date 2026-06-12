/**
 * VoiceManager — wires @discordjs/voice to gem-voice over IPC.
 *
 * Architecture (v2):
 *   - @discordjs/voice handles the entire Discord voice protocol: gateway
 *     credentials, voice WebSocket, UDP, encryption, DAVE/E2EE, Opus framing.
 *   - We tap the inbound Opus stream (summoner only) and forward it to
 *     gem-voice over a unix-socket NDJSON IPC.
 *   - gem-voice emits AUDIO_OUT events with model-generated Opus that we
 *     pipe back into the voice channel via discord.js's AudioPlayer using a
 *     prebuffered Opus source.
 */
import net from 'node:net'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import type { Client, VoiceBasedChannel } from 'discord.js'
import {
  joinVoiceChannel,
  VoiceConnection,
  VoiceConnectionStatus,
  EndBehaviorType,
  createAudioPlayer,
  createAudioResource,
  AudioPlayer,
  AudioPlayerStatus,
  StreamType,
  NoSubscriberBehavior,
  entersState,
} from '@discordjs/voice'

function getSocketPath(): string {
  return process.env.GEM_VOICE_SOCKET_PATH
    || path.join(process.env.XDG_RUNTIME_DIR || '/tmp', 'gem-voice.sock')
}

export interface JoinOptions {
  channel: VoiceBasedChannel
  summonerUserId: string
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
  private connection: VoiceConnection | null = null
  private audioPlayer: AudioPlayer | null = null
  private outboundOpus: Readable | null = null
  private txAudioFrames = 0
  private ipcConnection: net.Socket | null = null
  private ipcRequestCounter = 0
  private ipcPendingRequests = new Map<string, (resp: IpcResponse) => void>()
  private ipcRecvBuffer = ''

  constructor(client: Client) {
    super()
    this.client = client
  }

  /**
   * No-op in v2 — @discordjs/voice subscribes to gateway events itself.
   * Kept as a stable method for backward-compat with callers that invoke it.
   */
  attach(): void {
    // intentionally empty
  }

  async start(opts: JoinOptions): Promise<{ ok: true } | { ok: false; error: string }> {
    if (this.connection) {
      return { ok: false, error: 'already in a voice session' }
    }

    // 1. Connect to gem-voice IPC and start a session
    let ipcSock: net.Socket
    try {
      ipcSock = await this.ensureIpcConnected()
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      return { ok: false, error: `ipc connect failed: ${msg}` }
    }

    const joinResp = await this.sendIpcRequest({
      action: 'join',
      owner_user_id: opts.ownerUserId,
      persona: opts.persona,
      model_config: opts.modelConfig || {},
    })
    if (!joinResp.ok) {
      return { ok: false, error: `gem-voice join failed: ${joinResp.error}` }
    }

    // 2. Join the Discord voice channel via @discordjs/voice
    let connection: VoiceConnection
    try {
      connection = joinVoiceChannel({
        channelId: opts.channel.id,
        guildId: opts.channel.guild.id,
        // discord.js v14 has VoiceBasedChannel.guild.voiceAdapterCreator
        adapterCreator: opts.channel.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false,
      })
      await entersState(connection, VoiceConnectionStatus.Ready, 10_000)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      // Roll back gem-voice session
      await this.sendIpcRequest({ action: 'leave' }).catch(() => {})
      return { ok: false, error: `voice connect failed: ${msg}` }
    }

    this.connection = connection

    // 3. Subscribe to summoner's audio stream — pipe to gem-voice via IPC
    const receiver = connection.receiver
    const summonerStream = receiver.subscribe(opts.summonerUserId, {
      end: { behavior: EndBehaviorType.Manual },
    })

    // Instrumentation: count frames received from Discord vs forwarded over IPC.
    // The daemon side only saw 1 frame per session — this tells us whether Discord
    // is delivering the summoner's RTP at all, or we forward it but the IPC drops it.
    let rxFrames = 0
    let txFrames = 0
    summonerStream.on('data', (opusFrame: Buffer) => {
      rxFrames++
      const b64 = opusFrame.toString('base64')
      // Fire-and-forget: don't await the ack; we don't care about per-frame replies.
      try {
        ipcSock.write(JSON.stringify({ action: 'audio_in', b64 }) + '\n')
        txFrames++
      } catch (e) {
        // socket may have closed mid-write; let the close handler clean up
      }
      if (rxFrames === 1 || rxFrames % 50 === 0) {
        console.log(`[voice/rx] summoner frames: rx=${rxFrames} tx=${txFrames} (last ${opusFrame.length}B)`)
      }
    })
    summonerStream.on('end', () => {
      console.log(`[voice/rx] summoner stream ENDED — total rx=${rxFrames} tx=${txFrames}`)
    })
    summonerStream.on('close', () => {
      console.log(`[voice/rx] summoner stream CLOSED — total rx=${rxFrames} tx=${txFrames}`)
    })
    summonerStream.on('error', (err: Error) => {
      console.error('[voice] summoner stream error:', err.message)
    })

    // 4. Set up an AudioPlayer to play model audio back into the channel.
    // maxMissedFrames is the live-source knob: the player polls the stream
    // every 20ms and goes Idle after that many empty reads — the default (5
    // = 100ms) guarantees Idle in the silence between model turns, which is
    // why the speech ring never lit. 250 ≈ 5s of tolerance.
    this.audioPlayer = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Play, maxMissedFrames: 250 },
    })
    connection.subscribe(this.audioPlayer)
    this.audioPlayer.on('error', (err) => {
      console.error('[voice/tx] player error:', err.message)
    })
    this.audioPlayer.on('stateChange', (oldS, newS) => {
      console.log(`[voice/tx] player ${oldS.status} -> ${newS.status}`)
    })

    // 5. Outbound stream + resource are created lazily per model turn by
    // ensurePlaying() — discord.js destroys the stream when a resource
    // ends, so a single long-lived Readable can never be replayed.

    // 6. Prime the playback pipeline with ~100ms of opus silence. The very
    // first resource played after joining races Discord's SSRC/speaking
    // setup, and a short first reply can be swallowed whole (observed:
    // ring lit, no audible output on turn 1; turn 2 fine). 0xF8 0xFF 0xFE
    // is the canonical Discord opus silence frame.
    this.ensurePlaying()
    const silence = Buffer.from([0xf8, 0xff, 0xfe])
    for (let i = 0; i < 5; i++) {
      if (this.outboundOpus && !this.outboundOpus.destroyed) {
        this.outboundOpus.push(silence)
      }
    }
    console.log('[voice/tx] pipeline primed with silence frames')

    return { ok: true }
  }

  /** Start or re-arm playback. The player drops to Idle when the stream
   *  runs dry past maxMissedFrames (gaps between model turns), and when a
   *  resource ends discord.js DESTROYS its stream — replaying a destroyed
   *  Readable throws (silently, from inside the IPC handler — observed as
   *  one green flicker then permanent silence). So every re-arm builds a
   *  fresh objectMode stream + resource; frames push into whichever
   *  stream is current. objectMode is load-bearing: StreamType.Opus
   *  expects each chunk to be exactly one opus packet, and byte-mode
   *  Readables coalesce pushes into merged, undecodable packets. */
  private ensurePlaying(): void {
    if (!this.audioPlayer) return
    if (this.audioPlayer.state.status !== AudioPlayerStatus.Idle) return
    try {
      this.outboundOpus = new Readable({ objectMode: true, read() { /* push() drives the flow */ } })
      const resource = createAudioResource(this.outboundOpus, {
        inputType: StreamType.Opus,
      })
      this.audioPlayer.play(resource)
      console.log('[voice/tx] playback (re)armed — fresh stream + resource')
    } catch (err) {
      console.error('[voice/tx] re-arm FAILED:', (err as Error).message)
    }
  }

  async stop(): Promise<{ ok: true; wasActive: boolean } | { ok: false; error: string }> {
    const hadConnection = !!this.connection

    // 1. Tell gem-voice to end the session
    let wasActive = false
    if (this.ipcConnection && !this.ipcConnection.destroyed) {
      try {
        const resp = await this.sendIpcRequest({ action: 'leave' })
        wasActive = resp.was_active || false
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e)
        console.error('[voice] ipc leave failed:', msg)
      }
    }

    // 2. Stop audio player + tear down outbound stream
    if (this.audioPlayer) {
      this.audioPlayer.stop()
      this.audioPlayer = null
    }
    if (this.outboundOpus) {
      this.outboundOpus.push(null)
      this.outboundOpus = null
    }

    // 3. Disconnect from voice channel
    if (this.connection) {
      try {
        this.connection.destroy()
      } catch (e: unknown) {
        // Already destroyed is fine
      }
      this.connection = null
    }

    return { ok: true, wasActive: hadConnection || wasActive }
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
          for (const cb of this.ipcPendingRequests.values()) {
            cb({ id: '', ok: false, error: 'ipc connection closed' })
          }
          this.ipcPendingRequests.clear()
          // If the daemon died while we had an active voice connection,
          // tear our side down too.
          if (this.audioPlayer || this.connection) {
            this.stop().catch(() => {})
          }
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
        const msg = JSON.parse(line) as IpcResponse & { event?: string; b64?: string }
        if (msg.event === 'audio_out' && msg.b64) {
          const opusBytes = Buffer.from(msg.b64, 'base64')
          this.txAudioFrames++
          if (this.txAudioFrames === 1 || this.txAudioFrames % 100 === 0) {
            console.log(`[voice/tx] model opus frames received: ${this.txAudioFrames} (last ${opusBytes.length}B)`)
          }
          this.ensurePlaying() // fresh stream/resource if the player idled
          if (this.outboundOpus && !this.outboundOpus.destroyed) {
            this.outboundOpus.push(opusBytes)
          } else {
            console.warn('[voice/tx] dropping frame — no live outbound stream')
          }
          continue
        }
        if (msg.event) {
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
