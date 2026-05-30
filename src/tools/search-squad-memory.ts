import { Type } from '@google/genai'
import type { Tool } from './registry.ts'

// Squad-store HTTP API on the local bind. The /squad/... prefixed path 404s
// locally; the bare /api/search route is the one that answers on 127.0.0.1.
// mode=literal avoids the (currently unreliable) vecgrep semantic backend.
const SQUAD_STORE_URL = process.env.SQUAD_STORE_URL || 'http://127.0.0.1:5005'
const REQUEST_TIMEOUT_MS = 8_000
const MAX_RESULTS = 8
const MAX_TEXT_CHARS = 600

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
    '/api/search?q=' +
    encodeURIComponent(query) +
    '&mode=literal'

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

  const shown = entries.slice(0, MAX_RESULTS)
  const lines = shown.map((e) => {
    const tags =
      Array.isArray(e.tags) && e.tags.length ? ` [${e.tags.join(', ')}]` : ''
    const pin = e.pinned ? ' (pinned)' : ''
    let body = (e.text ?? '').trim()
    if (body.length > MAX_TEXT_CHARS) body = body.slice(0, MAX_TEXT_CHARS) + '…'
    return `#${e.id ?? '?'} (${e.type ?? 'entry'})${pin} ${e.name ?? ''}${tags}\n${body}`
  })

  const total = typeof data?.total === 'number' ? data.total : entries.length
  const header = `squad-store: ${shown.length} of ${total} match(es) for "${query}"`
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
