// The vss0 index is serialized in full on every commit that touches it, so
// one embedded message cost ~100 MB of writes (16 GB/day on the root SSD,
// 2026-09-12). Embeddings now queue and land in one transaction per batch.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'

process.env.DISCORD_STATE_DIR = path.join('.test-state', 'db-batch-' + process.pid)
process.env.VSS_BATCH_SIZE = '3'
process.env.VSS_FLUSH_MS = '0'
fs.rmSync(process.env.DISCORD_STATE_DIR, { recursive: true, force: true })

const dbMod = await import('../src/db.ts')
const { insertMessage, flushEmbeddings, pendingEmbeddings, countVssRows } = dbMod as any

const vec = () => Array.from({ length: 768 }, (_, i) => (i % 7) / 7)

test('embeddings queue until the batch size is reached, then land in one commit', () => {
  insertMessage('m1', 'c', 'a', 'one', '2026-09-12T00:00:00Z', vec())
  insertMessage('m2', 'c', 'a', 'two', '2026-09-12T00:00:01Z', vec())
  assert.equal(pendingEmbeddings(), 2)
  assert.equal(countVssRows(), 0)
  insertMessage('m3', 'c', 'a', 'three', '2026-09-12T00:00:02Z', vec())
  assert.equal(pendingEmbeddings(), 0)
  assert.equal(countVssRows(), 3)
})

test('an explicit flush lands a partial batch and a duplicate message is not queued twice', () => {
  insertMessage('m4', 'c', 'a', 'four', '2026-09-12T00:00:03Z', vec())
  insertMessage('m4', 'c', 'a', 'four again', '2026-09-12T00:00:03Z', vec())
  assert.equal(pendingEmbeddings(), 1)
  assert.equal(flushEmbeddings(), 1)
  assert.equal(pendingEmbeddings(), 0)
  assert.equal(countVssRows(), 4)
  assert.equal(flushEmbeddings(), 0)
})
