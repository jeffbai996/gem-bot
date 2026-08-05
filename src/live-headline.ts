// Live "🧠 current thought" headline — gpt-bot's live-ui paradigm, ported
// 2026-07-20. The 💭 spinner card gains a compact italic line showing the
// CURRENT thought (an explicit Antigravity heading when available, otherwise
// the stream's last non-empty line), which swaps in place as thinking advances:
//
//   💭 ✻ **Thinking with high effort…**
//   > 🧠 *weighing the margin math against the thesis*
//   <latest public action narration>
//
// Works for both engines: agy feeds trajectory reasoning and action as separate
// fields, while the API engine feeds its streamed partial `thinking` field.
// `live` uses the compact current headline; `collapse` accumulates every line.

const HEADLINE_MAX = 120
const DETAIL_MAX = 160

function clipOnWordBoundary(text: string, max: number): string {
  if (text.length <= max) return text
  const slice = text.slice(0, max)
  const lastSpace = slice.lastIndexOf(' ')
  return (lastSpace > max * 0.6 ? slice.slice(0, lastSpace) : slice).trimEnd() + '…'
}

function cleanHeadlineLine(line: string): string {
  return line
    .replace(/^>\s*/, '')
    .replace(/^#{1,6}\s+/, '')
    .replace(/^🧠\s*/, '')
    .replace(/^\*\*(.+)\*\*$/, '$1')
    .replace(/^[-*]\s+/, '')
    .trim()
}

/** Every cleaned non-empty reasoning line, preserving arrival order for the
 * explicit full-trace collapse mode. */
export function thinkingTraceLines(parts: string[]): string[] {
  return parts
    .flatMap(part => part.split(/\r?\n/))
    .map(cleanHeadlineLine)
    .filter(Boolean)
}

/** Compact live headline. Antigravity emits `**Short heading**` followed by a
 * long private-reasoning paragraph, so prefer the latest explicit heading.
 * Generic/native streams without headings retain the gpt-bot behavior of using
 * their latest non-empty line. */
export function latestThinkingHeadline(text: string): string {
  const lines = text.split(/\r?\n/).map(p => p.trim()).filter(Boolean)
  const explicit = lines.filter(line =>
    /^\*\*.+\*\*$/.test(line) || /^#{1,6}\s+\S/.test(line)
  ).at(-1)
  const clean = cleanHeadlineLine(explicit ?? lines.at(-1) ?? '')
  return clipOnWordBoundary(clean, HEADLINE_MAX)
}

/** Public Antigravity action narration belongs below the headline, but only as
 * one bounded line. Some planner steps emit paragraphs/lists here; rendering
 * them verbatim recreates the wall this live surface is meant to replace. */
export function compactLiveDetail(text: string): string {
  const line = text.split(/\r?\n/).map(p => p.trim()).find(Boolean) ?? ''
  const clean = line.replace(/^>\s*/, '').replace(/^[-*]\s+/, '').trim()
  return clipOnWordBoundary(clean, DETAIL_MAX)
}

/** The `> 🧠 *headline*` quote line (with leading newline), or '' when the
 * thinking has no usable line yet. Lowercased to match gpt-bot's look. */
export function brainLine(thinking: string): string {
  const headline = latestThinkingHeadline(thinking)
  return headline ? `\n> 🧠 *${headline.toLocaleLowerCase('en-US')}*` : ''
}

/** Final compact snapshot for `thinking:live`. Full `thinking:on` remains
 * available separately for deliberate inspection of the complete trace. */
export function composeLiveThinkingCard(seconds: number, thinking: string): string {
  return `💭 **Thought for ${seconds}s**${brainLine(thinking)}`
}

/** Compose the full 💭 spinner card: header + one 🧠 headline + the latest
 * public action narration. */
export function composeThinkingCard(opts: {
  label: string
  glyph?: string
  dots?: string
  thinking?: string
  reasoningTrace?: string[]
  detail?: string
  narrationTrace?: string[]
}): string {
  const {
    label,
    glyph = '✻',
    dots = '…',
    thinking = '',
    reasoningTrace = [],
    detail = '',
    narrationTrace = [],
  } = opts
  const trace = thinkingTraceLines(reasoningTrace)
    .map(line => `> 🧠 *${line.toLocaleLowerCase('en-US')}*`)
  const cleanDetail = narrationTrace.length
    ? narrationTrace.map(part => part.trim()).filter(Boolean).join('\n\n')
    : compactLiveDetail(detail)
  const reasoning = trace.length ? `\n${trace.join('\n')}` : brainLine(thinking)
  return `💭 ${glyph} **${label}${dots}**${reasoning}${cleanDetail ? `\n💬 ***Narrating…***\n${cleanDetail}` : ''}`
}
