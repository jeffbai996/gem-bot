/**
 * Prefix every console line with an ISO timestamp.
 *
 * gemma logs to an append-only file via the unit's StandardOutput. On
 * 2026-08-27 agy hit a quota wall and the question "what consumed it" was
 * unanswerable: 24,000 lines in that log, zero of them carrying a date. There
 * was no way to attribute anything to a time window.
 *
 * Import this first, before anything that logs.
 */
const stamp = (): string => new Date().toISOString()

let installed = false

export function installLogTimestamps(): void {
  if (installed) return
  installed = true
  for (const level of ['log', 'error', 'warn', 'info'] as const) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]) => original(stamp(), ...args)
  }
}

/** Exposed for tests: the prefix shape callers will see. */
export const timestampPrefix = stamp
