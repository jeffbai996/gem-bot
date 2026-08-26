import { Type } from '@google/genai'
import type { Tool, ToolContext } from './registry.ts'

// Gemma's first tools that leave a mark. Everything she owned before this was
// read-only, so anything worth keeping had to be written down for her by a
// human or another bot — a member of the shared memory who could only ever
// read it.
//
// The safety story is not "trust the model". She has fetch_url and web
// grounding, so text she did not author gets a shot at driving a write. What
// makes that survivable is that the store cards EVERY mutation: the write is
// visible, attributed, and reversible from the card itself. So the design goal
// here is that no write can ever be silent.
//
// Two card destinations, matching how the rest of the squad already works:
//
//   asked for by a human  → card in Gemma's home channel
//   she decided herself   → `discord_self_initiated`, which the store badges
//                           🤖 auto and routes to the alerts room
//
// `requested_by_user` defaults to FALSE. A model-declared flag is not a
// security boundary and is not treated as one — it decides which room the card
// lands in, not whether a card posts. Defaulting to autonomous means a write
// she forgot to label gets MORE scrutiny, not less.
// Config is read per call, not at import. A channel id is deployment config,
// never source, and reading it late means a restart is not required to change
// where cards land.
const storeUrl = () => process.env.SQUAD_STORE_URL || 'http://127.0.0.1:5005'
/** Where human-directed cards land. Empty means "no home configured". */
const homeChannelId = () => process.env.GEMMA_CARD_CHANNEL_ID || ''
const botToken = () => process.env.DISCORD_BOT_TOKEN || ''

/**
 * The store's write credential. Every unsafe route requires it; without it a
 * write is 401 and nothing reaches the store — which is what happened to every
 * write Gemma attempted between 2026-08-24 and 2026-08-25. Reads are public, so
 * the tools looked healthy from outside.
 *
 * Supplied by the unit, not hunted for on disk: a service should be handed its
 * credentials by its supervisor. Empty is a valid state — the write still goes
 * out and fails loudly rather than being swallowed here.
 */
export const storeToken = () => (process.env.SQUAD_STORE_TOKEN || '').trim()

const REQUEST_TIMEOUT_MS = 8_000
const ACTOR = 'gemma'
// A store write is a sentence, not an essay. Long enough for a real note,
// short enough that a fetched page cannot pour itself into the store.
const MAX_TEXT_CHARS = 2_000

export interface WriteOutcome {
  ok: boolean
  status: number
  detail: string
}

/** The card-routing fields. Split out so the rule is testable on its own. */
export function cardFields(requestedByUser: boolean): Record<string, unknown> {
  const home = homeChannelId()
  if (requestedByUser && home) {
    return { discord_chat_id: home, discord_author: ACTOR }
  }
  // No chat target: the store badges it 🤖 auto and posts to the alerts room.
  // Also the fallback when no home channel is configured — an unattributed
  // card in the alerts room beats a silent write.
  return { discord_self_initiated: true, discord_author: ACTOR }
}

export function clampText(text: unknown): string {
  const flat = String(text ?? '').trim()
  return flat.length <= MAX_TEXT_CHARS ? flat : flat.slice(0, MAX_TEXT_CHARS - 1) + '…'
}

export async function postWrite(
  path: string,
  body: Record<string, unknown>,
  requestedByUser: boolean,
  fetchImpl: typeof fetch = fetch,
): Promise<WriteOutcome> {
  const url = storeUrl().replace(/\/+$/, '') + path
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const payload: Record<string, unknown> = {
      ...body,
      author: ACTOR,
      actor: ACTOR,
      ...cardFields(requestedByUser),
    }
    // Her own token, so the card posts as her rather than as whichever bot the
    // store falls back to — which 403s on channels that bot cannot see.
    const token = botToken()
    if (token) payload.discord_bot_token = token
    const res = await fetchImpl(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        // Identity. The store refuses a card-less anonymous write outright.
        'X-Squad-Bot': ACTOR,
        // Authorization. Identity says WHO; this says ALLOWED. Without it every
        // write is 401 and the tool reports a failure nobody sees.
        ...(storeToken() ? { 'X-Squad-Token': storeToken() } : {}),
        'User-Agent': 'Mozilla/5.0 (compatible; gemma-bot/1.0)',
      },
      body: JSON.stringify(payload),
    })
    let detail = ''
    try {
      const data: any = await res.json()
      detail = data?.error || ''
    } catch {
      /* a non-JSON body is not worth failing over; the status carries it */
    }
    return { ok: res.ok, status: res.status, detail }
  } catch (e: any) {
    if (e?.name === 'AbortError') return { ok: false, status: 0, detail: 'timed out' }
    return { ok: false, status: 0, detail: e?.message ?? String(e) }
  } finally {
    clearTimeout(timer)
  }
}

