import fs from 'fs/promises'
import path from 'path'
import os from 'os'

export type ThinkingMode = 'always' | 'auto' | 'never'

export interface ChannelConfig {
  enabled: boolean
  requireMention: boolean
  thinking?: ThinkingMode  // default "auto" — Gemma decides per message
  showCode?: boolean       // default false — don't render code-exec artifacts
}

export interface ChannelFlags {
  thinking: ThinkingMode
  showCode: boolean
}

export interface AccessFile {
  users: Record<string, { allowed: boolean }>
  channels: Record<string, ChannelConfig>
}

export interface CanHandleInput {
  channelId: string
  userId: string
  isMention: boolean
}

const EMPTY: AccessFile = { users: {}, channels: {} }
const VALID_THINKING_MODES: ThinkingMode[] = ['always', 'auto', 'never']

export class AccessManager {
  private stateDir: string
  private file: string
  private data: AccessFile = { ...EMPTY }

  constructor() {
    this.stateDir = process.env.DISCORD_STATE_DIR || path.join(os.homedir(), '.gemini', 'channels', 'discord')
    this.file = path.join(this.stateDir, 'access.json')
  }

  async load(): Promise<void> {
    await fs.mkdir(this.stateDir, { recursive: true })
    try {
      const raw = await fs.readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw) as Partial<AccessFile>
      this.data = {
        users: parsed.users ?? {},
        channels: parsed.channels ?? {}
      }
    } catch (e: any) {
      if (e.code === 'ENOENT') {
        this.data = { ...EMPTY }
        await fs.writeFile(this.file, JSON.stringify(this.data, null, 2), 'utf8')
      } else {
        throw e
      }
    }
  }

  async save(): Promise<void> {
    await fs.writeFile(this.file, JSON.stringify(this.data, null, 2), 'utf8')
  }

  canHandle({ channelId, userId, isMention }: CanHandleInput): boolean {
    const user = this.data.users[userId]
    if (!user?.allowed) return false

    const channel = this.data.channels[channelId]
    if (!channel?.enabled) return false

    if (channel.requireMention && !isMention) return false

    return true
  }

  async allowUser(userId: string): Promise<void> {
    this.data.users[userId] = { allowed: true }
    await this.save()
  }

  async revokeUser(userId: string): Promise<void> {
    this.data.users[userId] = { allowed: false }
    await this.save()
  }

  async setChannel(
    channelId: string,
    enabled: boolean,
    requireMention: boolean,
    flags?: ChannelFlags
  ): Promise<void> {
    if (flags && !VALID_THINKING_MODES.includes(flags.thinking)) {
      throw new Error(`invalid thinking mode "${flags.thinking}" — must be one of: always, auto, never`)
    }
    this.data.channels[channelId] = {
      enabled,
      requireMention,
      thinking: flags?.thinking ?? 'auto',
      showCode: flags?.showCode ?? false
    }
    await this.save()
  }

  // Update only the rendering flags without touching enabled/requireMention.
  // Throws if the channel isn't configured yet — admins should run /gemini channel first.
  async setChannelFlags(
    channelId: string,
    patch: Partial<ChannelFlags>
  ): Promise<ChannelConfig> {
    const existing = this.data.channels[channelId]
    if (!existing) {
      throw new Error(`channel ${channelId} not configured — run /gemini channel first`)
    }
    if (patch.thinking !== undefined && !VALID_THINKING_MODES.includes(patch.thinking)) {
      throw new Error(`invalid thinking mode "${patch.thinking}" — must be one of: always, auto, never`)
    }
    this.data.channels[channelId] = {
      ...existing,
      ...(patch.thinking !== undefined ? { thinking: patch.thinking } : {}),
      ...(patch.showCode !== undefined ? { showCode: patch.showCode } : {})
    }
    await this.save()
    return this.data.channels[channelId]
  }

  // Per-channel rendering flags. Returns defaults for unknown channels and
  // for old configs that don't have these fields yet.
  channelFlags(channelId: string): ChannelFlags {
    const channel = this.data.channels[channelId]
    return {
      thinking: channel?.thinking ?? 'auto',
      showCode: channel?.showCode ?? false
    }
  }
}
