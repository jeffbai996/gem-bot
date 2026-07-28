export const TRACE_ROW_MAX = 78
export const TRACE_RESULT_PAYLOAD_MAX = TRACE_ROW_MAX - '  ⎿ '.length
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const WIDE_RE = /\p{Extended_Pictographic}|[\u1100-\u115f\u2329\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/u

export function displayWidth(value: string): number {
  let width = 0
  for (const { segment } of graphemes.segment(value)) {
    if (/^[\p{Mark}\p{Format}]+$/u.test(segment)) continue
    width += WIDE_RE.test(segment) ? 2 : 1
  }
  return width
}

export function truncateDisplayWidth(value: string, maxWidth: number): string {
  if (displayWidth(value) <= maxWidth) return value
  let out = ''
  let width = 0
  for (const { segment } of graphemes.segment(value)) {
    const next = displayWidth(segment)
    if (width + next > maxWidth - 1) break
    out += segment
    width += next
  }
  return out + '…'
}
export const DEFAULT_LIVE_END_LINGER_MS = 10_000
