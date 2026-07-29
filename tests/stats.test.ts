import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  GemStats,
  formatStats,
  pacificDay,
  type StatsSnapshot,
} from '../src/stats.ts'

test('stats persist engine totals and API usage across restarts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gem-stats-'))
  const file = path.join(dir, 'stats.json')
  const stats = new GemStats(file, 1_000)

  stats.record({
    engine: 'api',
    model: 'gemini-example',
    elapsedMs: 2_500,
    usage: { promptTokens: 1_000, responseTokens: 200, cachedTokens: 400, totalTokens: 1_200 },
  }, Date.UTC(2026, 6, 28, 12))
  stats.record({
    engine: 'agy',
    model: 'agy-example',
    elapsedMs: 5_000,
    usage: null,
  }, Date.UTC(2026, 6, 28, 13))

  const restored = new GemStats(file, 2_000).snapshot()
  assert.equal(restored.all.turns, 2)
  assert.equal(restored.all.byEngine.api, 1)
  assert.equal(restored.all.byEngine.agy, 1)
  assert.equal(restored.all.promptTokens, 1_000)
  assert.equal(restored.all.cachedTokens, 400)
  assert.equal(restored.all.elapsedMs, 7_500)
  assert.deepEqual(restored.all.byModel, { 'gemini-example': 1, 'agy-example': 1 })
})

test('stats bucket turns by Pacific day', () => {
  assert.equal(pacificDay(Date.UTC(2026, 6, 29, 6, 30)), '2026-07-28')
  assert.equal(pacificDay(Date.UTC(2026, 6, 29, 8, 30)), '2026-07-29')
})

test('agy-only stats omit token and cache rows', () => {
  const snapshot: StatsSnapshot = {
    bootTs: 0,
    since: 0,
    all: {
      turns: 3,
      elapsedMs: 9_000,
      promptTokens: 0,
      responseTokens: 0,
      cachedTokens: 0,
      byEngine: { agy: 3, api: 0 },
      byModel: { 'agy-example': 3 },
    },
    today: {
      turns: 3,
      elapsedMs: 9_000,
      promptTokens: 0,
      responseTokens: 0,
      cachedTokens: 0,
      byEngine: { agy: 3, api: 0 },
      byModel: { 'agy-example': 3 },
    },
  }

  const rendered = formatStats(snapshot, 60_000)
  assert.match(rendered, /turns:\s+3/)
  assert.match(rendered, /engines:\s+agy 3/)
  assert.doesNotMatch(rendered, /input:|output:|cached:/)
})

test('API stats render token and cache rows without unavailable placeholders', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gem-stats-'))
  const stats = new GemStats(path.join(dir, 'stats.json'), 0)
  stats.record({
    engine: 'api',
    model: 'gemini-example',
    elapsedMs: 1_000,
    usage: { promptTokens: 2_000, responseTokens: 300, cachedTokens: 500, totalTokens: 2_300 },
  })

  const rendered = formatStats(stats.snapshot(), 60_000)
  assert.match(rendered, /input:\s+2,000 tok/)
  assert.match(rendered, /500 cached, 25%/)
  assert.match(rendered, /output:\s+300 tok/)
  assert.doesNotMatch(rendered, /unavailable/i)
})
