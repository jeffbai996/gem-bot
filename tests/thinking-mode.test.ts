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

test('rolling live trace is reposted beneath newer streamed output without duplicates', async () => {
  const source = await readFile(new URL('../src/gemma.ts', import.meta.url), 'utf8')
  const start = source.indexOf('const rehomeLiveTraceAtBottom')
  const end = source.indexOf('\n    const flushLiveTrace', start)
  const helper = source.slice(start, end)
  const flushStart = source.indexOf('const flushStream = async () =>')
  const flushEnd = source.indexOf('\n    streamInterval =', flushStart)
  const flush = source.slice(flushStart, flushEnd)

  assert.ok(start >= 0)
  assert.match(helper, /flags\.trace !== 'live'/)
  assert.match(helper, /isNewerDiscordMessage\(below\.id, anchor\.id\)/)
  assert.match(helper, /sendRawMessage\(message, current\.content\)/)
  assert.ok(helper.indexOf('sendRawMessage(message, current.content)') < helper.indexOf('previous.delete()'))
  assert.match(flush, /await rehomeLiveTraceAtBottom\(activeMessages\.at\(-1\) \?\? null\)/)
})
