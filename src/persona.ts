import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { PinnedFactsStore } from './pinned-facts.ts'
import type { SummaryStore } from './summarization/store.ts'

const DEFAULT_PERSONA = `You are Gemma, a Discord bot backed by Google's Gemini model. Be helpful, concise, and match the channel's tone. You can respond with text, an emoji reaction, or both.`

function stateDir(): string {
  return process.env.DISCORD_STATE_DIR || path.join(os.homedir(), '.gemini', 'channels', 'discord')
}

export class PersonaLoader {
  private persona: string = DEFAULT_PERSONA
  private activePersonaFile: string = 'persona.md'
  private pinnedFacts: PinnedFactsStore | null = null
  private summaryStore: SummaryStore | null = null

  setPinnedFactsStore(store: PinnedFactsStore): void {
    this.pinnedFacts = store
  }

  setSummaryStore(store: SummaryStore): void {
    this.summaryStore = store
  }

  async load(filename?: string): Promise<void> {
    if (filename) this.activePersonaFile = filename
    this.persona = await this.readPersona(this.activePersonaFile)
  }

  private async readPersona(filename: string): Promise<string> {
    const file = path.join(stateDir(), filename)
    try {
      const text = (await fs.readFile(file, 'utf8')).trim()
      return text || DEFAULT_PERSONA
    } catch (e: any) {
      if (e.code === 'ENOENT') return DEFAULT_PERSONA
      throw e
    }
  }

  buildSystemPrompt(channelId: string): string {
    const conversationSummary = this.summaryStore?.get(channelId)?.summary ?? ''
    const pinned = this.pinnedFacts?.readForChannelSync(channelId) ?? ''

    const sections: string[] = [this.persona]
    if (conversationSummary) {
      sections.push(`## Conversation summary (older context)\n\n${conversationSummary}`)
    }
    if (pinned) {
      sections.push(`## Pinned facts for this channel\n\n${pinned}`)
    }
    return sections.join('\n\n---\n\n')
  }
}
