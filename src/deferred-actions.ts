import { readFileSync, writeFileSync } from 'node:fs'
import type { Client } from 'discord.js'

interface Deferred {
  channelId: string
  messageId: string
  action: 'delete'
  dueAt: number
}

// Durable registry for delayed cleanup. Collapse-mode thought/trace cards linger
// briefly, but a restart during that window used to strand them forever.
export class DeferredActions {
  private items: Deferred[] = []

  constructor(private readonly file: string) {
    try { this.items = JSON.parse(readFileSync(file, 'utf8')) } catch { this.items = [] }
  }

  private flush(): void {
    try { writeFileSync(this.file, JSON.stringify(this.items)) } catch { /* best-effort */ }
  }

  private async run(client: Client, d: Deferred): Promise<void> {
    try {
      const ch = await client.channels.fetch(d.channelId)
      if (ch && ch.isTextBased()) {
        const msg = await ch.messages.fetch(d.messageId)
        if (d.action === 'delete') await msg.delete()
      }
    } catch { /* message gone / no access */ }
    this.items = this.items.filter(x => !(x.messageId === d.messageId && x.action === d.action))
    this.flush()
  }

  schedule(client: Client, d: Deferred): void {
    this.items.push(d)
    this.flush()
    setTimeout(() => { void this.run(client, d) }, Math.max(0, d.dueAt - Date.now()))
  }

  rearm(client: Client): void {
    for (const d of [...this.items]) {
      setTimeout(() => { void this.run(client, d) }, Math.max(0, d.dueAt - Date.now()))
    }
  }
}
