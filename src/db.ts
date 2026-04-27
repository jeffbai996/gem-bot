import Database from 'better-sqlite3'
import * as sqliteVss from 'sqlite-vss'
import path from 'path'
import os from 'os'

const STATE_DIR = process.env.DISCORD_STATE_DIR || path.join(os.homedir(), '.gemini', 'channels', 'discord')
const DB_PATH = path.join(STATE_DIR, 'memory.db')

export const db = new Database(DB_PATH)

// Load the sqlite-vss extension
sqliteVss.load(db)

// Initialize schema
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    author_name TEXT NOT NULL,
    content TEXT NOT NULL,
    timestamp DATETIME NOT NULL
  );

  -- Create VSS virtual table. 768 dimensions for Gemini text-embedding-004
  CREATE VIRTUAL TABLE IF NOT EXISTS vss_messages USING vss0(
    embedding(768)
  );

  -- One conversation summary per channel. Updated when un-summarized
  -- message count exceeds the threshold (see SummarizationScheduler).
  CREATE TABLE IF NOT EXISTS conversation_summaries (
    channel_id TEXT PRIMARY KEY,
    summary TEXT NOT NULL,
    last_summarized_message_id TEXT NOT NULL,
    updated_at DATETIME NOT NULL
  );
`)

// Prepare statements for efficiency
const insertMsgStmt = db.prepare(`
  INSERT OR IGNORE INTO messages (id, channel_id, author_name, content, timestamp)
  VALUES (?, ?, ?, ?, ?)
`)

const insertVssStmt = db.prepare(`
  INSERT OR IGNORE INTO vss_messages (rowid, embedding)
  VALUES (?, ?)
`)

export function insertMessage(
  id: string,
  channelId: string,
  authorName: string,
  content: string,
  timestamp: string,
  embeddingArray: number[]
) {
  // Convert embedding array to a JSON string or buffer depending on what vss0 expects.
  // sqlite-vss expects a JSON array string representation.
  const embeddingJson = JSON.stringify(embeddingArray)

  const transaction = db.transaction(() => {
    const info = insertMsgStmt.run(id, channelId, authorName, content, timestamp)
    // Use lastInsertRowid to map the vss row back to the message table.
    // However, since id is a TEXT (Discord ID), we need a rowid binding.
    // Let's alter the schema slightly or use a mapping table, OR just rely on SQLite's internal rowid.
    // better-sqlite3 info.lastInsertRowid gives the rowid of the newly inserted message.
    if (info.changes > 0) {
      insertVssStmt.run(info.lastInsertRowid, embeddingJson)
    }
  })

  transaction()
}

export interface SearchResult {
  id: string
  channel_id: string
  author_name: string
  content: string
  timestamp: string
  distance: number
}

const searchStmt = db.prepare(`
  SELECT m.id, m.channel_id, m.author_name, m.content, m.timestamp, v.distance
  FROM vss_messages v
  JOIN messages m ON v.rowid = m.rowid
  WHERE vss_search(v.embedding, vss_search_params(?, ?))
  AND m.channel_id = ?
`)

export function searchMessages(channelId: string, queryEmbedding: number[], limit: number = 10): SearchResult[] {
  const queryJson = JSON.stringify(queryEmbedding)
  return searchStmt.all(queryJson, limit, channelId) as SearchResult[]
}

// Fetch raw messages for summarization, in chronological order. `since` is a
// Discord message ID; only messages with id > since are returned. Cast to
// INTEGER for proper numeric ordering of snowflake IDs.
const fetchMessagesSinceStmt = db.prepare(`
  SELECT id, channel_id, author_name, content, timestamp
  FROM messages
  WHERE channel_id = ?
    AND (? IS NULL OR CAST(id AS INTEGER) > CAST(? AS INTEGER))
  ORDER BY CAST(id AS INTEGER) ASC
  LIMIT ?
`)

export interface MessageRow {
  id: string
  channel_id: string
  author_name: string
  content: string
  timestamp: string
}

export function fetchMessagesSince(channelId: string, sinceMessageId: string | null, limit: number): MessageRow[] {
  return fetchMessagesSinceStmt.all(channelId, sinceMessageId, sinceMessageId, limit) as MessageRow[]
}

const upsertSummaryStmt = db.prepare(`
  INSERT INTO conversation_summaries (channel_id, summary, last_summarized_message_id, updated_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(channel_id) DO UPDATE SET
    summary = excluded.summary,
    last_summarized_message_id = excluded.last_summarized_message_id,
    updated_at = excluded.updated_at
`)

const getSummaryStmt = db.prepare(`
  SELECT channel_id, summary, last_summarized_message_id, updated_at
  FROM conversation_summaries WHERE channel_id = ?
`)

export interface SummaryRow {
  channel_id: string
  summary: string
  last_summarized_message_id: string
  updated_at: string
}

export function upsertSummary(channelId: string, summary: string, lastMessageId: string): void {
  upsertSummaryStmt.run(channelId, summary, lastMessageId, new Date().toISOString())
}

export function getSummary(channelId: string): SummaryRow | null {
  return (getSummaryStmt.get(channelId) as SummaryRow | undefined) ?? null
}
