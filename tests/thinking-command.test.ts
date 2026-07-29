import assert from 'node:assert/strict'
import test from 'node:test'

import { fmtChannelChange, fmtSettingChange, geminiCommand } from '../src/commands.ts'

test('setting acknowledgements show a changed previous value only', () => {
  assert.equal(fmtSettingChange('thinking', 'collapse', 'live'), '✅ thinking → `collapse` (was `live`)')
  assert.equal(fmtSettingChange('thinking', 'live', 'live'), '✅ thinking → `live`')
})

test('channel acknowledgement separates the before and after state', () => {
  assert.equal(
    fmtChannelChange('123', true, true, { enabled: true, requireMention: false }),
    '✅ <#123> updated\n`enabled` yes → yes\n`require @` no → yes',
  )
  assert.equal(
    fmtChannelChange('123', true, false),
    '✅ <#123> configured\n`enabled` yes\n`require @` no',
  )
})

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
