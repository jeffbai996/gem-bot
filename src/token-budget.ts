import type { GeminiContent } from './history.ts'

export type CountTokens = (contents: GeminiContent[]) => Promise<number>

export interface BudgetOptions {
  budget: number
  minRetain?: number
}

export async function selectWithinBudget(
  contents: GeminiContent[],
  countTokens: CountTokens,
  opts: BudgetOptions
): Promise<GeminiContent[]> {
  const { budget } = opts
  const minRetain = opts.minRetain ?? 3

  if (contents.length === 0) return contents
  if (contents.length <= minRetain) return contents

  try {
    let current = contents
    let tokens = await countTokens(current)
    if (tokens <= budget) return current

    while (current.length > minRetain) {
      current = current.slice(1)
      tokens = await countTokens(current)
      if (tokens <= budget) return current
    }
    return current
  } catch (e) {
    console.error('[token-budget] countTokens failed, falling back to last 20 messages:', e)
    return contents.length > 20 ? contents.slice(-20) : contents
  }
}
