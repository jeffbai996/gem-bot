import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  crossChannelEnabled,
  formatCrossChannelContext,
  formatCrossChannelRecall,
  formatOtherChannelsDigest,
  relativeAge,
  type CrossChannelInput,
} from '../src/cross-channel.ts'
import type { SearchResult } from '../src/db.ts'

const NOW = Date.parse('2026-09-17T12:00:00.000Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const HOUR = 60 * 60 * 1000

function activity(channelId: string, overrides: Partial<{
  author_name: string; content: string; timestamp: string; message_count: number
}> = {}) {
  return {
    channel_id: channelId,
    author_name: overrides.author_name ?? 'someone',
    content: overrides.content ?? 'shipping the portfolio fix',
    timestamp: overrides.timestamp ?? ago(2 * HOUR),
    message_count: overrides.message_count ?? 12,
  }
}

function hit(channelId: string, overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    id: overrides.id ?? '1',
    channel_id: channelId,
    author_name: overrides.author_name ?? 'someone',
    content: overrides.content ?? 'the transcription service runs on the box',
    timestamp: overrides.timestamp ?? ago(30 * HOUR),
    distance: overrides.distance ?? 0.2,
  }
}

function input(overrides: Partial<CrossChannelInput> = {}): CrossChannelInput {
  return {
    activity: overrides.activity ?? [],
    summaries: overrides.summaries ?? new Map(),
    hits: overrides.hits ?? [],
    visibleChannelIds: overrides.visibleChannelIds ?? new Set(['dev', 'ops', 'here']),
    currentChannelId: overrides.currentChannelId ?? 'here',
    label: overrides.label ?? (id => `#${id}`),
    now: overrides.now ?? NOW,
  }
}

test('digest lists other channels, newest first', () => {
  const out = formatOtherChannelsDigest(input({
    activity: [
      activity('dev', { timestamp: ago(5 * HOUR), content: 'merged the branch' }),
      activity('ops', { timestamp: ago(1 * HOUR), content: 'whisper restarted' }),
    ],
  }))
  assert.match(out, /#ops/)
  assert.match(out, /#dev/)
  assert.ok(out.indexOf('#ops') < out.indexOf('#dev'), 'newest channel comes first')
  assert.match(out, /1h ago, 12 msgs/)
})

test('digest prefers a rolling summary over the last raw message', () => {
  const out = formatOtherChannelsDigest(input({
    activity: [activity('dev', { content: 'k' })],
    summaries: new Map([['dev', 'The squad rebuilt the deploy pipeline.']]),
  }))
  assert.match(out, /rebuilt the deploy pipeline/)
  assert.doesNotMatch(out, /someone: k/)
})

test('the current channel never appears in its own cross-channel context', () => {
  const out = formatCrossChannelContext(input({
    activity: [activity('here')],
    hits: [hit('here')],
  }))
  assert.equal(out, '')
})

test('channels outside the visible set are dropped', () => {
  const out = formatCrossChannelContext(input({
    activity: [activity('secret')],
    hits: [hit('secret')],
    visibleChannelIds: new Set(['dev', 'here']),
  }))
  assert.equal(out, '')
})

test('digest ignores channels quiet for longer than the window', () => {
  const out = formatOtherChannelsDigest(input({
    activity: [activity('dev', { timestamp: ago(200 * HOUR) })],
  }))
  assert.equal(out, '')
})

test('recall sorts by distance and labels the source channel', () => {
  const out = formatCrossChannelRecall(input({
    hits: [
      hit('dev', { id: '1', distance: 0.9, content: 'far match' }),
      hit('ops', { id: '2', distance: 0.1, content: 'near match' }),
    ],
  }))
  assert.ok(out.indexOf('near match') < out.indexOf('far match'))
  assert.match(out, /#ops \[/)
  assert.match(out, /OTHER channels/)
})

test('both blocks render together when both have content', () => {
  const out = formatCrossChannelContext(input({
    activity: [activity('dev')],
    hits: [hit('ops')],
  }))
  assert.match(out, /recent activity/)
  assert.match(out, /OTHER channels/)
})

test('relativeAge degrades sanely', () => {
  assert.equal(relativeAge(ago(30_000), NOW), 'just now')
  assert.equal(relativeAge(ago(5 * 60_000), NOW), '5m ago')
  assert.equal(relativeAge(ago(5 * HOUR), NOW), '5h ago')
  assert.equal(relativeAge(ago(96 * HOUR), NOW), '4d ago')
  assert.equal(relativeAge('not a date', NOW), 'unknown')
})

test('the kill switch is honoured', () => {
  const previous = process.env.GEMMA_CROSS_CHANNEL
  try {
    delete process.env.GEMMA_CROSS_CHANNEL
    assert.equal(crossChannelEnabled(), true)
    process.env.GEMMA_CROSS_CHANNEL = '0'
    assert.equal(crossChannelEnabled(), false)
  } finally {
    if (previous === undefined) delete process.env.GEMMA_CROSS_CHANNEL
    else process.env.GEMMA_CROSS_CHANNEL = previous
  }
})
