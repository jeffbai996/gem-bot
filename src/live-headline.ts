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

import type { LiveTimelineStep } from './gemini.ts'
import { displayWidth } from './tool-trace.ts'
import { renderTraceCards } from './tool-trace.ts'
import { formatUnifiedDiffTrace } from './diff-format.ts'

const HEADLINE_MAX = 120
const DETAIL_MAX = 160
const TIMELINE_BODY_MAX = 280
const TIMELINE_CARD_MAX = 1960

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

/** A heading is a label, not a sentence. Gemini's thought summaries are
 * inconsistent about it — "Confirming Tool Availability" and "Assessing the
 * information request." arrive from the same model on the same turn — so the
 * trailing full stop is dropped here rather than left to the model. Ellipsis
 * is meaningful (a trailing-off thought) and survives; ? and ! are load-bearing
 * in a heading and survive too. Deliberately not part of cleanHeadlineLine,
 * which also runs over body prose where the stop belongs. */
function stripTrailingStop(title: string): string {
  return title.endsWith('...') ? title : title.replace(/\.$/, '')
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
  return `💭 **Thought for ${seconds}s**\n${thinking.split(/\r?\n/).map(line => `> ${line}`).join('\n')}`
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
  return `💭 ${glyph} **${label}${dots}**${reasoning}${cleanDetail ? `\n${cleanDetail}` : ''}`
}

const ACTION_LABELS: Record<string, string> = {
  bash: 'Running',
  run: 'Running',
  browse: 'Browsing',
  click: 'Clicking',
  grep: 'Searching',
  list: 'Listing',
  read: 'Reading',
  readpage: 'Reading',
  screenshot: 'Capturing',
  search: 'Searching',
  type: 'Typing',
  write: 'Writing',
}

function actionPresentation(text: string): { emoji: string, label: string } {
  const key = text.trim().toLocaleLowerCase('en-US')
  const label = ACTION_LABELS[key] ?? (text.trim() || 'Using tool')
  const emoji = /read|list/.test(key) ? '📖'
    : /search|grep|browse/.test(key) ? '🌐'
    : /write/.test(key) ? '✍️'
    : /bash|run/.test(key) ? '⌨️'
    : /click|type/.test(key) ? '🖱️'
    : /screen/.test(key) ? '📸'
    : '🔧'
  return { emoji, label }
}

