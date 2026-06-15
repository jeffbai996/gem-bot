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
  const lines: string[] = []
  let used = 0
  let rendered = 0
  for (const e of entries.slice(0, MAX_RESULTS)) {
    const tags =
      Array.isArray(e.tags) && e.tags.length ? ` [${e.tags.join(', ')}]` : ''
    const pin = e.pinned ? ' (pinned)' : ''
    let body = (e.text ?? '').trim()
    if (body.length > MAX_TEXT_CHARS) body = body.slice(0, MAX_TEXT_CHARS) + '…'
    const line = `#${e.id ?? '?'} (${e.type ?? 'entry'})${pin} ${e.name ?? ''}${tags}\n${body}`
    if (rendered > 0 && used + line.length > MAX_TOTAL_CHARS) break
    lines.push(line)
    used += line.length
    rendered++
  }

  const total = typeof data?.total === 'number' ? data.total : entries.length
  const header = `squad-store: ${rendered} of ${total} match(es) for "${query}"`
  return header + '\n\n' + lines.join('\n\n')
}

export const searchSquadMemoryTool: Tool = {
  name: 'search_squad_memory',
  declaration: {
    name: 'search_squad_memory',
    description:
      "Search the shared SQUAD-STORE memory (durable squad facts, projects, references, people, and feedback notes) by keyword. This is the operator-curated knowledge base, distinct from this channel's chat history (use search_memory for that). Read-only. Use it when asked about saved facts, projects, people, infrastructure, or prior decisions that would live in curated notes rather than recent chat. If one search returns nothing useful, do not keep rewording the query — answer from what you know or say you do not have it.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING, description: 'Keyword(s) to search for' },
      },
      required: ['query'],
    },
  },
  async execute(args) {
    const query = args.query
    if (typeof query !== 'string' || query.trim().length === 0) {
      return 'search_squad_memory requires a non-empty "query" string argument.'
    }
    return await searchSquadStore(query.trim())
  },
}
