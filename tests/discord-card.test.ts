import assert from 'node:assert/strict'
import test from 'node:test'

import { formatCodeCard, formatSkippedAttachments } from '../src/discord-card.ts'
import { formatCacheInfo } from '../src/commands.ts'

test('code card sanitizes nested fences and emits one balanced block', () => {
  const rendered = formatCodeCard('🧪 **readout**', ['name : demo', 'body : ```oops'])
  assert.equal(rendered, '🧪 **readout**\n```\nname : demo\nbody : ′′′oops\n```')
  assert.equal(rendered.match(/```/g)?.length, 2)
})

test('attachment skips render as a code card', () => {
  const rendered = formatSkippedAttachments([
    { name: 'huge```file.zip', reason: 'too_large' },
    { name: 'notes.txt', reason: 'unsupported_type' },
  ])
  assert.match(rendered, /^📎 \*\*Some files weren’t attached\*\*\n```/)
  assert.match(rendered, /huge′′′file\.zip : too large/)
  assert.match(rendered, /notes\.txt\s+: unsupported file type/)
  assert.equal(rendered.match(/```/g)?.length, 2)
})

test('cache inventory renders all rows inside one code card', () => {
  const rendered = formatCacheInfo([{
    systemHash: 'abc123',
    model: 'gemini-example',
    createdAt: 0,
    lastUsedAt: 30_000,
    ttlSec: 120,
    cachedTokens: 4096,
    systemTokens: 4096,
    hitCount: 2,
  }], 300, 60_000)
  assert.match(rendered, /^📦 \*\*gemma cache\*\* · 1 live entry\n```/)
  assert.match(rendered, /abc123 · gemini-example/)
  assert.match(rendered, /size\s+: 4,096 tok billed/)
  assert.match(rendered, /default TTL : 300s/)
  assert.equal(rendered.match(/```/g)?.length, 2)
})
