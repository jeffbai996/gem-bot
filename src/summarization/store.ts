import { getSummary as defaultGet, upsertSummary as defaultUpsert, type SummaryRow } from '../db.ts'

export interface SummaryRecord {
  channelId: string
  summary: string
  lastSummarizedMessageId: string
  updatedAt: string
}

export interface SummaryDeps {
  getSummary: (channelId: string) => SummaryRow | null
  upsertSummary: (channelId: string, summary: string, lastMessageId: string) => void
}

// Thin wrapper over the SQLite-backed conversation_summaries table.
// The DI surface lets tests swap in a fake without touching the real DB.
export class SummaryStore {
  private deps: SummaryDeps
  constructor(deps: SummaryDeps = { getSummary: defaultGet, upsertSummary: defaultUpsert }) {
    this.deps = deps
  }

  get(channelId: string): SummaryRecord | null {
    const row = this.deps.getSummary(channelId)
    if (!row) return null
    return {
      channelId: row.channel_id,
      summary: row.summary,
      lastSummarizedMessageId: row.last_summarized_message_id,
      updatedAt: row.updated_at
    }
  }

  upsert(channelId: string, summary: string, lastMessageId: string): void {
    this.deps.upsertSummary(channelId, summary, lastMessageId)
  }
}
