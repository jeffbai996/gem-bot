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
  assert.ok(!out.includes('.bak.20260701'), 'backup filename header gone')
  assert.ok(!out.includes('persona.md'), 'file path header gone')
})

test('renderClaudeStyleDiff: drops the @@ hunk line but keeps its line numbers', () => {
  const out = renderClaudeStyleDiff(RAW)
  assert.ok(!out.includes('@@'), 'no @@ hunk header')
  // hunk starts at line 3; the two context lines before the change are 3 and 4,
  // then the -/+ change lands on line 5 (new side).
  assert.match(out, /- +5 \*\*Humor: funny gallows/)
  assert.match(out, /\+ +5 \*\*Humor: dry, deadpan wit/)
})

test('renderClaudeStyleDiff: marker at column 0 inside a ```diff fence', () => {
  const out = renderClaudeStyleDiff(RAW)
  assert.ok(out.startsWith('```diff\n'), 'opens a diff fence')
  assert.ok(out.trimEnd().endsWith('```'), 'closes the fence')
  // Every +/- body row must have its marker at col 0 so Discord colorizes it.
  for (const ln of out.split('\n')) {
    if (ln === '```diff' || ln === '```') continue
    if (ln.startsWith('+') || ln.startsWith('-')) {
      assert.match(ln, /^[+-] +\d+ /, `marker+lineno gutter: ${JSON.stringify(ln)}`)
    }
  }
})

test('renderClaudeStyleDiff: line-number gutter is right-justified / aligned', () => {
  // A hunk crossing a 9→10 boundary must pad the single-digit numbers so the
  // content column stays aligned.
  const raw = `--- a\t2026-01-01
+++ b\t2026-01-01
@@ -9,3 +9,3 @@
 ctx nine
-old ten
+new ten`
  const out = renderClaudeStyleDiff(raw)
  // width=2 (max lineno is 10), so "9" is padded to " 9". Context line: leading
  // space + " 9" → "  9 ctx". Change lines: "- 10 old" / "+ 10 new". Content
  // column stays aligned across the single/double-digit boundary.
  assert.match(out, /^  9 ctx nine$/m, `single-digit padded: ${JSON.stringify(out)}`)
  assert.match(out, /^- 10 old ten$/m, `double-digit removed: ${JSON.stringify(out)}`)
  assert.match(out, /^\+ 10 new ten$/m, `double-digit added: ${JSON.stringify(out)}`)
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
  assert.ok(!out.includes('.bak.20260701'), 'header stripped inside fenced diff')
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
