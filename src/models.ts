export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash'
export const DEFAULT_AGY_MODEL = 'gemini-3.8-flash-medium'

export const API_MODEL_CHOICES = [
  { name: 'Gemini 3.8 Flash — current balanced default', value: 'gemini-3.8-flash' },
  { name: 'Gemini 3.1 Pro — strongest reasoning tier', value: 'gemini-3.1-pro-preview' },
] as const

// Exact ids printed by `agy models`. Antigravity no longer accepts the old
// display strings such as "Gemini 3.8 Flash (Medium)" as its canonical model
// selector, so slash-command values deliberately use these CLI ids verbatim.
export const AGY_MODEL_CHOICES = [
  { name: 'Gemini 3.8 Flash (Medium) — balanced default', value: 'gemini-3.8-flash-medium' },
  { name: 'Gemini 3.8 Flash (High) — more reasoning', value: 'gemini-3.8-flash-high' },
  { name: 'Gemini 3.8 Flash (Low) — fastest', value: 'gemini-3.8-flash-low' },
  { name: 'Gemini 3.1 Pro (High)', value: 'gemini-3.1-pro-high' },
  { name: 'Gemini 3.1 Pro (Low)', value: 'gemini-3.1-pro-low' },
  { name: 'Sonnet 4.6 (Thinking)', value: 'claude-sonnet-4-6' },
  { name: 'Opus 4.6 (Thinking)', value: 'claude-opus-4-6-thinking' },
  { name: 'GPT-OSS 120B (Medium)', value: 'gpt-oss-120b-medium' },
] as const

const AGY_MODEL_IDS = new Set<string>(AGY_MODEL_CHOICES.map(choice => choice.value))

const AGY_MODEL_ALIASES: Record<string, string> = {
  'claude-sonnet-4-6-thinking': 'claude-sonnet-4-6',
}

export function isValidAgyModel(model: string): boolean {
  return AGY_MODEL_IDS.has(model) || model in AGY_MODEL_ALIASES
}

export function modelEffort(model: string): string | undefined {
  const displayEffort = model.match(/\((low|medium|high)\)/i)?.[1]
  const slugEffort = model.match(/-(low|medium|high)$/i)?.[1]
  return (displayEffort ?? slugEffort)?.toLowerCase()
}

export function friendlyModelName(model: string): string {
  const normalized = AGY_MODEL_ALIASES[model] || model
  const labels: Record<string, string> = {
    'gemini-3.8-flash': 'Gemini 3.8 Flash',
    // 3.7 and 3.6 are off the pickers but stay here: this map is the display
    // fallback for already-persisted pins, and dropping them would render old
    // rows raw.
    'gemini-3.7-flash': 'Gemini 3.7 Flash',
    'gemini-3.6-flash': 'Gemini 3.6 Flash',
    'gemini-3.5-flash': 'Gemini 3.5 Flash',
    'gemini-3.1-pro-preview': 'Gemini 3.1 Pro',
    'gemini-3.5-flash-lite': 'Gemini 3.5 Flash-Lite',
    'claude-sonnet-4-6': 'Sonnet 4.6 (Thinking)',
    'claude-opus-4-6-thinking': 'Opus 4.6 (Thinking)',
  }
  const direct = labels[normalized]
  if (direct) return direct

  const choice = AGY_MODEL_CHOICES.find(item => item.value === normalized)
  if (choice) return choice.name.replace(/\s+—.*$/, '')

  // Strip leading "Claude " if present (e.g. from raw AGY model display strings)
  if (/^Claude\s+/i.test(model)) {
    return model.replace(/^Claude\s+/i, '')
  }

  // Keep older persisted display strings readable during rollout.
  return model
}
