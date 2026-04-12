import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import crypto from 'crypto'

export interface Access {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  allowFrom: string[]
  groups: Record<string, {
    requireMention: boolean
    allowFrom: string[]
  }>
  pending: Record<string, {
    senderId: string
    chatId: string
    createdAt: number
    expiresAt: number
    replies: number
  }>
  mentionPatterns?: string[]
  ackReaction?: string
  replyToMode?: 'off' | 'first' | 'all'
  textChunkLimit?: number
  chunkMode?: 'length' | 'newline'
}

const DEFAULT_ACCESS: Access = {
  dmPolicy: 'pairing',
  allowFrom: [],
  groups: {},
  pending: {}
}

export class AccessManager {
  private configDir: string
  private accessFile: string
  private approvedDir: string
  public access: Access = { ...DEFAULT_ACCESS }

  constructor() {
    this.configDir = process.env.DISCORD_STATE_DIR || path.join(os.homedir(), '.gemini', 'channels', 'discord')
    this.accessFile = path.join(this.configDir, 'access.json')
    this.approvedDir = path.join(this.configDir, 'approved')
  }

  async init() {
    await fs.mkdir(this.configDir, { recursive: true })
    await fs.mkdir(this.approvedDir, { recursive: true })
    await this.load()
  }

  async load() {
    try {
      const data = await fs.readFile(this.accessFile, 'utf-8')
      this.access = { ...DEFAULT_ACCESS, ...JSON.parse(data) }
    } catch (e: any) {
      if (e.code === 'ENOENT') {
        await this.save()
      } else {
        console.error('Failed to load access.json:', e)
      }
    }
  }

  async save() {
    if (process.env.DISCORD_ACCESS_MODE === 'static') return
    await fs.writeFile(this.accessFile, JSON.stringify(this.access, null, 2), 'utf-8')
  }

  // Gate Check for inbound messages
  canHandle(channelId: string, senderId: string, isDm: boolean, isMention: boolean): 'allow' | 'pair' | 'deny' {
    if (isDm) {
      if (this.access.allowFrom.includes(senderId)) return 'allow'
      if (this.access.dmPolicy === 'pairing') return 'pair'
      return 'deny'
    } else {
      const group = this.access.groups[channelId]
      if (!group) return 'deny'
      if (group.requireMention && !isMention) return 'deny'
      if (group.allowFrom && group.allowFrom.length > 0 && !group.allowFrom.includes(senderId)) return 'deny'
      return 'allow'
    }
  }

  canSendTo(channelId: string, recipientId?: string): boolean {
    if (this.access.groups[channelId]) return true
    if (recipientId && this.access.allowFrom.includes(recipientId)) return true
    return false
  }

  async generatePairing(senderId: string, chatId: string): Promise<string> {
    // Clean up expired pending
    const now = Date.now()
    for (const [code, p] of Object.entries(this.access.pending)) {
      if (p.expiresAt < now) delete this.access.pending[code]
    }

    const existingCode = Object.keys(this.access.pending).find(k => this.access.pending[k].senderId === senderId)
    if (existingCode) return existingCode

    const code = crypto.randomBytes(3).toString('hex').toLowerCase()
    this.access.pending[code] = {
      senderId,
      chatId,
      createdAt: now,
      expiresAt: now + 3600000, // 1 hour
      replies: 0
    }
    await this.save()
    return code
  }
}