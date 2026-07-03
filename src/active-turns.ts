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

// Grace period (ms): a turn younger than this is never barged.
export const BARGE_GRACE_MS = 4000

class ActiveTurns {
  private killers = new Map<string, Killer>()
  private stopped = new Set<string>()
  private startedAt = new Map<string, number>()
  private busyTool = new Map<string, BusyTool>()

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
  }

  /** Mark the channel mid a destructive tool (barging then would be unsafe). Unused
   *  on gem today (sandboxed tools) — present for parity with gpt-bot. */
  setBusy(channelId: string, tool: Exclude<BusyTool, null>): void {
    this.busyTool.set(channelId, tool)
  }

  /** The destructive tool finished — safe to barge again. */
  clearBusy(channelId: string): void {
    this.busyTool.set(channelId, null)
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
    if (opts.clearQueue) this.stopped.add(channelId)
    try { k() } catch { /* best-effort */ }
    this.killers.delete(channelId)
    this.startedAt.delete(channelId)
    this.busyTool.delete(channelId)
    return true
  }

  /** runChannelTurn: was this channel just stopped? Consumes the flag. */
  consumeStopped(channelId: string): boolean {
    if (this.stopped.has(channelId)) { this.stopped.delete(channelId); return true }
    return false
  }

  isActive(channelId: string): boolean {
    return this.killers.has(channelId)
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
}

export const activeTurns = new ActiveTurns()
