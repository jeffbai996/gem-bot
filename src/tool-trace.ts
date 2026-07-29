// Tool-call rows cap at the settled Claude hook's 79 display cells; result payloads use a tighter
// independent budget because Discord renders their indented rows wider.
// row is capped to it via truncateDisplayWidth, so wide glyphs count as 2.
export const TRACE_ROW_MAX = 79
export const TRACE_RESULT_PAYLOAD_MAX = 76
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
  return truncateDisplayWidthClean(value, maxWidth - 1) + '…'
}

export function truncateDisplayWidthClean(value: string, maxWidth: number): string {
  if (displayWidth(value) <= maxWidth) return value
  let out = ''
  let width = 0
  for (const { segment } of graphemes.segment(value)) {
    const next = displayWidth(segment)
    if (width + next > maxWidth) break
    out += segment
    width += next
  }
  return out
}

export function truncateDigest(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, Math.max(0, maxLength)) : value
}

export function formatAggregateTraceMarker(dropped: number): string {
  return `…(+${dropped} earlier call${dropped === 1 ? '' : 's'})`
}

export const DEFAULT_LIVE_END_LINGER_MS = 10_000
