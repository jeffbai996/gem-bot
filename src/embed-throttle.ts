// Per-channel + per-user embedding throttle.
//
// Every allowed message used to fire gemini.embed() with zero rate-limiting,
// which meant a chatty user (or a busy channel) burned embedding API calls
// continuously. This module gates passive ingestion: at most one embed
// per (channel, user) pair per cooldown window.
//
// The cooldown window is generous enough that real conversation flows
// through (the limit is per-author, so two people chatting at a normal
// pace both still get embedded), but tight enough that someone spamming
// short messages doesn't generate a continuous embed stream.
//
// Tuning: override via GEMINI_EMBED_COOLDOWN_MS (default 3000ms = 3s).

const COOLDOWN_MS = parseInt(
  process.env.GEMINI_EMBED_COOLDOWN_MS ?? '3000',
  10,
)

const lastEmbedAt = new Map<string, number>()

function key(channelId: string, userId: string): string {
  return `${channelId}:${userId}`
}

/**
 * Returns true if a fresh embed should fire for this (channel, user) right
 * now. Returns false (and the caller should skip) if we're inside the
 * cooldown window since the last embed for this pair.
 */
export function shouldEmbed(channelId: string, userId: string): boolean {
  if (COOLDOWN_MS <= 0) return true  // throttle disabled
  const k = key(channelId, userId)
  const now = Date.now()
  const last = lastEmbedAt.get(k) ?? 0
  if (now - last < COOLDOWN_MS) return false
  lastEmbedAt.set(k, now)
  return true
}

/**
 * Periodically drop entries older than 10× the cooldown window. Keeps the
 * map from growing forever in long-lived processes. Cheap — runs every 5
 * minutes, only iterates the map.
 */
const EVICT_AFTER_MS = COOLDOWN_MS * 10
setInterval(() => {
  const cutoff = Date.now() - EVICT_AFTER_MS
  for (const [k, ts] of lastEmbedAt.entries()) {
    if (ts < cutoff) lastEmbedAt.delete(k)
  }
}, 5 * 60 * 1000).unref?.()
