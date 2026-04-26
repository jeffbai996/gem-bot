interface PendingEdit {
  botMessageId: string
  expiresAt: number
}

// In-memory map: channelId → bot message id, with TTL. Used by ✏️ flow:
// reaction marks a bot message as edit-target; the user's next message in
// that channel edits it instead of creating a new reply.
export class PendingEditsStore {
  private map = new Map<string, PendingEdit>()

  set(channelId: string, botMessageId: string, ttlMs: number = 5 * 60 * 1000): void {
    this.map.set(channelId, { botMessageId, expiresAt: Date.now() + ttlMs })
  }

  get(channelId: string): string | null {
    const entry = this.map.get(channelId)
    if (!entry) return null
    if (Date.now() >= entry.expiresAt) {
      this.map.delete(channelId)
      return null
    }
    return entry.botMessageId
  }

  clear(channelId: string): void {
    this.map.delete(channelId)
  }
}
