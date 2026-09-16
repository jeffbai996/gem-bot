// A turn opened by a delivered bot-to-bot tell must not send one.
//
// The owner's relay tooling puts a deliver-or-drop card in front of them; the
// tap posts a signed relay whose payload opens with TELL_MARK. Claude bots
// refuse a tell inside such a turn with a PreToolUse hook that reads their
// transcript. A bot with no hooks keeps a marker file in its state dir
// for the turns that are RUNNING right now, and the owner's CLI reads it
// before posting a card: {"turns": {"<message id>": <until, epoch seconds>}}.
//
// Tied to the turn, not to a clock: the first cut armed a 20-minute window
// at dispatch, and a human asking this bot to tell someone two minutes after
// tell had been answered was refused (Jeff 2026-09-15: "it shouldn't be
// blocking on this"). Each entry still carries a safety expiry so a crash
// mid-turn cannot leave it mute forever.
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const TELL_MARK = '⟦bot-relay⟧'
export const TELL_TURN_FILE = '.tell_turn'
export const TELL_TURN_SAFETY_MS = 2 * 60 * 60_000

export function isTellPayload(payload: string): boolean {
  return payload.includes(TELL_MARK)
}

type Marker = { turns: Record<string, number> }

export class TellTurnMarker {
  constructor(
    private readonly stateDir: string,
    private readonly safetyMs = TELL_TURN_SAFETY_MS,
    private readonly clock: () => number = Date.now,
  ) {}

  get file(): string {
    return path.join(this.stateDir, TELL_TURN_FILE)
  }

  private read(): Marker {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8'))
      const turns = raw && typeof raw.turns === 'object' && raw.turns ? raw.turns : {}
      const now = this.clock()
      const live: Record<string, number> = {}
      for (const [id, until] of Object.entries(turns)) {
        if (Number.isFinite(Number(until)) && Number(until) * 1000 > now) live[id] = Number(until)
      }
      return { turns: live }
    } catch {
      return { turns: {} }
    }
  }

  private write(marker: Marker): void {
    try {
      if (Object.keys(marker.turns).length === 0) {
        try { unlinkSync(this.file) } catch { /* already gone */ }
        return
      }
      writeFileSync(this.file, JSON.stringify(marker) + '\n', { mode: 0o600 })
    } catch {
      // Best effort: the owner's tap is the real gate; this only spares a card.
    }
  }

  /** A tell-originated turn for this inbound message is running now. */
  arm(turnId: string): void {
    const marker = this.read()
    marker.turns[turnId] = (this.clock() + this.safetyMs) / 1000
    this.write(marker)
  }

  /** That turn is over; a tell from this bot is allowed again. */
  disarm(turnId: string): void {
    const marker = this.read()
    delete marker.turns[turnId]
    this.write(marker)
  }

  /** Is any tell-originated turn running (or crashed inside its safety window)? */
  active(): boolean {
    return Object.keys(this.read().turns).length > 0
  }

  /** Nothing this process started is still running: drop every entry.
   *
   * Called at startup. A turn recorded by a previous process is dead however
   * it ended, so the safety expiry never has to be waited out after a restart
   * or a crash — which is the only way it could ever block a real ask. */
  reset(): void {
    try { unlinkSync(this.file) } catch { /* nothing to clear */ }
  }
}