/** One phrasing for every write, so a failure never reads like a success. */
export function describe(what: string, outcome: WriteOutcome, requested: boolean): string {
  if (outcome.ok) {
    const where = requested && homeChannelId() ? 'home channel' : 'alerts channel (badged auto)'
    return `Saved. ${what} is in the shared store, and a card is in the ${where} where it can be reverted.`
  }
  const why = outcome.detail || `HTTP ${outcome.status}`
  return `NOT saved — ${what} was rejected by the store: ${why}`
}

const REQUESTED_DESC =
  'Set true ONLY if the person you are talking to explicitly asked you to save ' +
  'this in this conversation. If you decided to save it yourself, leave it out. ' +
  'This chooses which channel the confirmation card lands in.'

export const saveSquadMemoryTool: Tool = {
  name: 'save_squad_memory',
  declaration: {
    name: 'save_squad_memory',
    description:
      'Save a durable fact to the squad shared memory. For things that stay true: a ' +
      'preference, a decision, how a system works. Not for chat, not for what you are ' +
      'about to do next. Every save posts a card that can be reverted.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        text: { type: Type.STRING, description: 'The fact, in full. One fact per memory.' },
        name: { type: Type.STRING, description: 'Short kebab-case slug naming the fact.' },
        type: {
          type: Type.STRING,
          description:
            'One of: feedback (guidance on how to work), project (ongoing work), ' +
            'reference (a pointer to something external), user (who someone is). ' +
            'Defaults to feedback.',
        },
        tags: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'Optional tags.' },
        requested_by_user: { type: Type.BOOLEAN, description: REQUESTED_DESC },
      },
      required: ['text'],
    },
  },
  async execute(args: any, _ctx: ToolContext) {
    const text = clampText(args?.text)
    if (!text) return 'NOT saved — a memory needs text.'
    const requested = args?.requested_by_user === true
    const outcome = await postWrite('/api/memory', {
      text,
      name: String(args?.name ?? '').slice(0, 200),
      type: args?.type || 'feedback',
      tags: Array.isArray(args?.tags) ? args.tags.slice(0, 20) : [],
    }, requested)
    return describe('the memory', outcome, requested)
  },
}

export const addSquadTodoTool: Tool = {
  name: 'add_squad_todo',
  declaration: {
    name: 'add_squad_todo',
    description:
      'Add an item to the squad docket — work to be picked up later, by anyone. ' +
      'Not for what you are doing right now in this reply. Posts a card.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        text: {
          type: Type.STRING,
          description: 'Imperative one-line title, under 100 characters.',
        },
        note: { type: Type.STRING, description: 'Optional detail.' },
        owner: { type: Type.STRING, description: 'Who should do it. Omit if unassigned.' },
        priority: {
          type: Type.STRING,
          description: 'Optional priority. Omit unless it genuinely matters.',
        },
        requested_by_user: { type: Type.BOOLEAN, description: REQUESTED_DESC },
      },
      required: ['text'],
    },
  },
  async execute(args: any, _ctx: ToolContext) {
    const text = clampText(args?.text)
    if (!text) return 'NOT saved — a to-do needs a title.'
    const requested = args?.requested_by_user === true
    const body: Record<string, unknown> = { text, note: clampText(args?.note ?? '') }
    if (args?.owner) body.owner = String(args.owner)
    // Priority is a server-validated enum. Send it only when asked for, and
    // let the store reject a bad value rather than guessing the vocabulary.
    if (args?.priority) body.priority = String(args.priority)
    const outcome = await postWrite('/api/todo', body, requested)
    return describe('the to-do', outcome, requested)
  },
}

export const addSquadScratchTool: Tool = {
  name: 'add_squad_scratch',
  declaration: {
    name: 'add_squad_scratch',
    description:
      'Leave a short-lived note that expires on its own. For context that would ' +
      'otherwise be lost — a handoff, something to pick up shortly. Never for ' +
      'finished work. Keep the TTL as short as the note is actually useful.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        text: { type: Type.STRING, description: 'The note.' },
        ttl_hours: {
          type: Type.NUMBER,
          description: 'Hours until it expires. Hours, not days. Defaults to 6.',
        },
        requested_by_user: { type: Type.BOOLEAN, description: REQUESTED_DESC },
      },
      required: ['text'],
    },
  },
  async execute(args: any, _ctx: ToolContext) {
    const text = clampText(args?.text)
    if (!text) return 'NOT saved — a note needs text.'
    const requested = args?.requested_by_user === true
    const raw = Number(args?.ttl_hours)
    // A scratch note that outlives its usefulness is just clutter nobody
    // deletes, so an absurd TTL is clamped rather than honoured.
    const ttl = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 72) : 6
    const outcome = await postWrite('/api/scratch', {
      text, ttl_hours: ttl, source: `gemma:${requested ? 'asked' : 'self'}`,
    }, requested)
    return describe('the note', outcome, requested)
  },
}

export const squadWriteTools: Tool[] = [
  saveSquadMemoryTool,
  addSquadTodoTool,
  addSquadScratchTool,
]
