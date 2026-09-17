// Cross-channel awareness: the bot keeps one provider session PER channel, so a
// turn in #dev knows nothing about a turn in #ops. That isolation is the right
// default — two channels can run turns concurrently, and a private thread's
// contents never land in a guild reply by accident — but it also means "what
// were we doing in the other channel?" was unanswerable.
//
// Instead of collapsing everything into one global session (which would
// serialize every channel behind one resumable transcript and bleed private
// context everywhere), each turn injects two small read-only blocks built from
// the vss store that passive ingestion already fills:
//
//   1. a digest of the other channels' recent activity, so the bot knows what is
//      going on elsewhere without being asked;
//   2. semantic hits from other channels for THIS turn's text, so "like I said
//      in the other channel" resolves to the actual message.
//
// Both are labelled with the channel they came from and marked as other-channel
// context, so the model quotes them as "in #ops you said…" rather than folding
// them into this channel's history. Scoping is the caller's job: gemma.ts only
// passes channels that are enabled in access.json.

import type { SearchResult } from './db.ts'

/** Master switch — set GEMMA_CROSS_CHANNEL=0 to go back to strict per-channel isolation. */
export function crossChannelEnabled(): boolean {
  return (process.env.GEMMA_CROSS_CHANNEL ?? '1') !== '0'
}

const MAX_DIGEST_CHANNELS = Number(process.env.GEMMA_CROSS_CHANNEL_DIGEST) || 6
const MAX_HITS = Number(process.env.GEMMA_CROSS_CHANNEL_HITS) || 4
const DIGEST_SNIPPET_CHARS = 220
const HIT_SNIPPET_CHARS = 260
// Channels quiet for longer than this are not "what's going on" any more; the
// semantic-hit path still reaches them, so nothing is permanently lost.
const DIGEST_WINDOW_MS =
  (Number(process.env.GEMMA_CROSS_CHANNEL_WINDOW_HOURS) || 72) * 60 * 60 * 1000

/** One row per other channel: its newest message, plus its rolling summary if one exists. */
export interface ChannelActivity {
  channel_id: string
  author_name: string
  content: string
  timestamp: string
  message_count: number
}

export interface CrossChannelInput {
  activity: readonly ChannelActivity[]
  /** channel_id -> rolling conversation summary, when the summarizer has run. */
  summaries: ReadonlyMap<string, string>
  hits: readonly SearchResult[]
  /** Channels allowed to contribute. A channel absent from this set is invisible. */
  visibleChannelIds: ReadonlySet<string>
  currentChannelId: string
  /** Render a channel id as something a human would recognise (#dev, DM, …). */
  label: (channelId: string) => string
  now?: number
}

function snippet(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat
}

/** "3h ago" / "2d ago" — coarse on purpose; exact stamps add noise, not meaning. */
export function relativeAge(timestamp: string, now: number): string {
  const then = Date.parse(timestamp)
  if (!Number.isFinite(then)) return 'unknown'
  const ms = Math.max(0, now - then)
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

function eligible(input: CrossChannelInput, channelId: string): boolean {
  return channelId !== input.currentChannelId && input.visibleChannelIds.has(channelId)
}

/** Recent-activity digest for the other channels. Empty string when there is nothing to say. */
export function formatOtherChannelsDigest(input: CrossChannelInput): string {
  const now = input.now ?? Date.now()
  const rows = input.activity
    .filter(row => eligible(input, row.channel_id))
    .filter(row => {
      const then = Date.parse(row.timestamp)
      return Number.isFinite(then) && now - then <= DIGEST_WINDOW_MS
    })
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
    .slice(0, MAX_DIGEST_CHANNELS)
  if (!rows.length) return ''

  const lines = rows.map(row => {
    const summary = input.summaries.get(row.channel_id)
    const body = summary?.trim()
      ? snippet(summary, DIGEST_SNIPPET_CHARS)
      : `${row.author_name}: ${snippet(row.content, DIGEST_SNIPPET_CHARS)}`
    return `- ${input.label(row.channel_id)} (${relativeAge(row.timestamp, now)}, ${row.message_count} msgs): ${body}`
  })
  return [
    '[Your other channels — recent activity. You are in these conversations too;',
    'this is a digest, not their live history. Refer to them only when relevant,',
    'and name the channel when you do.]',
    ...lines,
  ].join('\n')
}

/** Semantic matches from OTHER channels for this turn's text. */
export function formatCrossChannelRecall(input: CrossChannelInput): string {
  const kept = input.hits
    .filter(hit => eligible(input, hit.channel_id))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, MAX_HITS)
  if (!kept.length) return ''

  const lines = kept.map(hit =>
    `- ${input.label(hit.channel_id)} [${hit.timestamp}] ${hit.author_name}: ${snippet(hit.content, HIT_SNIPPET_CHARS)}`,
  )
  return [
    '[Related messages from your OTHER channels (semantic matches). These are not',
    'part of this channel\'s conversation — attribute them to their channel if you',
    'use them, and prefer the live conversation when they conflict.]',
    ...lines,
  ].join('\n')
}

/** Both blocks, joined. Empty string when neither has anything. */
export function formatCrossChannelContext(input: CrossChannelInput): string {
  return [formatOtherChannelsDigest(input), formatCrossChannelRecall(input)]
    .filter(Boolean)
    .join('\n\n')
}
