import test from 'node:test'
import assert from 'node:assert/strict'
import { completedAgyAnswer } from '../src/agy-completion.ts'
const row = (content: string, tool_calls: unknown[] = []) => JSON.stringify({source:'MODEL',type:'PLANNER_RESPONSE',status:'DONE',content,tool_calls})
test('pending tool calls cannot turn earlier narration into a final answer', () => {
  assert.throws(() => completedAgyAnswer([row('Checking the service logs.', [{name:'run_command'}]), row('', [{name:'grep_search'}])].join('\n')), /unfinished tool call/)
})
test('a completed answer after tool work is authoritative', () => {
  assert.equal(completedAgyAnswer([row('Checking logs.', [{name:'run_command'}]), row('The process exited with code 1.')].join('\n')), 'The process exited with code 1.')
})
test('empty and promise-only final answers are not completion', () => {
  assert.throws(() => completedAgyAnswer(row('')), /no final answer/)
  assert.throws(() => completedAgyAnswer(row('Checking the service logs to see why the engine fell back on that turn.')), /progress-only/)
})

test('structured provider failure cannot become a successful text reply', async () => {
  const { parseAgyPrintResult } = await import('../src/agy-completion.ts')
  const conversation_id = '00000000-0000-0000-0000-000000000000'
  assert.throws(() => parseAgyPrintResult(JSON.stringify({conversation_id,status:'MAX_STEPS',response:'Checking logs.'})), /MAX_STEPS/)
  assert.equal(parseAgyPrintResult(JSON.stringify({conversation_id,status:'SUCCESS',response:'Done.'})).status, 'SUCCESS')
  assert.throws(() => parseAgyPrintResult('Checking logs.'))
})
