import assert from 'node:assert/strict'
import test from 'node:test'

import { formatAgyLimits, parseAgyQuotaSummary } from '../src/agy-limits.ts'

test('parses quota groups and clamps remaining fractions', () => {
  const groups = parseAgyQuotaSummary({
    groups: [
      {
        displayName: 'Gemini Models',
        description: 'Models within this group: Gemini Flash, Gemini Pro',
        buckets: [
          {
            bucketId: 'gemini-weekly',
            displayName: 'Weekly Limit',
            window: 'weekly',
            resetTime: '2026-08-05T02:50:53Z',
            remainingFraction: 0.907,
          },
          {
            bucketId: 'gemini-5h',
            displayName: 'Five Hour Limit',
            window: '5h',
            resetTime: '2026-07-29T23:16:28Z',
            remainingFraction: 1.2,
          },
        ],
      },
    ],
  })

  assert.equal(groups.length, 1)
  assert.equal(groups[0].displayName, 'Gemini Models')
  assert.equal(groups[0].buckets[0].remainingFraction, 0.907)
  assert.equal(groups[0].buckets[1].remainingFraction, 1)
})

test('rejects a quota response without usable groups', () => {
  assert.throws(() => parseAgyQuotaSummary({ groups: [] }), /no quota groups/i)
  assert.throws(() => parseAgyQuotaSummary({ error: { message: 'denied' } }), /denied/i)
})

test('formats quota headers outside fenced bars and omits the footer', () => {
  const rendered = formatAgyLimits(
    [
      {
        displayName: 'Gemini Models',
        description: 'Models within this group: Gemini Flash, Gemini Pro',
        buckets: [
          {
            id: 'gemini-weekly',
            displayName: 'Weekly Limit',
            window: 'weekly',
            resetTime: '2026-08-05T02:50:53Z',
            remainingFraction: 0.907,
          },
        ],
      },
    ],
    Date.parse('2026-07-29T20:50:53Z'),
  )

  assert.equal(
    rendered,
    [
      '⏱️ **agy limits**',
      '',
      '**Gemini Models**',
      'Gemini Flash, Gemini Pro',
      '```',
      'weekly: █░░░░░░░░░   9%  · 91% left · resets in 6d 6h',
      '```',
    ].join('\n'),
  )
  assert.doesNotMatch(rendered, /Buckets are shared/)
})
