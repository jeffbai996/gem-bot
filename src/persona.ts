import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { PinnedFactsStore } from './pinned-facts.ts'
import type { SummaryStore } from './summarization/store.ts'

const DEFAULT_PERSONA = `You are Gemma, a Discord bot backed by Google's Gemini model. Be helpful, concise, and match the channel's tone. You can respond with text, an emoji reaction, or both.`
const DEFAULT_PERSONA_FILE = 'GEMINI.md'
const LEGACY_PERSONA_FILE = 'persona.md'
const RUNTIME_CAPABILITIES = `## Bot-local runtime capabilities

You can set your own Discord status. When a genuine status change is requested,
include [[presence: <short status>]] anywhere in your reply. The bot harness
applies it immediately, persists it across restarts, and strips the directive
before the message is posted. Do not claim that you lack a mechanism to update
your status; use the directive in the same reply that confirms the change.

## Bot-local conversation context

Recent Discord channel history is already loaded into each turn when available.
It is visible context, not something you need to request. Use that visible history first
whenever the user refers to this channel, earlier messages, what was being discussed,
or a preceding item. Use search_memory only when the needed context is older than the
loaded recent-history tail.

Only ask the user to paste context after both the loaded history and the available
history search genuinely cannot supply it. Never claim that channel history does not
auto-load, that you cannot read the current conversation, or that you need a handoff
when the relevant messages are already present.`

function stateDir(): string {
  return process.env.DISCORD_STATE_DIR || path.join(os.homedir(), '.gemini', 'channels', 'discord')
}

export class PersonaLoader {
  private persona: string = DEFAULT_PERSONA
  private activePersonaFile: string = DEFAULT_PERSONA_FILE
  private guildPersonas: Map<string, string> = new Map()
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
    await this.discoverGuildPersonas()
  }

  private async discoverGuildPersonas(): Promise<void> {
    this.guildPersonas.clear()
    try {
      const entries = await fs.readdir(stateDir())
      for (const name of entries) {
        const m = name.match(/^persona\.(\d{17,20})\.md$/)
        if (!m) continue
        const text = await this.readPersona(name)
        this.guildPersonas.set(m[1], text)
      }
    } catch (e: any) {
      if (e.code !== 'ENOENT') throw e
    }
  }

  private async readPersona(filename: string): Promise<string> {
    const filenames = filename === DEFAULT_PERSONA_FILE
      ? [DEFAULT_PERSONA_FILE, LEGACY_PERSONA_FILE]
      : [filename]

    for (const candidate of filenames) {
      const file = path.join(stateDir(), candidate)
      try {
        const text = (await fs.readFile(file, 'utf8')).trim()
        return text || DEFAULT_PERSONA
      } catch (e: any) {
        if (e.code === 'ENOENT') continue
        throw e
      }
    }
    return DEFAULT_PERSONA
  }

  buildSystemPrompt(channelId: string, guildId?: string | null): string {
    const persona = (guildId && this.guildPersonas.get(guildId)) || this.persona
    const conversationSummary = this.summaryStore?.get(channelId)?.summary ?? ''
    const pinned = this.pinnedFacts?.readForChannelSync(channelId) ?? ''

    // Wall-clock stamp, rebuilt every turn so the model knows the current time
    // (matches the squad's cc-inject-time hook format on the Claude bots).
    const now = new Date()
    const wallClock = `Current time: ${now.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })} (${Intl.DateTimeFormat().resolvedOptions().timeZone})`

    const sections: string[] = [persona, wallClock, RUNTIME_CAPABILITIES]
    if (conversationSummary) {
      sections.push(`## Conversation summary (older context)\n\n${conversationSummary}`)
    }
    if (pinned) {
      sections.push(`## Pinned facts for this channel\n\n${pinned}`)
    }
    return sections.join('\n\n---\n\n')
  }
}
