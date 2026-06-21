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
import { GuildMember } from 'discord.js'
import type { Client, VoiceBasedChannel, Message } from 'discord.js'
import type { ToolRegistry, ToolContext } from './tools/index.ts'
import { getVoicePref } from './voice-pref.ts'
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
  /** Tool belt for the live session — same registry text Gemma uses.
   *  Declarations ride the join payload; calls come back over IPC as
   *  `tool_call` events and are executed here in Node. */
  tools?: ToolRegistry
  toolContext?: ToolContext
  /** 'call' = realtime mic↔voice (Gemini Live). 'speak' = text-driven: join
   *  the vc for OUTPUT only (no Live session, no mic); typed channel messages
   *  are spoken via sayText(). Default 'call'. */
  mode?: 'call' | 'speak'
  /** speak mode only: the text channel /voice speak was launched from. Typed
   *  messages there get spoken when the author is co-present in the vc. */
  speakChannelId?: string
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
  // Which mode the active session is in + which vc/text-channel — used by
  // isSpeakingTo() to gate text-driven speech on co-presence.
  private mode: 'call' | 'speak' = 'call'
  private channelId: string | null = null
  private speakChannelId: string | null = null
  private audioPlayer: AudioPlayer | null = null
  private outboundOpus: Readable | null = null
  private txAudioFrames = 0
  private turnBuffer: Buffer[] = []
  private turnBufferTimer: ReturnType<typeof setTimeout> | null = null
  // Jitter-buffer tuning (env-overridable so it can be dialed by ear without a
  // redeploy). The bank is the turn-start cushion that absorbs Gemini's bursty
  // delivery; a bigger bank = smoother through mid-turn gaps but more latency
  // before Gem's first word. Defaults nudged up from 25/400 → 36/600 (~720ms)
  // to soften the "lags then catches up" underruns.
  private readonly jitterBank = parseInt(process.env.GEM_VOICE_JITTER_BANK || '36', 10)
  private readonly jitterMs = parseInt(process.env.GEM_VOICE_JITTER_MS || '600', 10)
  private readonly maxMissed = parseInt(process.env.GEM_VOICE_MAX_MISSED_FRAMES || '250', 10)
  // Speak mode is already realtime-paced by gem-voice's say(), so it needs far
  // less turn-start buffering than call (whose Live audio arrives bursty). A
  // smaller bank here = lower speak latency without re-introducing the call-mode
  // "lags then catches up". Env-tunable.
  private readonly jitterBankSpeak = parseInt(process.env.GEM_VOICE_JITTER_BANK_SPEAK || '18', 10)
  private readonly jitterMsSpeak = parseInt(process.env.GEM_VOICE_JITTER_MS_SPEAK || '350', 10)
  private toolRegistry: ToolRegistry | null = null
  private toolContext: ToolContext | null = null
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

    const mode = opts.mode || 'call'
    // Call mode opens a live Gemini session (mic↔voice). Speak mode is
    // text-driven — no Live session; sayText() does per-utterance TTS over the
    // same audio_out pipeline, so we skip the join + the mic entirely.
    if (mode === 'call') {
      this.toolRegistry = opts.tools ?? null
      this.toolContext = opts.toolContext ?? null
      const joinResp = await this.sendIpcRequest({
        action: 'join',
        owner_user_id: opts.ownerUserId,
        persona: opts.persona,
        // Inject the persisted /voice type pick so a call uses the chosen voice.
        // An explicit modelConfig.voice (none today) still wins over the pref.
        model_config: { voice: getVoicePref(), ...(opts.modelConfig || {}) },
        tools: this.toolRegistry ? this.toolRegistry.getDeclarations() : undefined,
      })
      if (!joinResp.ok) {
        return { ok: false, error: `gem-voice join failed: ${joinResp.error}` }
      }
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
    this.mode = mode
    this.channelId = opts.channel.id
    this.speakChannelId = opts.speakChannelId || null

    // Diagnostic: a per-channel Speak denial lets the bot join + the player
    // "play" but no audio reaches the vc — presents as "everything works but
    // silent". Also log connection state changes: in speak mode there's no mic
    // receiver, so if the connection silently drops to non-Ready, audio stops
    // transmitting while the player still reports Playing. Wrapped so a
    // perms-cache miss can't break the join.
    try {
      const me = opts.channel.guild.members.me
      const perms = me ? opts.channel.permissionsFor(me) : null
      console.log(`[voice/conn] joined vc=${opts.channel.id} mode=${mode} status=${connection.state.status} canSpeak=${perms?.has('Speak')} canConnect=${perms?.has('Connect')}`)
    } catch {
      console.log(`[voice/conn] joined vc=${opts.channel.id} mode=${mode} status=${connection.state.status} (perms check failed)`)
    }
    connection.on('stateChange', (o, n) => {
      console.log(`[voice/conn] ${o.status} -> ${n.status}`)
    })

    // 3. Subscribe to summoner's audio stream — pipe to gem-voice via IPC.
    // CALL mode only: speak is text-driven (input arrives as typed messages),
    // so there's no mic to tap.
    if (mode === 'call') {
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
    }

    // 4. Set up an AudioPlayer to play model audio back into the channel.
    // maxMissedFrames is the live-source knob: the player polls the stream
    // every 20ms and goes Idle after that many empty reads — the default (5
    // = 100ms) guarantees Idle in the silence between model turns, which is
    // why the speech ring never lit. 250 ≈ 5s of tolerance.
    this.audioPlayer = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Play, maxMissedFrames: this.maxMissed },
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

    // 6. Warm up the playback pipeline with 0.5s of SILENCE through the
    // prism/opusscript Raw path. The first resource played after joining
    // races Discord's SSRC/speaking setup and a short first reply gets
    // swallowed whole (observed live) — priming with silence absorbs that
    // race inaudibly. (This was a 440Hz diagnostic tone during bring-up.)
    const warmRate = 48000
    const warmPcm = Buffer.alloc(Math.floor(warmRate * 0.5) * 4) // s16le stereo zeros
    const warmResource = createAudioResource(Readable.from([warmPcm]), {
      inputType: StreamType.Raw,
    })
    this.audioPlayer.play(warmResource)
    console.log('[voice/tx] pipeline warmed (0.5s silence via raw/prism path)')

    return { ok: true }
  }

  /** Execute a model-requested function with the SAME registry text Gemma
   *  uses, and feed the result back over IPC. Gemini holds the turn open
   *  while waiting, then speaks the answer. */
  private async handleToolCall(call: { call_id: string; name: string; args: Record<string, unknown> }): Promise<void> {
    console.log(`[voice/tool] ${call.name}(${JSON.stringify(call.args).slice(0, 120)})`)
    let result: string
    if (!this.toolRegistry || !this.toolContext) {
      result = 'No tools available in this voice session.'
    } else {
      try {
        result = await this.toolRegistry.dispatch(call.name, call.args ?? {}, this.toolContext)
      } catch (e: unknown) {
        result = `Tool error: ${e instanceof Error ? e.message : String(e)}`
      }
    }
    console.log(`[voice/tool] ${call.name} -> ${result.slice(0, 120)}`)
    try {
      await this.sendIpcRequest({
        action: 'tool_response',
        call_id: call.call_id,
        name: call.name,
        response: { result },
      })
    } catch (e: unknown) {
      console.error('[voice/tool] tool_response send failed:', e instanceof Error ? e.message : String(e))
    }
  }

  /** Barge-in: the daemon saw Gemini's `interrupted` signal and flushed its
   *  side — kill everything buffered here so she stops mid-word. The next
   *  model turn re-arms a fresh stream via ensurePlaying(). */
  private flushPlayback(): void {
    if (this.turnBufferTimer) {
      clearTimeout(this.turnBufferTimer)
      this.turnBufferTimer = null
    }
    const banked = this.turnBuffer.length
    this.turnBuffer = []
    if (this.outboundOpus && !this.outboundOpus.destroyed) {
      this.outboundOpus.destroy()
    }
    this.outboundOpus = null
    this.audioPlayer?.stop(true)
    console.log(`[voice/tx] playback FLUSHED (barge-in; ${banked} banked frames dropped)`)
  }

  /** Jitter buffer: Gemini streams audio in bursts, and on free tier the
   *  generation pace can dip below realtime mid-reply — playing frames the
   *  instant they arrive turns every inter-chunk gap into an audible
   *  stutter (observed: long replies "all chopped up"). At each turn
   *  start (player idle) we hold frames until ~500ms is banked or 400ms
   *  passes, then open the tap; the bank absorbs the gaps. */
  private handleModelFrame(opusBytes: Buffer): void {
    // Speak (paced TTS) uses a smaller jitter bank than call (bursty Live).
    const bank = this.mode === 'speak' ? this.jitterBankSpeak : this.jitterBank
    const ms = this.mode === 'speak' ? this.jitterMsSpeak : this.jitterMs
    const playerIdle =
      this.audioPlayer?.state.status === AudioPlayerStatus.Idle
    if (playerIdle || this.turnBufferTimer) {
      this.turnBuffer.push(opusBytes)
      if (!this.turnBufferTimer) {
        this.turnBufferTimer = setTimeout(() => this.flushTurnBuffer(), ms)
      }
      if (this.turnBuffer.length >= bank) this.flushTurnBuffer()
      return
    }
    this.pushFrame(opusBytes)
  }

  private flushTurnBuffer(): void {
    if (this.turnBufferTimer) {
      clearTimeout(this.turnBufferTimer)
      this.turnBufferTimer = null
    }
    if (!this.turnBuffer.length) return
    this.ensurePlaying()
    const banked = this.turnBuffer
    this.turnBuffer = []
    console.log(`[voice/tx] jitter buffer flushed (${banked.length} frames banked)`)
    for (const frame of banked) this.pushFrame(frame)
  }

  private pushFrame(opusBytes: Buffer): void {
    this.ensurePlaying()
    if (this.outboundOpus && !this.outboundOpus.destroyed) {
      this.outboundOpus.push(opusBytes)
    } else {
      console.warn('[voice/tx] dropping frame — no live outbound stream')
    }
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
    // Re-arm whenever there's no live outbound stream to push into — NOT just
    // when the player is Idle. The player can sit in a non-Idle state
    // (Buffering / AutoPaused, e.g. a brief connection wobble or the tick
    // between a resource's stream being destroyed and the player flipping to
    // Idle) while its stream is already dead. The old Idle-only gate skipped
    // the re-arm there, so pushFrame() then dropped every frame into the dead
    // stream → "responds a few turns, then wall of silence". Keying on stream
    // liveness covers both: a live stream short-circuits (push into it), a
    // dead/missing one always re-arms.
    if (this.outboundOpus && !this.outboundOpus.destroyed) return
    try {
      this.outboundOpus = new Readable({ objectMode: true, read() { /* push() drives the flow */ } })
      const resource = createAudioResource(this.outboundOpus, {
        inputType: StreamType.Opus,
      })
      this.audioPlayer.play(resource)
      console.log(`[voice/tx] playback (re)armed — fresh stream + resource (conn=${this.connection?.state.status})`)
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
    this.mode = 'call'
    this.channelId = null
    this.speakChannelId = null

    return { ok: true, wasActive: hadConnection || wasActive }
  }

  /** True when we're in speak mode AND the message's author is co-present in
   *  the vc we're connected to AND the message is in the launch channel. Gates
   *  text-driven speech: typed messages are only spoken to people who can hear. */
  isSpeakingTo(message: Message): boolean {
    if (this.mode !== 'speak' || !this.connection || !this.channelId) return false
    if (this.speakChannelId && message.channelId !== this.speakChannelId) return false
    const member = message.member
    if (!(member instanceof GuildMember)) return false
    return member.voice?.channelId === this.channelId
  }

  /** Speak-mode TTS: hand a finished reply to gem-voice's `say` action, which
   *  synthesizes it (same voice as Live) and streams it back as audio_out — the
   *  same playback path, so it just plays. No-op (ok) on empty text. */
  async sayText(text: string): Promise<{ ok: true } | { ok: false; error: string }> {
    if (this.mode !== 'speak' || !this.connection) {
      return { ok: false, error: 'not in an active speak-mode session' }
    }
    const t = text.trim()
    if (!t) return { ok: true }
    try {
      const resp = await this.sendIpcRequest({ action: 'say', text: t, voice: getVoicePref() })
      if (!resp.ok) return { ok: false, error: resp.error || 'gem-voice say failed' }
      return { ok: true }
    } catch (e: unknown) {
      return { ok: false, error: `gem-voice say failed: ${e instanceof Error ? e.message : String(e)}` }
    }
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
        if (msg.event === 'tool_call') {
          this.handleToolCall(msg as unknown as { call_id: string; name: string; args: Record<string, unknown> })
          continue
        }
        if (msg.event === 'audio_flush') {
          this.flushPlayback()
          continue
        }
        if (msg.event === 'audio_out' && msg.b64) {
          const opusBytes = Buffer.from(msg.b64, 'base64')
          this.txAudioFrames++
          if (this.txAudioFrames === 1 || this.txAudioFrames % 100 === 0) {
            console.log(`[voice/tx] model opus frames received: ${this.txAudioFrames} (last ${opusBytes.length}B)`)
          }
          this.handleModelFrame(opusBytes)
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
