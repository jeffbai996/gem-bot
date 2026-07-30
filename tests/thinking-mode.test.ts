import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('live replaces one thought while collapse accumulates and both disappear', async () => {
  const source = await readFile(new URL('../src/gemma.ts', import.meta.url), 'utf8')

  assert.match(source, /const transientThinking = flags\.thinking === 'live' \|\| flags\.thinking === 'collapse'/)
  assert.match(source, /reasoningTrace:\s*flags\.thinking === 'collapse'/)
  assert.match(source, /thinking:\s*flags\.thinking === 'off' \? ''/)
  assert.match(source, /flags\.thinking === 'live'\s*\?\s*composeLiveThinkingCard/)
  assert.match(source, /const collapsingThinking = transientThinking && replyStart > 0/)
})

test('live Gem edit events carry diffs into the rolling trace', async () => {
  const source = await readFile(new URL('../src/gemma.ts', import.meta.url), 'utf8')

  assert.match(source, /call\.diff = e\.diff/)
  assert.match(source, /const transientTrace = flags\.trace === 'live' \|\| flags\.trace === 'collapse'/)
  assert.match(source, /renderTraceCards\(buildTraceLines\(liveToolCalls\), flags\.trace\)/)
})
