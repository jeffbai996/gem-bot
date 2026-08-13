export const DEFAULT_GEMINI_MODEL = 'gemini-3.7-flash'
export const DEFAULT_AGY_MODEL = 'gemini-3.7-flash-medium'

export const API_MODEL_CHOICES = [
  { name: 'Gemini 3.7 Flash — current balanced default', value: 'gemini-3.7-flash' },
  { name: 'Gemini 3.1 Pro — strongest reasoning tier', value: 'gemini-3.1-pro-preview' },
] as const

// Exact ids printed by `agy models`. Antigravity no longer accepts the old
// display strings such as "Gemini 3.7 Flash (Medium)" as its canonical model
// selector, so slash-command values deliberately use these CLI ids verbatim.
export const AGY_MODEL_CHOICES = [
  { name: 'Gemini 3.7 Flash (Medium) — balanced default', value: 'gemini-3.7-flash-medium' },
  { name: 'Gemini 3.7 Flash (High) — more reasoning', value: 'gemini-3.7-flash-high' },
  { name: 'Gemini 3.7 Flash (Low) — fastest', value: 'gemini-3.7-flash-low' },
  { name: 'Gemini 3.1 Pro (High)', value: 'gemini-3.1-pro-high' },
  { name: 'Gemini 3.1 Pro (Low)', value: 'gemini-3.1-pro-low' },
  { name: 'Claude Sonnet 4.6', value: 'claude-sonnet-4-6' },
  { name: 'Claude Opus 4.6 (Thinking)', value: 'claude-opus-4-6-thinking' },
  { name: 'GPT-OSS 120B (Medium)', value: 'gpt-oss-120b-medium' },
] as const

const AGY_MODEL_IDS = new Set<string>(AGY_MODEL_CHOICES.map(choice => choice.value))

export function isValidAgyModel(model: string): boolean {
  return AGY_MODEL_IDS.has(model)
}

export function modelEffort(model: string): string | undefined {
  const displayEffort = model.match(/\((low|medium|high)\)/i)?.[1]
  const slugEffort = model.match(/-(low|medium|high)$/i)?.[1]
  return (displayEffort ?? slugEffort)?.toLowerCase()
}

export function friendlyModelName(model: string): string {
  const labels: Record<string, string> = {
    'gemini-3.7-flash': 'Gemini 3.7 Flash',
    // 3.6 is off the pickers but stays here: this map is the display fallback
    // for already-persisted pins, and dropping it would render old rows raw.
    'gemini-3.6-flash': 'Gemini 3.6 Flash',
    'gemini-3.5-flash': 'Gemini 3.5 Flash',
    'gemini-3.1-pro-preview': 'Gemini 3.1 Pro',
    'gemini-3.5-flash-lite': 'Gemini 3.5 Flash-Lite',
  }
  const direct = labels[model]
  if (direct) return direct

  const choice = AGY_MODEL_CHOICES.find(item => item.value === model)
  if (choice) return choice.name.replace(/\s+—.*$/, '')

  // Keep older persisted display strings readable during rollout.
  return model
}
