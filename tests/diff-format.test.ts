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

test('renderClaudeStyleDiff: drops the @@ hunk line but keeps its line numbers', () => {
  const out = renderClaudeStyleDiff(RAW)
  assert.ok(!out.includes('@@'), 'no @@ hunk header')
  // hunk starts at line 3; context lines 3 and 4, then the -/+ change on line 5.
  // Format is "<num> <marker> <content>" — number first.
  assert.match(out, /^5 - \*\*Humor: funny gallows/m)
  assert.match(out, /^5 \+ \*\*Humor: dry, deadpan wit/m)
})

test('renderClaudeStyleDiff: line numbers align in a left column for ALL rows', () => {
  const out = renderClaudeStyleDiff(RAW)
  assert.ok(out.startsWith('```diff\n'), 'opens a diff fence')
  assert.ok(out.trimEnd().endsWith('```'), 'closes the fence')
  // Number FIRST, then marker (space for context, +/- for changes), then content.
  // The number column is what must line up — context and changed rows alike.
  assert.match(out, /^3 {3}\*\*Tone\*\*/m, 'context row: num then 3 spaces (space-marker + 2 sep)')
  assert.match(out, /^5 - /m, 'removed row: num then - marker')
  assert.match(out, /^5 \+ /m, 'added row: num then + marker')
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
  // width=2 (max lineno is 10), so "8"/"9" pad to " 8"/" 9" and all numbers end
  // in the same column: " 8 ", " 9 ", "10 ", "10 ".
  assert.match(out, /^ 8 {3}ctx eight$/m, `pad 8: ${JSON.stringify(out)}`)
  assert.match(out, /^ 9 {3}ctx nine$/m, 'pad 9')
  assert.match(out, /^10 - old ten$/m, 'ten removed')
  assert.match(out, /^10 \+ new ten$/m, 'ten added')
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
