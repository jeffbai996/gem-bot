export type ReactionAction =
  | 'regenerate' | 'expand' | 'pin' | 'delete'
  | 'mute' | 'unmute' | 'markForEdit'

export const REACTION_ACTIONS: Record<string, ReactionAction> = {
  '🔁': 'regenerate',
  '🔍': 'expand',
  '📌': 'pin',
  '❌': 'delete',
  '🔇': 'mute',
  '🔊': 'unmute',
  '✏️': 'markForEdit'
}

export function actionFor(emoji: string): ReactionAction | null {
  return REACTION_ACTIONS[emoji] ?? null
}

// Match a single Unicode emoji or ZWJ sequence (👨‍👩‍👧‍👦, 🏳️‍🌈, etc.).
// Discord's reaction PUT endpoint accepts standard unicode emojis without
// auth issues; custom Discord emojis (`:name:id`) only work if the bot has
// access to that emoji (i.e., shares a server with it). The model occasionally
// emits custom emoji names from past Discord context (`pack11_sticker_14`,
// `green:123456789`), which Discord rejects with 'Unknown Emoji' (10014) and
// floods the log with noise. This validator rejects anything that isn't a
// pure Unicode emoji so we don't bother Discord with calls that will fail.
const SINGLE_EMOJI_RE =
  /^\p{Extended_Pictographic}(?:\u{FE0F})?(?:\u{200D}\p{Extended_Pictographic}(?:\u{FE0F})?)*$/u

export function isValidOutboundReactEmoji(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false
  return SINGLE_EMOJI_RE.test(value)
}
