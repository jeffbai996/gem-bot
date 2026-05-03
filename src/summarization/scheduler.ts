import type { GeminiClient } from '../gemini.ts'
import type { SummaryStore } from './store.ts'
import { runSummarization, type SummarizableMessage } from './summarizer.ts'

export interface SchedulerDeps {
  store: SummaryStore
  fetchSinceForSummarization: (channelId: string, since: string | null, limit: number) => Promise<SummarizableMessage[]>
  gemini: Pick<GeminiClient, 'completeText'>
  threshold: number
  batchLimit?: number
}

// Single-flight per channel: scheduleIfNeeded() is idempotent within an
// in-flight run, and fire-and-forget from the caller's perspective. Errors
// are logged, never thrown back to the caller (the reply path).
export class SummarizationScheduler {
  private inFlight = new Map<string, Promise<void>>()
  constructor(private deps: SchedulerDeps) {}

  scheduleIfNeeded(channelId: string): void {
    if (this.inFlight.has(channelId)) return
    const p = this.runIfThresholdMet(channelId)
      .catch(e => console.error(`[summarization] failed for ${channelId}:`, e))
      .finally(() => this.inFlight.delete(channelId))
    this.inFlight.set(channelId, p)
  }

  // Force a summarization run regardless of the message threshold. Returns
  // the count of messages summarized, or null if there were 0 new messages
  // to summarize (no-op). Awaits the actual run — used by the /gemini compact
  // slash command so the user gets confirmation when it's done.
  async runForChannel(channelId: string): Promise<{ messageCount: number } | null> {
    if (this.inFlight.has(channelId)) {
      // Wait for the existing run to finish; treat as best-effort.
      await this.inFlight.get(channelId)!.catch(() => {})
    }
    const p = this.runForce(channelId)
      .finally(() => this.inFlight.delete(channelId))
    this.inFlight.set(channelId, p.then(() => undefined))
    return p
  }

  private async runIfThresholdMet(channelId: string): Promise<void> {
    const existing = this.deps.store.get(channelId)
    const since = existing?.lastSummarizedMessageId ?? null
    const limit = this.deps.batchLimit ?? 500
    const messages = await this.deps.fetchSinceForSummarization(channelId, since, limit)
    if (messages.length < this.deps.threshold) return
    const { summary, lastMessageId } = await runSummarization(
      existing?.summary ?? null,
      messages,
      this.deps.gemini
    )
    this.deps.store.upsert(channelId, summary, lastMessageId)
    console.error(`[summarization] updated channel ${channelId}; summarized ${messages.length} new messages`)
  }

  private async runForce(channelId: string): Promise<{ messageCount: number } | null> {
    const existing = this.deps.store.get(channelId)
    const since = existing?.lastSummarizedMessageId ?? null
    const limit = this.deps.batchLimit ?? 500
    const messages = await this.deps.fetchSinceForSummarization(channelId, since, limit)
    if (messages.length === 0) return null
    const { summary, lastMessageId } = await runSummarization(
      existing?.summary ?? null,
      messages,
      this.deps.gemini
    )
    this.deps.store.upsert(channelId, summary, lastMessageId)
    console.error(`[summarization] forced rollup for ${channelId}; summarized ${messages.length} messages`)
    return { messageCount: messages.length }
  }
}
