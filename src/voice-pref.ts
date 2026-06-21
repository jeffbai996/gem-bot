/**
 * Voice preference — which Gemini prebuilt voice Gem speaks in.
 *
 * One persisted string in STATE_DIR/voice-pref.json, settable via `/voice
 * type`. Applies to BOTH speak (the `say` TTS) and call (the Live session
 * voice): gem-bot injects it into the say + join IPC, so a switch takes effect
 * on the next utterance / next call with no restart. Persisted so the choice
 * survives a gemma restart.
 *
 * The picker surfaces a curated 5 of Gemini's ~30 prebuilt voices — the
 * popular, high-quality ones with distinct character. getVoicePref() still
 * honours any valid stored value (read is lenient); only writes are validated.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const STATE_DIR =
  process.env.DISCORD_STATE_DIR || path.join(os.homedir(), '.gemini', 'channels', 'discord')
const PREF_FILE = path.join(STATE_DIR, 'voice-pref.json')

/** Curated picker. `value` is the literal Gemini prebuilt-voice id passed to
 *  the TTS / Live API; `label` is the Discord choice label; `blurb` is the
 *  human description echoed back on a switch. */
export const VOICE_CHOICES: ReadonlyArray<{ value: string; label: string; blurb: string }> = [
  { value: 'Aoede',  label: 'Aoede — breezy ♀',  blurb: 'breezy, easy-going · female (default)' },
  { value: 'Puck',   label: 'Puck — upbeat ♂',   blurb: 'upbeat, lively · male' },
  { value: 'Charon', label: 'Charon — deep ♂',   blurb: 'deeper, informative · male' },
  { value: 'Kore',   label: 'Kore — firm ♀',     blurb: 'firm, clear · female' },
  { value: 'Zephyr', label: 'Zephyr — bright ♀', blurb: 'bright, light · female' },
]

// Default matches gem-voice's own defaults (Config.gemini_voice / ModelConfig.voice
// = "Aoede") so an absent pref file is a no-op — identical to pre-feature behaviour.
const DEFAULT_VOICE = process.env.GEMINI_VOICE || 'Aoede'
const VALID = new Set(VOICE_CHOICES.map(v => v.value))

/** The current preferred voice. Read fresh from disk each call so a `/voice
 *  type` from any interaction takes effect without a restart. Falls back to
 *  GEMINI_VOICE / Aoede if unset or unreadable. */
export function getVoicePref(): string {
  try {
    const v = JSON.parse(fs.readFileSync(PREF_FILE, 'utf8'))?.voice
    if (typeof v === 'string' && v.trim()) return v
  } catch {
    // no file yet / unreadable / malformed — fall through to the default
  }
  return DEFAULT_VOICE
}

/** Persist a new preferred voice. Validates against the curated set so a typo
 *  can't write a non-existent voice id that the API would later reject. */
export function setVoicePref(voice: string): void {
  if (!VALID.has(voice)) throw new Error(`unknown voice: ${voice}`)
  fs.mkdirSync(STATE_DIR, { recursive: true })
  fs.writeFileSync(PREF_FILE, JSON.stringify({ voice }, null, 2) + '\n')
}
