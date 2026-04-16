import fs from 'fs/promises'
import fsSync from 'fs'
import path from 'path'
import os from 'os'

const DEFAULT_PERSONA = `You are Gemma, a Discord bot backed by Google's Gemini model. Be helpful, concise, and match the channel's tone. You can respond with text, an emoji reaction, or both.`

function stateDir(): string {
  return process.env.DISCORD_STATE_DIR || path.join(os.homedir(), '.gemini', 'channels', 'discord')
}

function squadDir(): string {
  return process.env.SQUAD_CONTEXT_DIR || path.join(os.homedir(), 'claude-agents', 'shared', 'squad-context')
}

export class PersonaLoader {
  private persona: string = DEFAULT_PERSONA
  private memories: string = ''

  async load(): Promise<void> {
    this.persona = await this.readPersona()
    this.memories = await this.readMemories()
  }

  private async readPersona(): Promise<string> {
    const file = path.join(stateDir(), 'persona.md')
    try {
      const text = (await fs.readFile(file, 'utf8')).trim()
      return text || DEFAULT_PERSONA
    } catch (e: any) {
      if (e.code === 'ENOENT') return DEFAULT_PERSONA
      throw e
    }
  }

  private async readMemories(): Promise<string> {
    const dir = path.join(squadDir(), 'memories')
    try {
      const entries = await fs.readdir(dir)
      const mdFiles = entries.filter(f => f.endsWith('.md')).sort()
      const bodies: string[] = []
      for (const f of mdFiles) {
        try {
          const body = (await fs.readFile(path.join(dir, f), 'utf8')).trim()
          if (body) bodies.push(`### ${f}\n${body}`)
        } catch { /* skip unreadable file */ }
      }
      return bodies.join('\n\n')
    } catch (e: any) {
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return ''
      throw e
    }
  }

  private readChannelSummary(channelId: string): string {
    const file = path.join(squadDir(), 'summaries', `${channelId}.md`)
    try {
      return fsSync.readFileSync(file, 'utf8').trim()
    } catch {
      return ''
    }
  }

  buildSystemPrompt(channelId: string): string {
    const summary = this.readChannelSummary(channelId)

    const sections: string[] = [this.persona]
    if (this.memories) {
      sections.push(`## Shared squad memories\n\n${this.memories}`)
    }
    if (summary) {
      sections.push(`## Current channel summary\n\n${summary}`)
    }
    return sections.join('\n\n---\n\n')
  }
}
