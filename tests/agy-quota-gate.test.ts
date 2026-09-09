import { test } from 'node:test'
import assert from 'node:assert/strict'
import { quotaFailureForModel } from '../src/agy-quota-gate.ts'
import { describeAgyFailure } from '../src/agy-fallback-reason.ts'

const now = Date.parse('2026-01-01T00:00:00Z')
const groups = [{ displayName: 'Gemini Models', description: 'Gemini Flash, Gemini Pro', buckets: [
  { id: 'gemini-5h', displayName: 'Five Hour', window: '5h', resetTime: '2026-01-01T01:00:00Z', remainingFraction: 0 },
] }]
test('reports exhausted matching quota with authoritative reset time', () => {
  const failure = quotaFailureForModel(groups, 'Gemini Pro', now)
  assert.match(failure!, /5-hour quota reached/)
  assert.match(describeAgyFailure(failure!), /<t:1767229200:R>/)
})
test('does not mislabel unrelated models, available or expired buckets', () => {
  assert.equal(quotaFailureForModel(groups, 'Claude Sonnet', now), null)
  assert.equal(quotaFailureForModel(groups, 'Gemini Pro', now + 3_600_001), null)
  assert.equal(quotaFailureForModel([{ ...groups[0], buckets: [{ ...groups[0].buckets[0], remainingFraction: 0.1 }] }], 'Gemini Pro', now), null)
})
test('unknown reset remains explicit; genuine timeout stays a timeout', () => {
  const failure = quotaFailureForModel([{ ...groups[0], buckets: [{ ...groups[0].buckets[0], resetTime: null }] }], 'Gemini Pro', now)
  assert.match(failure!, /reset time unavailable/)
  assert.equal(describeAgyFailure('agy idle watchdog fired'), 'antigravity timed out')
})
