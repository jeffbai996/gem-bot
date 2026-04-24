import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { ToolContext } from '../../src/tools/registry.ts'
import { ibkrBriefingTool } from '../../src/tools/ibkr-briefing.ts'

const fakeCtx: ToolContext = { gemini: {} as any }

describe('ibkrBriefingTool', () => {
  test('declaration name is ibkr_briefing', () => {
    assert.equal(ibkrBriefingTool.declaration.name, 'ibkr_briefing')
  })

  test('declaration has empty properties and no required args', () => {
    const params = ibkrBriefingTool.declaration.parameters
    const props = params?.properties as Record<string, unknown>
    assert.deepEqual(props ?? {}, {})
    assert.deepEqual(params?.required ?? [], [])
  })

  test('execute returns a non-empty stub string', async () => {
    const result = await ibkrBriefingTool.execute({}, fakeCtx)
    assert.ok(result.length > 0)
    assert.match(result, /stub/i)
  })
})
