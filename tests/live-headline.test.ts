import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  latestThinkingHeadline,
  compactLiveDetail,
  brainLine,
  composeLiveThinkingCard,
  composeThinkingCard,
  thinkingTraceLines,
} from '../src/live-headline.js'

describe('latestThinkingHeadline', () => {
  it('returns the last non-empty line', () => {
    const text = 'First I looked at the repo.\n\nNow checking the margin math.'
    assert.equal(latestThinkingHeadline(text), 'Now checking the margin math.')
  })

  it('prefers the latest explicit thought heading over its verbose body', () => {
    const text = [
      '**Checking System Guidelines**',
      '',
      'I am currently reviewing every instruction and persona detail before continuing.',
      '',
      '**Inspecting The Renderer**',
      '',
      'I am now carefully investigating how each Discord edit is constructed and dispatched.',
    ].join('\n')
    assert.equal(latestThinkingHeadline(text), 'Inspecting The Renderer')
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

describe('compactLiveDetail', () => {
  it('keeps only the first line of multi-line action narration', () => {
    assert.equal(
      compactLiveDetail('I will inspect the renderer.\nThen I will inspect the service.\nThen I will restart it.'),
      'I will inspect the renderer.',
    )
  })

  it('clips a long action line on a word boundary', () => {
    const out = compactLiveDetail('I will inspect ' + 'every relevant file '.repeat(20))
    assert.ok(out.length <= 161)
    assert.ok(out.endsWith('…'))
    assert.ok(!out.endsWith('fil…'))
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

  it('renders one current brain line plus only the latest action narration', () => {
    const out = composeThinkingCard({
      label: 'Thinking with high effort',
      glyph: '✢',
      dots: '..',
      thinking: 'Step one done.\nWeighing the margin math',
      detail: 'Checking the live renderer.',
    })
    assert.equal(
      out,
      '💭 ✢ **Thinking with high effort..**\n> 🧠 *weighing the margin math*\nChecking the live renderer.',
    )
  })

  it('does not render the cumulative reasoning body', () => {
    const out = composeThinkingCard({
      label: 'Thinking',
      thinking: 'Old reasoning wall.\nLatest useful headline',
    })
    assert.match(out, /latest useful headline/)
    assert.doesNotMatch(out, /Old reasoning wall/)
  })

  it('keeps verbose multi-line action narration to one compact line', () => {
    const out = composeThinkingCard({
      label: 'Thinking',
      thinking: '**Inspecting the renderer**\nI am reviewing every implementation detail.',
      detail: 'I will inspect the current edit owner.\nI will inspect the queue next.',
    })
    assert.equal(
      out,
      '💭 ✻ **Thinking…**\n> 🧠 *inspecting the renderer*\nI will inspect the current edit owner.',
    )
  })

  it('renders the full accumulated reasoning trace in collapse mode', () => {
    const out = composeThinkingCard({
      label: 'Thinking',
      reasoningTrace: [
        'Checking the first failure mode',
        'Comparing the second failure mode\nFixing the actual edit owner',
      ],
    })
    assert.equal(
      out,
      [
        '💭 ✻ **Thinking…**',
        '> 🧠 *checking the first failure mode*',
        '> 🧠 *comparing the second failure mode*',
        '> 🧠 *fixing the actual edit owner*',
      ].join('\n'),
    )
  })
})

describe('thinkingTraceLines', () => {
  it('cleans every non-empty line without collapsing to the latest headline', () => {
    assert.deepEqual(
      thinkingTraceLines(['> First pass\n\n## Second pass', '🧠 Third pass']),
      ['First pass', 'Second pass', 'Third pass'],
    )
  })
})

describe('composeLiveThinkingCard', () => {
  it('finishes with only the latest Antigravity heading, not its accumulated wall', () => {
    const out = composeLiveThinkingCard(42, [
      '**Checking System Guidelines**',
      'I am reviewing every instruction in a long internal paragraph.',
      '**Fixing The Renderer**',
      'I am now reasoning through every implementation detail at length.',
    ].join('\n'))
    assert.equal(
      out,
      '💭 **Thought for 42s**\n> 🧠 *fixing the renderer*',
    )
    assert.doesNotMatch(out, /every instruction|implementation detail/)
  })
})
