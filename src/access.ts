import fs from 'fs/promises'
import path from 'path'
import os from 'os'

export interface AccessFile {
  users: Record<string, { allowed: boolean }>
  channels: Record<string, { enabled: boolean; requireMention: boolean }>
}

export interface CanHandleInput {
  channelId: string
  userId: string
  isMention: boolean
}

const EMPTY: AccessFile = { users: {}, channels: {} }

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

  canHandle({ channelId, userId, isMention }: CanHandleInput): boolean {
    const user = this.data.users[userId]
    if (!user?.allowed) return false

    const channel = this.data.channels[channelId]
    if (!channel?.enabled) return false

    if (channel.requireMention && !isMention) return false

    return true
  }
}
