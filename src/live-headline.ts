// Live "🧠 current thought" headline — gpt-bot's live-ui paradigm, ported
// 2026-07-20. The 💭 spinner card gains a compact italic line showing the
// CURRENT thought (the last non-empty line of the streamed thinking), which
// swaps in place as the thinking advances:
//
//   💭 ✻ **Thinking with high effort…**
//   > 🧠 *weighing the margin math against the thesis*
//   > <leading snippet of the live thinking>
//
// Works for both engines: agy feeds it trajectory thinking (agy_thinking
// events), the API engine feeds it the streamed partial `thinking` field.

const HEADLINE_MAX = 120

/** Last non-empty line of the live thinking, stripped of markdown dressing
 * and clipped to a headline length on a word boundary. */
export function latestThinkingHeadline(text: string): string {
  const line = text.split(/\r?\n/).map(p => p.trim()).filter(Boolean).at(-1) ?? ''
  const clean = line
    .replace(/^>\s*/, '')
    .replace(/^#{1,6}\s+/, '')
    .replace(/^🧠\s*/, '')
    .replace(/^\*\*(.+)\*\*$/, '$1')
    .replace(/^[-*]\s+/, '')
    .trim()
  if (clean.length <= HEADLINE_MAX) return clean
  const slice = clean.slice(0, HEADLINE_MAX)
  const lastSpace = slice.lastIndexOf(' ')
  return (lastSpace > HEADLINE_MAX * 0.6 ? slice.slice(0, lastSpace) : slice).trimEnd() + '…'
}

/** The `> 🧠 *headline*` quote line (with leading newline), or '' when the
 * thinking has no usable line yet. Lowercased to match gpt-bot's look. */
export function brainLine(thinking: string): string {
  const headline = latestThinkingHeadline(thinking)
  return headline ? `\n> 🧠 *${headline.toLocaleLowerCase('en-US')}*` : ''
}

/** Compose the full 💭 spinner card: header + 🧠 headline + snippet. The
 * snippet arrives pre-formatted (leading newline + blockquote) or ''. */
export function composeThinkingCard(opts: {
  label: string
  glyph?: string
  dots?: string
  thinking?: string
  snippet?: string
}): string {
  const { label, glyph = '✻', dots = '…', thinking = '', snippet = '' } = opts
  return `💭 ${glyph} **${label}${dots}**${brainLine(thinking)}${snippet}`
}
