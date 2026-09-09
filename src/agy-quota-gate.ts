import { fetchAgyLimits, type AgyQuotaGroup } from './agy-limits.ts'

export function quotaFailureForModel(groups: AgyQuotaGroup[], model: string, now = Date.now()): string | null {
  const family = /gemini/i.test(model) ? /gemini/i : /claude|gpt/i.test(model) ? /claude|gpt/i : null
  if (!family) return null
  const exhausted = groups.filter(g => family.test(`${g.displayName} ${g.description}`))
    .flatMap(g => g.buckets).filter(b => b.remainingFraction === 0
      && (!b.resetTime || !Number.isFinite(Date.parse(b.resetTime)) || Date.parse(b.resetTime) > now))
    .sort((a, b) => (Date.parse(b.resetTime ?? '') || 0) - (Date.parse(a.resetTime ?? '') || 0))
  const bucket = exhausted[0]
  if (!bucket) return null
  const label = /^(5h|five[- ]?hour)$/i.test(bucket.window) ? '5-hour' : bucket.window === 'weekly' ? 'weekly' : 'usage'
  const reset = Date.parse(bucket.resetTime ?? '')
  return `antigravity ${label} quota reached — ${Number.isFinite(reset)
    ? `retry <t:${Math.ceil(reset / 1000)}:R> (<t:${Math.ceil(reset / 1000)}:t>)` : 'reset time unavailable'}`
}

/** A failed quota lookup must not masquerade as exhaustion or block a valid turn. */
export async function checkAgyQuota(model: string): Promise<string | null> {
  try { return quotaFailureForModel(await fetchAgyLimits(), model) }
  catch { return null }
}
