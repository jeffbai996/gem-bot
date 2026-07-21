import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { latestThinkingHeadline, brainLine, composeThinkingCard } from '../src/live-headline.js'

describe('latestThinkingHeadline', () => {
  it('returns the last non-empty line', () => {
    const text = 'First I looked at the repo.\n\nNow checking the margin math.'
    assert.equal(latestThinkingHeadline(text), 'Now checking the margin math.')
  })

  it('strips markdown dressing (quotes, headers, bold, bullets, brain)', () => {
    assert.equal(latestThinkingHeadline('> quoted thought'), 'quoted thought')
    assert.equal(latestThinkingHeadline('## a header thought'), 'a header thought')
    assert.equal(latestThinkingHeadline('**bold thought**'), 'bold thought')
    assert.equal(latestThinkingHeadline('- bullet thought'), 'bullet thought')
    assert.equal(latestThinkingHeadline('🧠 already brained'), 'already brained')
  })

  it('clips long lines on a word boundary with a trailing ellipsis', () => {
    const long = 'word '.repeat(60).trim()
    const out = latestThinkingHeadline(long)
    assert.ok(out.length <= 121)
    assert.ok(out.endsWith('…'))
    assert.ok(!out.includes('wor…'), 'must not clip mid-word')
  })

  it('returns empty for empty or whitespace-only input', () => {
    assert.equal(latestThinkingHeadline(''), '')
    assert.equal(latestThinkingHeadline('\n\n  \n'), '')
  })
})

describe('brainLine', () => {
  it('renders the quoted italic brain line, lowercased', () => {
    assert.equal(brainLine('Checking The Numbers'), '\n> 🧠 *checking the numbers*')
  })

  it('is empty when there is no thinking yet', () => {
    assert.equal(brainLine(''), '')
  })

  it('passes CJK through untouched', () => {
    assert.equal(brainLine('检查蛋宝的血糖记录'), '\n> 🧠 *检查蛋宝的血糖记录*')
  })
})

describe('composeThinkingCard', () => {
  it('header only when no thinking', () => {
    assert.equal(
      composeThinkingCard({ label: 'Thinking with high effort', glyph: '✻', dots: '…' }),
      '💭 ✻ **Thinking with high effort…**',
    )
  })

  it('header + brain line + snippet when thinking is live', () => {
    const out = composeThinkingCard({
      label: 'Thinking with high effort',
      glyph: '✢',
      dots: '..',
      thinking: 'Step one done.\nWeighing the margin math',
      snippet: '\n> Step one done. Weighing…',
    })
    assert.equal(
      out,
      '💭 ✢ **Thinking with high effort..**\n> 🧠 *weighing the margin math*\n> Step one done. Weighing…',
    )
  })
})
