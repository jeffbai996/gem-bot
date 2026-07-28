import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderClaudeStyleDiff, reformatUnifiedDiffs } from '../src/diff-format.ts'

// The exact shape agy pastes: `diff -u` output with file headers + timestamps,
// an @@ hunk, and +/- lines. (Jeff 2026-07-01 — match the Claude bots' diff.)
const RAW = `--- persona.md.bak.20260701\t2026-07-01 10:00:33
+++ persona.md\t2026-07-01 10:00:38
@@ -3,7 +3,7 @@
 **Tone**
 Chill, direct, conversational.
-**Humor: funny gallows humor, not depressive moping.**
+**Humor: dry, deadpan wit.** Sarcastic, deadpan-clever.
 **When to Speak vs Stay Silent**`

test('renderClaudeStyleDiff: drops the ---/+++ timestamp headers', () => {
  const out = renderClaudeStyleDiff(RAW)
  assert.ok(!out.includes('2026-07-01 10:00:33'), 'timestamp gone')
  // File headers are KEPT (path only, no timestamp) — Jeff 2026-07-01.
  assert.ok(out.includes('--- persona.md.bak.20260701'), 'kept --- header path')
  assert.ok(out.includes('+++ persona.md'), 'kept +++ header path')
})

test('renderClaudeStyleDiff: byte-matches the Claude bots — marker at col 0, then lineno', () => {
  const out = renderClaudeStyleDiff(RAW)
  assert.ok(!out.includes('@@'), 'no @@ hunk header')
  // Claude format: "<marker> <rjust-num> <content>" — MARKER FIRST at col 0 so
  // Discord's ```diff colorizer fires; context rows use a leading space.
  assert.match(out, /^- 5 \*\*Humor: funny gallows/m, 'removed: - then num')
  assert.match(out, /^\+ 5 \*\*Humor: dry, deadpan wit/m, 'added: + then num')
  assert.match(out, /^ {2}3 \*\*Tone\*\*/m, 'context: leading space then num')
})

test('renderClaudeStyleDiff: includes the ⎿ [+N, -M] badge', () => {
  const out = renderClaudeStyleDiff(RAW)
  assert.match(out, /^⎿ \[\+1, -1\]$/m, `badge present: ${JSON.stringify(out)}`)
})

test('renderClaudeStyleDiff: no rendered row exceeds 78 columns', () => {
  const raw = `--- ${'old/'.repeat(30)}file.txt\t2026-01-01
+++ ${'new/'.repeat(30)}file.txt\t2026-01-01
@@ -1 +1 @@
-${'a'.repeat(200)}
+${'b'.repeat(200)}`
  const out = renderClaudeStyleDiff(raw)
  const rows = out.split('\n').filter(line => !line.startsWith('```'))
  assert.ok(rows.every(line => line.length <= 78), JSON.stringify(rows))
})

test('renderClaudeStyleDiff: line-number column right-justifies across a 9→10 boundary', () => {
  const raw = `--- a\t2026-01-01
+++ b\t2026-01-01
@@ -8,4 +8,4 @@
 ctx eight
 ctx nine
-old ten
+new ten`
  const out = renderClaudeStyleDiff(raw)
  // width=2 (max lineno is 10): single digits pad so the number column aligns.
  // Context "   8", "   9" (leading-space marker + " 8"); changes "-  8"/"+ 10".
  assert.match(out, /^ {2} 8 ctx eight$/m, `pad 8: ${JSON.stringify(out)}`)
  assert.match(out, /^ {2} 9 ctx nine$/m, 'pad 9')
  assert.match(out, /^- 10 old ten$/m, 'ten removed')
  assert.match(out, /^\+ 10 new ten$/m, 'ten added')
})

test('reformatUnifiedDiffs: rewrites a bare (unfenced) diff in prose', () => {
  const reply = `Here is the diff:\n\n${RAW}\n\nDone.`
  const out = reformatUnifiedDiffs(reply)
  assert.ok(out.includes('Here is the diff:'), 'keeps surrounding prose')
  assert.ok(out.includes('```diff'), 'wraps the diff in a fence')
  assert.ok(!out.includes('2026-07-01 10:00:33'), 'timestamp stripped')
})

test('reformatUnifiedDiffs: rewrites a diff already inside a ``` fence', () => {
  const reply = 'Change:\n```\n' + RAW + '\n```'
  const out = reformatUnifiedDiffs(reply)
  assert.ok(!out.includes('2026-07-01 10:00:33'), 'timestamp stripped inside fenced diff')
  assert.ok(out.includes('--- persona.md.bak.20260701'), 'header path kept')
  assert.match(out, /```diff/)
})

test('reformatUnifiedDiffs: leaves non-diff text untouched', () => {
  const plain = 'Just a normal reply with no diff. Even a stray @@ symbol here.'
  assert.equal(reformatUnifiedDiffs(plain), plain)
})

test('reformatUnifiedDiffs: leaves an ordinary code block untouched', () => {
  const code = 'Here:\n```py\nprint("hi")\n```'
  assert.equal(reformatUnifiedDiffs(code), code)
})
