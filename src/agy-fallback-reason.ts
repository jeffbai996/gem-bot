/**
 * Turn an agy failure into something a human can act on.
 *
 * The fallback badge used to say only "antigravity unavailable", built from a
 * bare boolean. On 2026-08-27 Jeff asked gemma why agy had died and gemma —
 * having no access to the exit reason — invented one: output token ceilings,
 * backtick collisions, advice to split the request. All plausible, none true.
 * The real cause was a quota wall, and agy had said so in its stderr.
 *
 * The reason exists at the catch site. This carries it to the badge.
 */

/** Reset window agy reports as "Resets in 30m10s". */
const RESET = /Resets? in ([0-9hms]+)/i

export function describeAgyFailure(raw: string): string {
  const msg = (raw || '').trim()
  if (!msg) return 'antigravity unavailable'
  if (/^antigravity (?:5-hour|weekly|usage) quota reached — (?:retry <t:\d+:R> \(<t:\d+:t>\)|reset time unavailable)$/.test(msg)) return msg

  if (/quota reached|quota exceeded|upgrade your subscription/i.test(msg)) {
    const reset = RESET.exec(msg)
    return reset
      ? `antigravity quota exhausted, resets in ${reset[1]}`
      : 'antigravity quota exhausted'
  }
  if (/idle watchdog|print-timeout|timeout waiting for response|timed out/i.test(msg)) {
    return 'antigravity timed out'
  }
  if (/auth|unauthenticated|credential|login/i.test(msg)) {
    return 'antigravity not authenticated'
  }
  if (/ENOENT|spawn failed|no such file/i.test(msg)) {
    return 'antigravity binary missing'
  }
  // Unknown shape: show a trimmed version rather than hiding it. A truthful
  // fragment beats a confident summary that might be wrong.
  const oneLine = msg.replace(/\s+/g, ' ')
  return `antigravity failed: ${oneLine.length > 90 ? oneLine.slice(0, 90) + '…' : oneLine}`
}
