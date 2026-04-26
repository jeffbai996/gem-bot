import fs from 'fs/promises'
import fsSync from 'fs'

const MAX_FACT_LEN = 1500

export interface PinnedFact {
  timestamp: string
  content: string
}

// Per-channel append-only "pinned facts" file. Sectioned by channel id.
// Section header: "## <channelId> — <channelName>"
// Bullets: "- [<ISO timestamp>] <content (truncated to 1500 chars)>"
// Read into the system prompt for the matching channel on every turn.
export class PinnedFactsStore {
  constructor(private file: string) {}

  async append(channelId: string, channelName: string, content: string): Promise<void> {
    const truncated = content.length > MAX_FACT_LEN
      ? content.slice(0, MAX_FACT_LEN) + '...'
      : content
    const line = `- [${new Date().toISOString()}] ${truncated.replace(/\n+/g, ' ')}`

    let body = ''
    try { body = await fs.readFile(this.file, 'utf8') } catch { /* new file */ }

    const sectionHeader = `## ${channelId} — ${channelName}`
    if (body.includes(sectionHeader)) {
      const lines = body.split('\n')
      const idx = lines.findIndex(l => l === sectionHeader)
      let end = idx + 1
      while (end < lines.length && !lines[end].startsWith('## ')) end++
      // Trim trailing empty lines from the section before inserting
      while (end > idx + 1 && lines[end - 1].trim() === '') end--
      lines.splice(end, 0, line)
      body = lines.join('\n')
    } else {
      if (body && !body.endsWith('\n')) body += '\n'
      if (body) body += '\n'
      body += `${sectionHeader}\n\n${line}\n`
    }
    await fs.writeFile(this.file, body, 'utf8')
  }

  async readForChannel(channelId: string): Promise<PinnedFact[]> {
    let body: string
    try { body = await fs.readFile(this.file, 'utf8') } catch { return [] }
    return this.parseSection(body, channelId)
  }

  // Sync read for system-prompt assembly. Returns the markdown body for a
  // channel (bullets only, no section header) or empty string.
  readForChannelSync(channelId: string): string {
    let body: string
    try { body = fsSync.readFileSync(this.file, 'utf8') } catch { return '' }
    const lines = body.split('\n')
    const headerRegex = new RegExp(`^## ${this.escape(channelId)} — `)
    const idx = lines.findIndex(l => headerRegex.test(l))
    if (idx === -1) return ''
    const out: string[] = []
    for (let i = idx + 1; i < lines.length; i++) {
      if (lines[i].startsWith('## ')) break
      if (lines[i].trim()) out.push(lines[i])
    }
    return out.join('\n').trim()
  }

  private parseSection(body: string, channelId: string): PinnedFact[] {
    const lines = body.split('\n')
    const headerRegex = new RegExp(`^## ${this.escape(channelId)} — `)
    const idx = lines.findIndex(l => headerRegex.test(l))
    if (idx === -1) return []
    const out: PinnedFact[] = []
    for (let i = idx + 1; i < lines.length; i++) {
      if (lines[i].startsWith('## ')) break
      const m = lines[i].match(/^- \[([^\]]+)\] (.*)$/)
      if (m) out.push({ timestamp: m[1], content: m[2] })
    }
    return out
  }

  private escape(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
}
