// Reformat a raw unified diff into the Claude Discord bots' tool-trace diff
// style. agy (the flat-sub CLI engine) shells `diff -u` and pastes the raw
// output — file headers, timestamps, @@ hunks and all — straight into its reply,
// which reads nothing like the Claude bots' clean line-numbered diff. Jeff
// 2026-07-01: "reformat gemma's code output to be as similar to claude discord
// bots code output as humanly possible, line numbers and everything. No timestamp
// on the files at the very top."
//
// Faithful port of the Claude bots' tool-trace diff renderer: drop the
// ---/+++ file-header lines (which carry the timestamps Jeff wants gone) AND the
// @@ hunk line, seed line numbers off the @@ counters, and render each row as
// "<marker> <right-justified lineno> <content>" so Discord's ```diff colorizer
// fires (marker at column 0) with an aligned line-number gutter.

import { TRACE_ROW_MAX, truncateDisplayWidth } from './tool-trace.ts'

const _HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/
const DIFF_MEGA_LINE_MAX = 300

/** Render ONE raw unified-diff string as a Claude-style line-numbered ```diff```
 *  block. Returns the input unchanged if it doesn't parse as a diff. */
export function renderClaudeStyleDiff(diffText: string): string {
  const lines = diffText.split('\n')
  // Keep the file-header lines but STRIP the trailing timestamp `diff -u` appends
  // (path and timestamp are tab- or run-of-spaces-separated). Jeff 2026-07-01:
  // "file headers are fine, just no need for the timestamp".
  const header: string[] = []
  let oldLn = 0, newLn = 0
  const rows: Array<{ marker: string; num: number | null; content: string }> = []
  let sawHunk = false
  for (const ln of lines) {
    if (ln.startsWith('--- ') || ln.startsWith('+++ ')) {
      // Drop the timestamp: everything after the first tab, or after 2+ spaces.
      const path = ln.replace(/[\t ]{1,}\d{4}-\d\d-\d\d[ \t].*$/, '').replace(/\t.*$/, '').trimEnd()
      header.push(path)
      continue
    }
    if (ln.startsWith('diff ') || ln.startsWith('index ')) continue // git preamble, if present
    const m = ln.match(_HUNK_RE)
    if (m) { oldLn = parseInt(m[1], 10); newLn = parseInt(m[2], 10); sawHunk = true; continue }
    if (!sawHunk) continue // ignore anything before the first hunk
    if (ln.startsWith('+')) { rows.push({ marker: '+', num: newLn, content: ln.slice(1) }); newLn++ }
    else if (ln.startsWith('-')) { rows.push({ marker: '-', num: oldLn, content: ln.slice(1) }); oldLn++ }
    else if (ln.startsWith('\\')) { /* "\ No newline at end of file" — skip */ }
    else { rows.push({ marker: ' ', num: newLn, content: ln.startsWith(' ') ? ln.slice(1) : ln }); oldLn++; newLn++ }
  }
  if (!rows.length) return diffText // not a diff we understood — leave untouched
  // Byte-for-byte the Claude bots' tool-trace diff (tool_watcher.py _diff_block +
  // _tool_message_content). Jeff 2026-07-01: "just like the claude bots ones. Byte
  // by byte, even the [+, -], all of it." So:
  //   • MARKER FIRST at column 0 so Discord's ```diff highlighter colors the row
  //     (+ green, - red); then the right-justified line number; then content.
  //     "+ 5 content" / "- 5 content" / context "  5 content".
  //   • a `⎿ [+N, -M]` badge line above the body (the counts).
  // Context lines get ONE extra leading space so their content column lines up
  // with the marker rows (matches _tool_message_content's 1-cell pad).
  const added = rows.filter(r => r.marker === '+').length
  const removed = rows.filter(r => r.marker === '-').length
  const width = Math.max(1, ...rows.filter(r => r.num !== null).map(r => String(r.num).length))
  const contentMax = Math.max(8, TRACE_ROW_MAX - 3 - width)
  const body = rows.map(({ marker, num, content }) => {
    const capped = content.length <= DIFF_MEGA_LINE_MAX ? content : content.slice(0, DIFF_MEGA_LINE_MAX - 1) + '…'
    const clipped = capped.length <= contentMax ? capped : capped.slice(0, contentMax - 1) + '…'
    const numStr = String(num).padStart(width)
    // Marker at col 0 for the colorizer; context uses a leading space so its
    // content aligns one cell in, matching the +/- rows' "marker + space".
    return marker === ' ' ? `  ${numStr} ${clipped}` : `${marker} ${numStr} ${clipped}`
  })
  const badge = `⎿ [+${added}, -${removed}]`
  const headerBlock = header.length
    ? header.map(line => truncateDisplayWidth(line, TRACE_ROW_MAX)).join('\n') + '\n'
    : ''
  return '```diff\n' + headerBlock + badge + '\n' + body.join('\n') + '\n```'
}

/** Find unified-diff blocks anywhere in reply text and Claude-ify them. Handles a
 *  diff already inside a ``` fence AND a bare diff pasted as prose. A block is
 *  recognized by a `--- `/`+++ ` header pair followed by an `@@` hunk. Non-diff
 *  text is returned untouched. */
export function reformatUnifiedDiffs(text: string): string {
  if (!text.includes('@@') || !/^(---|\+\+\+) /m.test(text)) return text
  // First, any diff already inside a ```(diff|patch)? fence → re-render uniformly.
  const fenceRe = /```(?:diff|patch)?\n([\s\S]*?)\n```/g
  let out = text.replace(fenceRe, (whole, inner: string) =>
    /^--- /m.test(inner) && inner.includes('@@') ? renderClaudeStyleDiff(inner) : whole)
  // Then a bare (unfenced) diff. Line-scan rather than one greedy regex: find the
  // `--- `/`+++ ` header pair, then consume the CONTIGUOUS run of diff-body lines
  // (@@ hunks and +/-/space/\ lines). A blank line or any non-diff prose line ends
  // the block. This can't under-match the body the way a lazy [\s\S]*? did.
  const lines = out.split('\n')
  const result: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const isHeaderPair = lines[i].startsWith('--- ') &&
      i + 1 < lines.length && lines[i + 1].startsWith('+++ ') &&
      i + 2 < lines.length && lines[i + 2].startsWith('@@')
    if (!isHeaderPair) { result.push(lines[i]); continue }
    // Collect the header + every following diff-body line until a non-diff line.
    let j = i + 2 // start at the @@ line
    const block: string[] = [lines[i], lines[i + 1]]
    while (j < lines.length && /^([-+ \\]|@@)/.test(lines[j]) && lines[j] !== '') {
      block.push(lines[j]); j++
    }
    result.push(renderClaudeStyleDiff(block.join('\n')))
    i = j - 1 // resume after the consumed block
  }
  return result.join('\n')
}
