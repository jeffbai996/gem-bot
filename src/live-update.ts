const DEFAULT_INTERVAL_MS = 1500
const DEFAULT_PROGRESS_DWELL_CAP_MS = 30_000
const MIN_PROGRESS_DWELL_MS = 10_000
const READING_MS_PER_WORD = 300

export function resolveLiveUpdateInterval(raw: string | undefined): number {
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 1000 ? parsed : DEFAULT_INTERVAL_MS
}

export function liveProgressDwellMs(
  text: string,
  capMs = DEFAULT_PROGRESS_DWELL_CAP_MS,
): number {
  const clean = text.trim()
  if (clean.length < 240 && !clean.includes('\n')) return 0
  const words = clean.split(/\s+/).filter(Boolean).length
  return Math.min(
    Math.max(0, capMs),
    Math.max(MIN_PROGRESS_DWELL_MS, words * READING_MS_PER_WORD),
  )
}

export class LiveProgressBuffer {
  private current = ''
  private pending = ''
  private holdUntil = 0

  push(text: string, now = Date.now()): void {
    const clean = text.trim()
    if (!clean) return
    if (!this.current || now >= this.holdUntil) {
      this.activate(clean, now)
      return
    }
    this.pending = clean
  }

  value(now = Date.now()): string {
    if (this.pending && now >= this.holdUntil) {
      this.activate(this.pending, now)
    }
    return this.current
  }

  remainingMs(now = Date.now()): number {
    return Math.max(0, this.holdUntil - now)
  }

  private activate(text: string, now: number): void {
    this.current = text
    this.pending = ''
    this.holdUntil = now + liveProgressDwellMs(text)
  }
}
