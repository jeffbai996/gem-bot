import Database from 'better-sqlite3'
import * as sqliteVss from 'sqlite-vss'
import path from 'path'
import os from 'os'
import fs from 'fs'

const STATE_DIR = process.env.DISCORD_STATE_DIR || path.join(os.homedir(), '.gemini', 'channels', 'discord')
fs.mkdirSync(STATE_DIR, { recursive: true })
const DB_PATH = path.join(STATE_DIR, 'memory.db')

const db = new Database(DB_PATH)

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

  -- One row per channel currently mid-turn, pointing at the Discord message
  -- being live-edited (the "💭 Thinking..." placeholder / streaming reply).
  -- Written when that message first exists, cleared in the turn's finally
  -- block on any normal exit (success, handled error, barge-in abort). A row
  -- left behind at startup means the PREVIOUS process died mid-turn (crash,
  -- OOM, manual restart) before its own finally block could run — the
  -- startup sweep in client.once('ready') uses this to find and settle those
  -- orphaned messages instead of leaving them frozen forever. (Jeff
  -- 2026-06-30 — mirrors the Claude bots' narrate.py "✗ Interrupted" pattern,
  -- which needs a persisted marker for the same reason: the process that
  -- would fix it up in-place is the one that's gone.)
  CREATE TABLE IF NOT EXISTS in_flight_turns (
    channel_id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    updated_at DATETIME NOT NULL
  );
`)

// Lightweight migration guard: CREATE TABLE IF NOT EXISTS above is a no-op
// once the table already exists, so a column added after first deploy (like
// user_message_id, added 2026-06-30) needs an explicit ALTER TABLE or every
// box that already created the old 3-column table crashes on boot with
// "no column named user_message_id". Idempotent — checks before adding.
{
  const cols = db.prepare(`PRAGMA table_info(in_flight_turns)`).all() as Array<{ name: string }>
  if (!cols.some(c => c.name === 'user_message_id')) {
    db.exec(`ALTER TABLE in_flight_turns ADD COLUMN user_message_id TEXT`)
  }
}

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

const recordInFlightTurnStmt = db.prepare(`
  INSERT INTO in_flight_turns (channel_id, message_id, user_message_id, updated_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(channel_id) DO UPDATE SET
    message_id = excluded.message_id,
    user_message_id = excluded.user_message_id,
    updated_at = excluded.updated_at
`)

const clearInFlightTurnStmt = db.prepare(`
  DELETE FROM in_flight_turns WHERE channel_id = ?
`)

const getAllInFlightTurnsStmt = db.prepare(`
  SELECT channel_id, message_id, user_message_id FROM in_flight_turns
`)

export interface InFlightTurnRow {
  channel_id: string
  message_id: string
  user_message_id: string | null
}

export function recordInFlightTurn(channelId: string, messageId: string, userMessageId?: string): void {
  recordInFlightTurnStmt.run(channelId, messageId, userMessageId ?? null, new Date().toISOString())
}

export function clearInFlightTurn(channelId: string): void {
  clearInFlightTurnStmt.run(channelId)
}

export function getAllInFlightTurns(): InFlightTurnRow[] {
  return getAllInFlightTurnsStmt.all() as InFlightTurnRow[]
}
