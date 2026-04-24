import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { ToolContext } from '../../src/tools/registry.ts'
import { searchMemoryTool, formatSearchResults } from '../../src/tools/search-memory.ts'

describe('searchMemoryTool', () => {
  test('declaration has correct name and required query arg', () => {
    assert.equal(searchMemoryTool.declaration.name, 'search_memory')
    assert.deepEqual(searchMemoryTool.declaration.parameters?.required, ['query'])
    const props = searchMemoryTool.declaration.parameters?.properties as Record<string, any>
    assert.ok(props.query, 'query property defined')
  })

  test('execute without channelId returns a helpful error string', async () => {
    const ctx: ToolContext = { gemini: { embed: async () => [] } as any }
    const result = await searchMemoryTool.execute({ query: 'x' }, ctx)
    assert.match(result, /channel/i)
  })

  test('execute without query arg returns a helpful error string', async () => {
    const ctx: ToolContext = {
      channelId: 'C1',
      gemini: { embed: async () => [] } as any
    }
    const result = await searchMemoryTool.execute({}, ctx)
    assert.match(result, /query/i)
  })
})

describe('formatSearchResults', () => {
  test('empty array returns the no-match string', () => {
    assert.equal(formatSearchResults([]), 'No matching messages found in memory.')
  })

  test('formats entries as [timestamp] author: content joined by newlines', () => {
    const out = formatSearchResults([
      { timestamp: '2026-01-01T00:00:00Z', author_name: 'Dan', content: 'hello world' } as any,
      { timestamp: '2026-01-02T00:00:00Z', author_name: 'Jeff', content: 'yo' } as any
    ])
    assert.equal(
      out,
      '[2026-01-01T00:00:00Z] Dan: hello world\n[2026-01-02T00:00:00Z] Jeff: yo'
    )
  })
})
