import { Type } from '@google/genai'
import type { Tool } from './registry.ts'

// The squad's shared docket. Gemma could already search memories and files but
// had no way to see what the squad is actually working on, so she answered
// "what's outstanding?" from whatever happened to be in the conversation.
//
// Read-only by construction: this only ever issues GET /api/todo. Creating or
// closing a to-do is a write, and a write from a bot that also has fetch_url
// needs the card gate the Claude bots use — a separate decision, not a flag on
// this tool.
const SQUAD_STORE_URL = process.env.SQUAD_STORE_URL || 'http://127.0.0.1:5005'
const REQUEST_TIMEOUT_MS = 8_000
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 60
// A docket line is a pointer, not the work. Long notes get cut here and can be
// read in full by asking for the entry — the same split as peek vs show.
const MAX_NOTE_CHARS = 220

interface SquadTodo {
  id?: string
  text?: string
  title?: string
  note?: string
  status?: string
  priority?: string
  owner?: string
  flag?: boolean
  due?: string
  list_id?: string
  work_state?: string
}

/** The one-line label. `text` is the title; `title` is usually empty. */
function labelOf(todo: SquadTodo): string {
  return (todo.text || todo.title || '(untitled)').replace(/\s+/g, ' ').trim()
}

function clip(text: string, limit: number): string {
  const flat = (text || '').replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : flat.slice(0, limit - 1) + '…'
}

export function formatTodos(todos: SquadTodo[]): string {
  if (!todos.length) return 'No matching to-dos.'
  return todos
    .map(t => {
      const bits = [t.status || 'open']
      if (t.priority && t.priority !== 'med') bits.push(t.priority)
      if (t.work_state) bits.push(t.work_state)
      let line = `#${t.id ?? '?'} [${bits.join('/')}] ${labelOf(t)}`
      if (t.owner) line += `  owner:${t.owner}`
      if (t.due) line += `  due:${t.due}`
      if (t.flag) line += '  ⚑'
      const note = clip(t.note || '', MAX_NOTE_CHARS)
      if (note) line += `\n    ${note}`
      return line
    })
    .join('\n')
}

/** Client-side filtering: /api/todo returns the whole docket in one call. */
export function selectTodos(
  todos: SquadTodo[],
  opts: { status?: string; owner?: string; q?: string; limit?: number } = {}
): SquadTodo[] {
  const want = (opts.status || 'open').toLowerCase()
  const owner = (opts.owner || '').toLowerCase()
  const q = (opts.q || '').toLowerCase()
  const out = todos.filter(t => {
    if (want !== 'all' && (t.status || 'open').toLowerCase() !== want) return false
    if (owner && (t.owner || '').toLowerCase() !== owner) return false
    if (q) {
      const hay = `${labelOf(t)} ${t.note ?? ''} ${t.owner ?? ''}`.toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  })
  // Flagged first, then by priority, so the top of the list is the top of the
  // docket rather than whatever order the store happened to return.
  const rank: Record<string, number> = { high: 0, med: 1, low: 2 }
  out.sort((a, b) => {
    if (!!b.flag !== !!a.flag) return b.flag ? 1 : -1
    return (rank[a.priority ?? 'med'] ?? 1) - (rank[b.priority ?? 'med'] ?? 1)
  })
  const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT))
  return out.slice(0, limit)
}

export const listSquadTodosTool: Tool = {
  name: 'list_squad_todos',
  declaration: {
    name: 'list_squad_todos',
    description:
      "Read the squad's shared to-do list (the docket): what the squad is working on, " +
      'what is open, blocked, or claimed, and by whom. Use for "what is outstanding", ' +
      '"what is on the list", "is anyone working on X". Read-only.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        status: {
          type: Type.STRING,
          description:
            "Filter by status: open (default), done, or all. Use 'all' to include closed work.",
        },
        owner: {
          type: Type.STRING,
          description: 'Only entries owned by this bot or person. Omit for the whole docket.',
        },
        q: {
          type: Type.STRING,
          description: 'Keyword filter over the title, note and owner.',
        },
        limit: {
          type: Type.NUMBER,
          description: `How many to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`,
        },
      },
      required: [],
    },
  },
  async execute(args: any) {
    const url = SQUAD_STORE_URL.replace(/\/+$/, '') + '/api/todo'
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; gemma-bot/1.0)' },
      })
      if (!res.ok) return `squad docket read failed: HTTP ${res.status} ${res.statusText}`
      const data: any = await res.json()
      const todos: SquadTodo[] = Array.isArray(data?.todos) ? data.todos : []
      const picked = selectTodos(todos, args ?? {})
      const header =
        `${picked.length} of ${todos.length} to-do(s)` +
        ((args?.status ?? 'open') === 'all' ? '' : ` [${args?.status ?? 'open'}]`)
      return `${header}\n${formatTodos(picked)}`
    } catch (e: any) {
      // Never a bare empty answer: "the docket is empty" and "the store did not
      // answer" must not read the same.
      if (e?.name === 'AbortError') return 'squad docket read timed out.'
      return `squad docket read error: ${e?.message ?? String(e)}`
    } finally {
      clearTimeout(timer)
    }
  },
}
