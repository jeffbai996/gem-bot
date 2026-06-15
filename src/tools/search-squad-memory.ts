import { Type } from '@google/genai'
import type { Tool } from './registry.ts'

// Squad-store HTTP API on the local bind. Use /api/recall (semantic vecgrep) —
// it resolves natural-language queries like "who is Paul" to the right curated
// memory. The old /api/search?mode=literal substring path missed those: a
// literal "who is Paul" matched nothing → the model hallucinated a wrong Paul.
// vecgrep is reliable now (verified 2026-06-14).
const SQUAD_STORE_URL = process.env.SQUAD_STORE_URL || 'http://127.0.0.1:5005'
const SQUAD_BOT = process.env.SQUAD_STORE_BOT || 'gemma'
const REQUEST_TIMEOUT_MS = 8_000
const MAX_RESULTS = 6
// Per-entry cap was 600 — far too small. The curated profiles are rich (#53
// "Jeff's social network" is ~8900 chars; #112 "Paul + Riri" ~2000), so a
// 600-char cut chopped each to a surface fragment BEFORE the relevant detail
// (the Paul Kwon entry in #53 starts past char 1400; the Riri↔Paul relationship
// in #112 sat past the cut) — which is exactly why Gemma "knew" people only
// surface-level. Raise the per-entry cap and cap the TOTAL instead so one huge
// entry can't blow the context. (2026-06-14, diagnosed from voice logs.)
// Caps sized to the actual corpus, not guessed. Measured 2026-06-14: the
// LARGEST entry (#53 "Jeff's social network") is ~8900 chars (~2.2k tok), and a
// top-8 recall sums to only ~3.7k tok even uncapped — so "token furnace" isn't a
// real risk at this corpus size. Per-entry 10k clears the biggest entry whole
// (nothing truncated); 24k total (~6k tok) covers a full multi-hit recall. Both
// are cheap per call; revisit only if the store grows an order of magnitude.
const MAX_TEXT_CHARS = 10_000
const MAX_TOTAL_CHARS = 24_000

interface SquadEntry {
  id?: number
  type?: string
  name?: string
  text?: string
  tags?: string[]
  about?: string[]
  ts?: string
  pinned?: boolean
}

// Read ONE memory by its numeric id (e.g. "read memory 198"). The memories
// store and the files store are SEPARATE id spaces — "memory #N" lives at
// /api/memory/<id>, NOT /api/files/<id> (read_squad_file). Reaching for
// read_squad_file on a memory number 404s; this is the right path.
async function getMemoryById(id: number): Promise<string> {
  const url =
    SQUAD_STORE_URL.replace(/\/+$/, '') + '/api/memory/' + encodeURIComponent(String(id))
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  let data: any
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; gemma-bot/1.0)' },
    })
    if (res.status === 404) return `No squad memory with id ${id}.`
    if (!res.ok) return `squad-store read failed: HTTP ${res.status} ${res.statusText}`
    data = await res.json()
  } catch (e: any) {
    if (e?.name === 'AbortError') return 'squad-store read timed out.'
    return `squad-store read error: ${e?.message ?? String(e)}`
  } finally {
    clearTimeout(timer)
  }
  const m: SquadEntry | undefined = data?.memory
  if (!m) return `No squad memory with id ${id}.`
  return renderEntry(m, MAX_TEXT_CHARS)
}

// Recency surface — "latest / newest / most recent" has no semantic signal, so
// /api/recall (vecgrep) returns topical-old hits and never the actually-newest
// memory. recent=1 sorts by id desc server-side. (2026-06-14: voice + text both
// answered "latest project" with a month-old entry because recall is semantic
// only; this is the fix.)
async function recentSquadStore(): Promise<string> {
  const url =
    SQUAD_STORE_URL.replace(/\/+$/, '') +
    '/api/recall?recent=1&top_k=' + MAX_RESULTS +
    '&bot=' + encodeURIComponent(SQUAD_BOT)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  let data: any
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; gemma-bot/1.0)' },
    })
    if (!res.ok) return `squad-store recent failed: HTTP ${res.status} ${res.statusText}`
    data = await res.json()
  } catch (e: any) {
    if (e?.name === 'AbortError') return 'squad-store recent timed out.'
    return `squad-store recent error: ${e?.message ?? String(e)}`
  } finally {
    clearTimeout(timer)
  }
  const entries: SquadEntry[] = Array.isArray(data?.entries) ? data.entries : []
  if (entries.length === 0) return 'No squad-store memories found.'
  return 'squad-store: newest memories first\n\n' + renderEntries(entries)
}

