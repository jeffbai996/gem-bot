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
