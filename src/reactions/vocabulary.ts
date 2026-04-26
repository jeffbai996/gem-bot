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
