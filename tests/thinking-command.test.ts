import assert from 'node:assert/strict'
import test from 'node:test'

import { geminiCommand } from '../src/commands.ts'

test('/gemini thinking exposes distinct live and collapse modes', () => {
  const command = geminiCommand.toJSON()
  const thinking = command.options?.find(option => option.name === 'thinking') as any
  const mode = thinking?.options?.find((option: any) => option.name === 'mode')

  assert.deepEqual(
    mode?.choices?.map((choice: any) => choice.value),
    ['off', 'on', 'live', 'collapse'],
  )
  assert.match(mode?.choices?.find((choice: any) => choice.value === 'live')?.name ?? '', /current thought/)
  assert.match(mode?.choices?.find((choice: any) => choice.value === 'collapse')?.name ?? '', /full trace/)
})
