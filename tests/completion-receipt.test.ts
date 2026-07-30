import assert from 'node:assert/strict'
import test from 'node:test'

import { buildCompletionReceipt } from '../src/completion-receipt.ts'
import type { ToolCall } from '../src/gemini.ts'

const call = (name: string, command: string, resultPreview = '', failed = false): ToolCall => ({
  name,
  args: name === 'edit' ? { file_path: command } : { command },
  durationMs: 0,
  resultPreview,
  failed,
})

test('completion receipt summarizes observed coding outcomes behind a spoiler', () => {
  assert.equal(buildCompletionReceipt([
    call('edit', 'src/app.ts'),
    call('shell', 'npm test', '# pass 42\n# skipped 1'),
    call('shell', "git commit -m 'fix: app'", '[main abc1234] fix: app'),
    call('shell', 'git push origin main'),
  ]), '-# ▸ work receipt · ||1 file changed · 42 tests passed / 1 skipped · commit abc1234 · deployed||')
})

test('completion receipt includes agy written files and ignores failed tests', () => {
  assert.equal(buildCompletionReceipt([
    call('shell', 'npm test', '1 failed', true),
  ], ['/tmp/report.md']), '-# ▸ work receipt · ||1 file changed||')
})