function timelineThinkingBlock(step: LiveTimelineStep, complete = false): string {
  const lines = step.text.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  const headingIndex = lines.findIndex(line => /^\*\*.+\*\*$/.test(line) || /^#{1,6}\s+\S/.test(line))
  const titleIndex = headingIndex
  const rawTitle = headingIndex >= 0 ? stripTrailingStop(cleanHeadlineLine(lines[headingIndex])) : ''
  const title = complete ? rawTitle : clipOnWordBoundary(rawTitle, HEADLINE_MAX)
  const body = lines
    .filter((_, index) => index !== titleIndex)
    .map(cleanHeadlineLine)
    .filter(Boolean)
    .join(' ')
  const detail = step.detail?.trim() ?? ''
  const bodyParts = [body, detail && detail !== body ? detail : ''].filter(Boolean)
  const summary = complete ? bodyParts.join(' ') : clipOnWordBoundary(bodyParts.join(' '), TIMELINE_BODY_MAX)
  // Quoted, not bare. A bare `**title**` renders at column 0 in Discord's
  // default text colour while the body sits grayed inside the quote — one
  // thought split across two visual registers, and a second trace style next
  // to renderThoughtBlock's fully-quoted card. Quoting the heading puts the
  // whole step in one gray block and leaves exactly one trace look.
  return [title ? `> **${title}**` : '', summary ? `> ${summary}` : ''].filter(Boolean).join('\n')
}

// NO PER-ROW DURATION on this card. It had one for a few hours on 2026-09-10
// and Jeff dropped it the same evening: "just drop the time like the 1.0s and
// all that". The live card is a running account of what the bot is DOING, and
// the other bots' equivalent card carries no per-call timing either — only the
// overall elapsed in the header. Per-call timing still exists where it is
// actually read: the `[Nms]` badges on the 🔧 Tool trace card.
function timelineActionRow(step: LiveTimelineStep): { left: string, detail: string } {
  const { label } = actionPresentation(step.text)
  const detail = step.detail ? clipOnWordBoundary(step.detail.replace(/\s+/g, ' ').trim(), DETAIL_MAX) : ''
  // Every row keeps its own action. Consecutive calls of the same kind used to
  // have the label blanked out, which left a bare command floating under the
  // one above it with nothing to say what it was — and, since the anchor row
  // led with an emoji and the orphan led with spaces, not even lined up with
  // it. Repeating six characters is worth a card you can read.
  // No per-row emoji. Discord renders them from the emoji font, not the code
  // font, and different ones take different advance widths — 📖 and ⌨️ are not
  // the same width, so two labelled rows still failed to line up even after
  // the orphans were fixed (Jeff 2026-09-10: "even more misaligned now"). No
  // run of spaces is the width of an emoji either, which is why nothing could
  // pad around it. The card's own 🔧 header keeps the glyph; the rows keep the
  // alignment, and the label already says what ran.
  const left = step.status === 'failed' ? `${label} failed`
    : `${label}${step.status === 'running' ? '…' : ''}`
  // Tool arguments can contain backticks; keep them from closing the fence.
  return {
    left: left.replace(/`/g, 'ˋ'),
    detail: detail.replace(/`/g, 'ˋ'),
  }
}

function timelineBlocks(steps: LiveTimelineStep[], complete = false): string {
  const blocks: string[] = []
  let rows: Array<{ left: string, detail: string }> = []
  const flush = () => {
    if (rows.length) {
      // One column, measured across the whole block: every argument starts
      // clear of the longest action, so the commands read down the card.
      const argAt = Math.max(...rows.map(row => displayWidth(row.left))) + 2
      const text = rows.map(row => row.detail
        ? row.left + ' '.repeat(argAt - displayWidth(row.left)) + row.detail
        : row.left).join('\n')
      blocks.push('🔧 **Tool call**\n```text\n' + text + '\n```')
    }
    rows = []
  }
  for (const step of steps) {
    if (step.kind === 'thinking') {
      flush()
      blocks.push(timelineThinkingBlock(step, complete))
    } else if (step.diff) {
      flush()
      const { badge, body } = formatUnifiedDiffTrace(step.diff)
      const name = step.detail || step.text
      blocks.push(...renderTraceCards([
        `${step.status === 'failed' ? '-' : '+'} ● Edit(${name})${step.status === 'failed' ? ' FAILED' : ''}`,
        `  ⎿ ${badge}`,
        ...body,
      ], 'live'))
    } else {
      rows.push(timelineActionRow(step))
    }
  }
  flush()
  return blocks.join('\n')
}

/** One Discord-safe rolling trajectory. It preserves the ordered public
 * progress summaries and actions while dropping only the oldest complete
 * blocks when the card reaches Discord's message limit. */
export function composeTrajectoryTimelineCard(opts: {
  label: string
  glyph?: string
  dots?: string
  steps: LiveTimelineStep[]
  complete?: boolean
}): string {
  const { label, glyph = '✻', dots = '…', steps } = opts
  const header = `💭 ${glyph} **${label}${dots}**\n-# ${steps.length} step${steps.length === 1 ? '' : 's'}`
  // The final renderer paginates this body; only the live preview needs a cap.
  if (opts.complete) return `${header}\n${timelineBlocks(steps, true)}`
  let result = header
  // Re-render the retained tail so its first tool row always has its action
  // label and every grouped fence closes, even when older rows are dropped.
  for (let index = steps.length - 1; index >= 0; index--) {
    const marker = index > 0 ? `\n-# ↑ ${index} earlier steps omitted` : ''
    const candidate = `${header}${marker}\n${timelineBlocks(steps.slice(index))}`
    if (candidate.length > TIMELINE_CARD_MAX) break
    result = candidate
  }
  return result
}
