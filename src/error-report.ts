/**
 * Getting the error in front of the user, whatever the card is doing.
 *
 * The old inline version was one line:
 *
 *   await activeMessages[0].edit(msg).catch(() => {})
 *
 * and that `.catch(() => {})` is why turns died showing ❌ with no text and
 * nothing in the journal (Jeff 2026-09-16: "gemini randomly dying with the X
 * emoji with no error message"). If the edit failed — the placeholder was
 * already deleted (10008 is all over that log), or the spinner interval was
 * mid-write on the same message — the failure was swallowed whole. The
 * lifecycle ❌ still landed, so the turn LOOKED handled.
 *
 * The rule here: the user always gets the text. Editing the placeholder is the
 * nice path because it avoids leaving a frozen "💭 Thinking…" above the error,
 * but it is not the only path, and a failure to edit is not a reason to go
 * quiet. It is also reported, because a silent failure taught us nothing the
 * first time.
 */

export interface EditableMessage {
  edit(content: string): Promise<unknown>
  delete(): Promise<unknown>
}

export interface ReportDeps {
  /** The live cards: [0] is the placeholder, the rest are streamed chunks. */
  active: EditableMessage[]
  /** Reasoning cards, always cleared — they explain a reply that never came. */
  traces?: EditableMessage[]
  /** Post a fresh message. Used when there is no card, or editing one failed. */
  send(text: string): Promise<unknown>
  /** Where a swallowed failure used to go. */
  log?(message: string, err: unknown): void
}

export interface ReportOutcome {
  /** 'edited' | 'sent' — how the text reached the user. 'lost' means it did not. */
  via: 'edited' | 'sent' | 'lost'
  /** True when the placeholder edit failed and we fell back to a new message. */
  editFailed: boolean
}

/**
 * Put `text` in front of the user and clear every transient card.
 *
 * Never throws: it is called from a catch block, and an exception here would
 * replace a reported error with an unreported one.
 */
export async function reportTurnError(
  text: string,
  deps: ReportDeps,
): Promise<ReportOutcome> {
  const { active = [], traces = [], send, log } = deps
  let via: ReportOutcome['via'] = 'lost'
  let editFailed = false

  const [placeholder, ...extras] = active

  if (placeholder) {
    try {
      await placeholder.edit(text)
      via = 'edited'
    } catch (err) {
      // The whole point. A card we cannot write to must not eat the error.
      editFailed = true
      log?.('error card edit failed, falling back to a new message', err)
    }
  }

  if (via !== 'edited') {
    try {
      await send(text)
      via = 'sent'
    } catch (err) {
      // Both routes gone: the channel is unreachable or we lost perms. Nothing
      // left but to say so where it can still be read.
      log?.('could not deliver the error to the channel', err)
    }
  }

  // Clear the rest regardless of how delivery went. A stranded "💭 Thinking…"
  // is the same bug wearing a different hat: the error path owns these cards,
  // so it drops them here rather than leaving them to a separate timer that
  // does not know the turn died (Jeff 2026-09-16).
  const stale = editFailed ? [placeholder, ...extras] : extras
  for (const card of [...stale, ...traces]) {
    if (card) await card.delete().catch(() => {})
  }

  return { via, editFailed }
}
