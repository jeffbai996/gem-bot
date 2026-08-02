// Registry of in-flight gemini turns per channel so /gemini stop can abort one that's
// stuck (e.g. a tool-calling loop). respondViaCodex registers a killer when it
// spawns and clears it when the turn ends; /gemini stop looks up the channel and
// fires the killer. A separate `stopped` flag lets the queue runner (runChannelTurn)
// know a turn was user-aborted so it drops any queued follow-ups too. (Jeff 2026-06-25)
//
// Barge-in (Jeff 2026-07-01): a new in-flight message can cut off the current turn and
// take over — but only when SAFE. Guards: a grace window (don't murder a just-started /
// near-done turn) and a tool-safety check (`busyTool`). Gemini's tools (googleSearch +
// codeExecution) run in GOOGLE's sandbox, not the local FS, so gem-bot has no "unsafe
// for code" case and leans on the grace window alone — busyTool stays null here. The
// hooks are kept identical to gpt-bot's so the two stay in sync (gpt DOES set busyTool
// from codex's live shell/file-edit events).
type Killer = () => void
type BusyTool = 'shell' | 'edit' | null
type PendingStop = { clearQueue: boolean }

// Grace period (ms): a turn younger than this is never barged.
export const BARGE_GRACE_MS = 2000

class ActiveTurns {
  private killers = new Map<string, Killer>()
  private stopped = new Set<string>()
  private steeredAfter = new Map<string, number>()
  private startedAt = new Map<string, number>()
  private busyTool = new Map<string, BusyTool>()
  private pendingStops = new Map<string, PendingStop>()
  private idleWaiters = new Set<() => void>()

  /** respondViaGemini: record how to kill this channel's running turn. */
  register(channelId: string, kill: Killer): void {
    this.killers.set(channelId, kill)
    this.startedAt.set(channelId, Date.now())
  }

  /** respondViaGemini: the turn finished (or died) — forget its killer + liveness. */
  done(channelId: string): void {
    this.killers.delete(channelId)
    this.startedAt.delete(channelId)
    this.busyTool.delete(channelId)
    this.pendingStops.delete(channelId)
    this.steeredAfter.delete(channelId)
    this.resolveIdleIfNeeded()
  }

  /** Mark the channel mid a destructive tool (barging then would be unsafe). Unused
   *  on gem today (sandboxed tools) — present for parity with gpt-bot. */
  setBusy(channelId: string, tool: Exclude<BusyTool, null>): void {
    this.busyTool.set(channelId, tool)
  }

  /** The destructive tool finished — safe to barge again. */
  clearBusy(channelId: string): void {
    this.busyTool.set(channelId, null)
    // Tool completion is the safe handoff boundary steering was waiting for.
    this.stopIfPending(channelId)
  }

  /** /gemini stop: kill the in-flight turn + mark the channel stopped so the queue
   *  drain bails. Returns true if a turn was actually running. */
  stop(channelId: string): boolean {
    return this.stopFor(channelId, { clearQueue: true })
  }

  /** Kill the in-flight turn. `clearQueue` controls whether the queue runner drops its
   *  remaining follow-ups: true for a user stop ("abandon all"), false for a barge
   *  ("replace the running turn, keep any other queued messages"). */
  stopFor(channelId: string, opts: { clearQueue: boolean }): boolean {
    const k = this.killers.get(channelId)
    if (!k) return false
    if (opts.clearQueue) {
      this.stopped.add(channelId)
      this.steeredAfter.delete(channelId)
    } else {
      this.steeredAfter.set(channelId, Date.now() - (this.startedAt.get(channelId) ?? Date.now()))
    }
    this.pendingStops.delete(channelId)
    try { k() } catch { /* best-effort */ }
    // Aborting generation only begins teardown. Keep the turn registered until
    // handleUserMessage's finally calls done(), otherwise the queue/restart path
    // observes a false-idle window while rendering and cleanup are still active.
    this.busyTool.delete(channelId)
    return true
  }

  /** Normal message barge-in: mark the running turn to be killed at the next
   *  lifecycle boundary instead of killing mid-output. */
  deferStopFor(channelId: string, opts: { clearQueue: boolean }): boolean {
    if (!this.killers.has(channelId)) return false
    this.pendingStops.set(channelId, opts)
    return true
  }

  /** Model/live-render loop: execute a pending deferred stop at a safe boundary. */
  stopIfPending(channelId: string): boolean {
    const pending = this.pendingStops.get(channelId)
    if (!pending) return false
    // Partial text and thinking events can arrive while a tool is executing.
    // They are not safe interruption points; tool completion calls clearBusy().
    if (this.busyTool.get(channelId)) return false
    return this.stopFor(channelId, pending)
  }

  /** runChannelTurn: was this channel just stopped? Consumes the flag. */
  consumeStopped(channelId: string): boolean {
    if (this.stopped.has(channelId)) { this.stopped.delete(channelId); return true }
    return false
  }

  consumeSteered(channelId: string): number | null {
    const elapsed = this.steeredAfter.get(channelId)
    if (elapsed === undefined) return null
    this.steeredAfter.delete(channelId)
    return elapsed
  }

  isActive(channelId: string): boolean {
    return this.killers.has(channelId)
  }

  isIdle(): boolean {
    return this.killers.size === 0
  }

  waitForIdle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve()
    return new Promise(resolve => this.idleWaiters.add(resolve))
  }

  /** Barge guard: safe to cut off this channel's in-flight turn iff a turn is running,
   *  it's past the grace window, and it's NOT mid a destructive tool call. */
  canBarge(channelId: string, now: number = Date.now()): boolean {
    if (!this.killers.has(channelId)) return false
    if (this.busyTool.get(channelId)) return false
    const started = this.startedAt.get(channelId)
    if (started === undefined) return false
    return now - started >= BARGE_GRACE_MS
  }

  /** A normal message is allowed to request a deferred barge once the grace
   *  window has passed, even if a lifecycle event is currently rendering. */
  canRequestBarge(channelId: string, now: number = Date.now()): boolean {
    if (!this.killers.has(channelId)) return false
    const started = this.startedAt.get(channelId)
    if (started === undefined) return false
    return now - started >= BARGE_GRACE_MS
  }

  private resolveIdleIfNeeded(): void {
    if (!this.isIdle()) return
    const waiters = [...this.idleWaiters]
    this.idleWaiters.clear()
    for (const resolve of waiters) resolve()
  }
}

export const activeTurns = new ActiveTurns()
