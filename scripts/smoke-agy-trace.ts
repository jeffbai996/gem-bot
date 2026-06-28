// Smoke test: run a REAL agy turn through respondViaAgy and confirm the
// trajectory-trace restore works — (a) parsed.thinking carries real reasoning,
// (b) tool_call_start/end events fired, (c) the final reply is correct.
//
// Forces a tool call by asking agy to shell out. Run with:
//   npx tsx scripts/smoke-agy-trace.ts
import { respondViaAgy } from '../src/agy-chat.ts'
import { parseResponse } from '../src/gemini.ts'
import type { LifecycleEvent } from '../src/gemini.ts'

const events: LifecycleEvent[] = []

const systemPrompt = [
  'You are a terse test assistant.',
  'You MUST reply in this exact JSON format and nothing else:',
  '{"react": null, "thinking": "<your reasoning>", "reply": "<your message>"}',
].join('\n')

const main = async () => {
  // agy in this path runs --sandbox (no --dangerously-skip-permissions), and it
  // can shell out via its agentic tools. Ask it to run a deterministic command.
  const userMessageText =
    'Run the shell command `echo TEST_42` and tell me exactly what it printed.'

  const t0 = Date.now()
  const { parsed, meta } = await respondViaAgy(
    {
      systemPrompt,
      history: [],
      userMessageText,
      userName: 'tester',
      onEvent: (e) => events.push(e),
    },
    parseResponse
  )
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1)

  const starts = events.filter((e) => e.type === 'tool_call_start')
  const ends = events.filter((e) => e.type === 'tool_call_end')

  console.log('\n========== AGY TRACE SMOKE RESULT ==========')
  console.log(`elapsed: ${elapsed}s`)
  console.log('\n-- lifecycle events --')
  console.log(`  native_thinking: ${events.filter((e) => e.type === 'native_thinking').length}`)
  console.log(`  tool_call_start: ${starts.length}`)
  for (const e of starts) console.log(`    start: ${(e as any).name}`)
  console.log(`  tool_call_end:   ${ends.length}`)

  console.log('\n-- parsed.thinking (real reasoning from trajectory) --')
  console.log(parsed.thinking ? parsed.thinking.slice(0, 600) : '(none)')

  console.log('\n-- parsed.reply --')
  console.log(parsed.reply ?? '(none)')

  console.log('\n-- meta.toolCalls (always [] on agy path — trace is via events) --')
  console.log(JSON.stringify(meta.toolCalls))

  console.log('\n========== VERDICT ==========')
  const okThinking = !!parsed.thinking && parsed.thinking.trim().length > 0
  const okTools = starts.length > 0 && ends.length > 0
  const okReply = !!parsed.reply && /TEST_42/i.test(parsed.reply)
  console.log(`(a) real thinking text:      ${okThinking ? 'PASS' : 'FAIL'}`)
  console.log(`(b) tool_call_start+end:     ${okTools ? 'PASS' : 'FAIL'}`)
  console.log(`(c) correct reply (TEST_42): ${okReply ? 'PASS' : 'FAIL'}`)
  process.exit(okThinking && okTools && okReply ? 0 : 1)
}

main().catch((e) => {
  console.error('SMOKE FAILED:', e)
  process.exit(1)
})
