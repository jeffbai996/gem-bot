/**
 * Lifecycle reactions on inbound user messages — match the squad's
 * react_hook lifecycle so Gemma feels like the rest of the bots.
 *
 * Each state cleans up its declared transient predecessors. Final states
 * (replied, errored, denied, blocked, truncated) clean every transient.
 *
 * Visible mid-stream signals:
 *   👀 received   — message accepted, before any work
 *   📎 ingesting  — processing attachments / youtube before generate
 *   🤔 thinking   — Gemini call in flight
 *   🧠 native     — gemini-3 thinking model emitted a thought-summary part
 *   🌐 searching  — google search grounding fired this turn
 *   🔧 tooling    — function-call (fetch_url, search_memory, IBKR, …) running
 *
 * Terminal states (post-stream):
 *   ✅ replied    — substantive reply committed
 *   ✂️ truncated  — finishReason === MAX_TOKENS, reply may be cut off
 *   🛑 blocked    — finishReason === SAFETY, reply was filtered
 *   ⚠️ denied     — rate-limited / quota / 429
 *   ❌ errored    — caught exception of any other kind
 *
 * Virtual: silenced — no emoji, used when the model returns nothing and we
 * deliberately stay quiet; clears all transients without leaving a tombstone.
 */
import type { Message } from 'discord.js'

export const EMOJI = {
  received:        '👀',
  ingesting:       '📎',
  thinking:        '🤔',
  native_thinking: '🧠',
  searching:       '🌐',
  tooling:         '🔧',
  delegating:      '🤖',  // reserved — not currently fired by Gemma
  replied:         '✅',
  truncated:       '✂️',
  blocked:         '🛑',
  errored:         '❌',
  denied:          '⚠️',
  silenced:        '',
} as const

export type LifecycleState = keyof typeof EMOJI

const ALL_TRANSIENTS: LifecycleState[] = [
  'received', 'ingesting', 'thinking', 'native_thinking',
  'searching', 'tooling', 'delegating',
]

const PREDECESSORS: Record<LifecycleState, LifecycleState[]> = {
  // Transients only clear strict predecessors (so e.g. 🌐 mid-stream
  // doesn't wipe 🤔 — they coexist briefly until 🌐 finishes and 🤔 is
  // still relevant). Final states clear everything.
  received:        [],
  ingesting:       ['received'],
  thinking:        ['received', 'ingesting'],
  native_thinking: ['received', 'ingesting'],
  searching:       ['received', 'ingesting'],
  tooling:         ['received', 'ingesting'],
  delegating:      ['received', 'ingesting'],
  replied:         ALL_TRANSIENTS,
  truncated:       ALL_TRANSIENTS,
  blocked:         ALL_TRANSIENTS,
  errored:         ALL_TRANSIENTS,
  denied:          ALL_TRANSIENTS,
  silenced:        ALL_TRANSIENTS,
}

/**
 * Add the emoji for `state` on `message`. Best-effort — discord errors are
 * logged but never thrown (a missing reaction shouldn't crash the bot).
 *
 * Idempotent per-state: discord.js's `react()` is a PUT, so re-applying is
 * a no-op on Discord's side.
 */
export async function applyLifecycle(message: Message, state: LifecycleState): Promise<void> {
  const emoji = EMOJI[state]

  // Remove previous transients first so the row of reactions doesn't grow.
  // We only remove OUR OWN reactions (so user content reactions stay).
  const me = message.client.user
  if (me) {
    for (const prev of PREDECESSORS[state]) {
      const prevEmoji = EMOJI[prev]
      if (!prevEmoji || prevEmoji === emoji) continue
      const r = message.reactions.cache.get(prevEmoji)
      if (r) {
        await r.users.remove(me.id).catch(() => { /* fire-and-forget */ })
      }
    }
  }

  // `silenced` and any future virtual states use empty emoji — strip
  // transients (above) but emit nothing.
  if (!emoji) return

  await message.react(emoji).catch(e => {
    console.error(`[lifecycle] react ${emoji} (${state}) failed:`, e)
  })
}

/**
 * Drop a transient reaction (don't replace it). Useful when a transient
 * stage ends but another stage hasn't started yet — e.g. a search
 * completes mid-stream but more thinking continues, so we drop 🌐 without
 * adding a new state.
 */
export async function dropLifecycle(message: Message, state: LifecycleState): Promise<void> {
  const emoji = EMOJI[state]
  if (!emoji) return
  const me = message.client.user
  if (!me) return
  const r = message.reactions.cache.get(emoji)
  if (r) {
    await r.users.remove(me.id).catch(() => { /* fire-and-forget */ })
  }
}
