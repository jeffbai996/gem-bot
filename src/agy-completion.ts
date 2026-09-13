/** A successful process exit is not proof that an agent finished its turn. */
export function completedAgyAnswer(transcript: string): string {
  const rows = transcript.split('\n').filter(line => line.trim()).map(line => JSON.parse(line))
  const last = rows.findLast(row => row.source === 'MODEL' && row.type === 'PLANNER_RESPONSE')
  if (last?.tool_calls?.length) throw new Error('agy stopped with an unfinished tool call')
  if (!last || last.status !== 'DONE' || !last.content?.trim()) throw new Error('agy stopped with no final answer')
  const answer = last.content.trim()
  if (answer.length < 240 && /^(?:(?:I(?:’|')m|I am)\s+)?(?:Checking|Reading|Searching|Looking|Inspecting)\b[^\n]*[.!…]?$/i.test(answer)) {
    throw new Error('agy stopped with a progress-only reply')
  }
  return answer
}

export interface AgyPrintResult {
  conversation_id: string
  status: string
  response?: string
}

export function parseAgyPrintResult(stdout: string): AgyPrintResult {
  const result = JSON.parse(stdout)
  if (!result || !/^[a-f0-9-]{36}$/i.test(result.conversation_id ?? '') || typeof result.status !== 'string') {
    throw new Error('agy returned an invalid structured result')
  }
  if (result.status !== 'SUCCESS') throw new Error(`agy stopped: ${result.status}`)
  return result
}