// Shared single-entry renderer: id/type/pin/name/tags header + (capped) body.
function renderEntry(e: SquadEntry, cap: number): string {
  const tags =
    Array.isArray(e.tags) && e.tags.length ? ` [${e.tags.join(', ')}]` : ''
  const pin = e.pinned ? ' (pinned)' : ''
  let body = (e.text ?? '').trim()
  if (body.length > cap) body = body.slice(0, cap) + '…'
  return `#${e.id ?? '?'} (${e.type ?? 'entry'})${pin} ${e.name ?? ''}${tags}\n${body}`
}

// Render a list under the total-char budget so the top hits come through whole.
function renderEntries(entries: SquadEntry[]): string {
  const lines: string[] = []
  let used = 0
  let rendered = 0
  for (const e of entries.slice(0, MAX_RESULTS)) {
    const line = renderEntry(e, MAX_TEXT_CHARS)
    if (rendered > 0 && used + line.length > MAX_TOTAL_CHARS) break
    lines.push(line)
    used += line.length
    rendered++
  }
  return lines.join('\n\n')
}

// Read-only keyword search over the shared squad-store (durable squad facts,
// projects, references, people, feedback). Returns a compact text rendering
// the model can read directly.
async function searchSquadStore(query: string): Promise<string> {
  const url =
    SQUAD_STORE_URL.replace(/\/+$/, '') +
    '/api/recall?q=' +
    encodeURIComponent(query) +
    '&top_k=' + MAX_RESULTS +
    '&bot=' + encodeURIComponent(SQUAD_BOT)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  let data: any
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; gemma-bot/1.0)' },
    })
    if (!res.ok) {
      return `squad-store search failed: HTTP ${res.status} ${res.statusText}`
    }
    data = await res.json()
  } catch (e: any) {
    if (e?.name === 'AbortError') return 'squad-store search timed out.'
    return `squad-store search error: ${e?.message ?? String(e)}`
  } finally {
    clearTimeout(timer)
  }

  const entries: SquadEntry[] = Array.isArray(data?.entries) ? data.entries : []
  if (entries.length === 0) {
    return `No squad-store entries matched "${query}".`
  }

  // Render entries until the TOTAL char budget is hit, so the top (most
  // relevant) hits come through in full rather than every hit chopped to a
  // fragment. Each entry still capped at MAX_TEXT_CHARS individually.
  const body = renderEntries(entries)
  const total = typeof data?.total === 'number' ? data.total : entries.length
  const shown = body ? body.split('\n\n').filter((s) => s.startsWith('#')).length : 0
  const header = `squad-store: ${shown} of ${total} match(es) for "${query}"`
  return header + '\n\n' + body
}

export const searchSquadMemoryTool: Tool = {
  name: 'search_squad_memory',
  declaration: {
    name: 'search_squad_memory',
    description:
      "Search the shared SQUAD-STORE memory (durable squad facts, projects, references, people, and feedback notes). This is the operator-curated knowledge base, distinct from this channel's chat history (use search_memory for that). Read-only. Three modes: (1) pass `query` for a semantic search by topic — use for \"who is X\", \"what's the plan for Y\"; (2) pass `recent: true` for the NEWEST memories first — use for \"latest/newest/most recent project\", \"what are we working on now\" (semantic search can't answer recency, so you MUST use recent for those); (3) pass `id` to read one specific memory by its number (e.g. \"read memory 198\"). If a semantic search returns nothing useful, do not keep rewording — answer from what you know or say you don't have it.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING, description: 'Keyword(s)/topic for a semantic search.' },
        recent: { type: Type.BOOLEAN, description: 'If true, return the newest memories first (ignores query). Use for "latest/most recent" questions.' },
        id: { type: Type.NUMBER, description: 'A memory id to read that specific memory (e.g. 198).' },
      },
      required: [],
    },
  },
  async execute(args) {
    // Read one by id takes precedence (most specific intent).
    if (typeof args.id === 'number' && Number.isFinite(args.id)) {
      return await getMemoryById(args.id)
    }
    // Recency listing — "latest/newest" can't be answered semantically.
    if (args.recent === true) {
      return await recentSquadStore()
    }
    const query = args.query
    if (typeof query !== 'string' || query.trim().length === 0) {
      return 'search_squad_memory needs a "query" (topic), "recent": true (newest first), or "id" (read one memory).'
    }
    return await searchSquadStore(query.trim())
  },
}
