import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { displayWidth } from '../src/tool-trace.ts'
import {
  latestThinkingHeadline,
  compactLiveDetail,
  brainLine,
  composeLiveThinkingCard,
  composeThinkingCard,
  composeTrajectoryTimelineCard,
  thinkingTraceLines,
  assertUniformEmojiWidth,
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

  it('preserves every narration update in collapse mode', () => {
    const out = composeThinkingCard({
      label: 'Thinking',
      narrationTrace: ['Checking the renderer.', 'Testing the service.'],
    })
    assert.equal(out, [
      '💭 ✻ **Thinking…**',
      'Checking the renderer.',
      '',
      'Testing the service.',
    ].join('\n'))
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
  it('preserves all supplied text on the completed card', () => {
    const out = composeLiveThinkingCard(42, [
      '**Checking System Guidelines**',
      'I am reviewing every instruction in a long internal paragraph.',
      '**Fixing The Renderer**',
      'I am now reasoning through every implementation detail at length.',
    ].join('\n'))
    assert.match(out, /Thought for 42s/)
    assert.match(out, /Checking System Guidelines/)
    assert.match(out, /every instruction/)
    assert.match(out, /implementation detail at length\./)
  })
})

describe('composeTrajectoryTimelineCard', () => {
  it('quotes unheaded prose instead of promoting it to a bold heading', () => {
    const prose = 'Checking the requested settings and their current values.'
    for (const complete of [false, true]) {
      const out = composeTrajectoryTimelineCard({ label: 'Working', complete, steps: [
        { kind: 'thinking', text: prose },
      ] })
      assert.ok(out.includes(`> ${prose}`))
      assert.ok(!out.includes(`**${prose}**`))
    }
  })
  it('quotes the heading so a thought renders in one gray block', () => {
    // A bare **heading** sits at column 0 in Discord's default text colour
    // while its body is grayed inside the quote — the same thought in two
    // visual registers, and a second trace style beside the fully-quoted card.
    for (const complete of [false, true]) {
      const out = composeTrajectoryTimelineCard({ label: 'Working', complete, steps: [
        { kind: 'thinking', text: '**Assessing the request**\nThe query is vague.' },
      ] })
      assert.ok(out.includes('> **Assessing the request**'))
      assert.doesNotMatch(out, /^\*\*Assessing the request\*\*/m)
    }
  })
  it('drops a trailing full stop from the heading but keeps ellipsis and ? !', () => {
    const heading = (text: string) => composeTrajectoryTimelineCard({
      label: 'Working', complete: true, steps: [{ kind: 'thinking', text: `**${text}**\nBody.` }],
    })
    assert.ok(heading('Assessing the information request.').includes('> **Assessing the information request**'))
    assert.ok(heading('Still weighing it...').includes('> **Still weighing it...**'))
    assert.ok(heading('Is the tool available?').includes('> **Is the tool available?**'))
    // Body prose keeps its punctuation — the strip is title-only.
    assert.ok(heading('Assessing the information request.').includes('> Body.'))
  })
  it('retains long completed text and earlier steps for message pagination', () => {
    const body = 'Complete progress detail. '.repeat(150) + 'END-OF-TRACE'
    const out = composeTrajectoryTimelineCard({ label: 'Worked', complete: true, steps: [
      { kind: 'thinking', text: '**First step**\n' + body },
      { kind: 'thinking', text: '**Last step**\nFinished.' },
    ] })
    assert.ok(out.length > 2000)
    assert.match(out, /First step/)
    assert.match(out, /END-OF-TRACE/)
    assert.doesNotMatch(out, /earlier steps omitted/)
  })
  it('renders a numbered edit preview between ordinary tool groups', () => {
    const out = composeTrajectoryTimelineCard({ label: 'Working', steps: [
      { kind: 'action', text: 'Read', detail: 'example.ts' },
      { kind: 'action', text: 'Write', detail: 'example.ts', diff: '@@ -2,2 +2,2 @@\n context\n-old\n+new' },
      { kind: 'action', text: 'Run', detail: 'npm test' },
    ] })
    assert.match(out, /3 steps/)
    assert.match(out, /```diff\n\+ ● Edit\(example.ts\)\n  ⎿ \[\+1, -1\]/)
    assert.match(out, /- 3 old\n\+ 3 new/)
    assert.ok(out.indexOf('Reading') < out.indexOf('Edit(example.ts)'))
    assert.ok(out.indexOf('Edit(example.ts)') < out.indexOf('Running'))
    assert.equal((out.match(/^```/gm) ?? []).length, 6)
  })

  it('bounds a large edit preview and keeps embedded code fences inside it', () => {
    const diff = '@@ -1 +1,100 @@\n-old\n' + Array.from({ length: 100 }, (_, i) => '+line ' + i).join('\n') + '\n+```text'
    const out = composeTrajectoryTimelineCard({ label: 'Working', steps: [
      { kind: 'action', text: 'Write', detail: 'example.ts', diff },
    ] })
    assert.ok(out.length <= 2000)
    assert.match(out, /Edit\(example.ts\)/)
    assert.equal((out.match(/^```/gm) ?? []).length, 2)
  })
  it('aligns all targets to one column, every row carrying its own label', () => {
    const out = composeTrajectoryTimelineCard({ label: 'Working', steps: [
      { kind: 'action', text: 'Run', detail: 'target-a' },
      { kind: 'action', text: 'Run', detail: 'target-b' },
      { kind: 'action', text: 'Read', detail: 'target-c' },
      { kind: 'action', text: 'Search', detail: 'target-d' },
      { kind: 'action', text: 'Write', detail: 'target-e', status: 'failed' },
    ] })
    const rows = out.split('\n').filter(row => row.includes('target-'))
    const columns = rows.map(row => displayWidth(row.slice(0, row.indexOf('target-'))))
    assert.equal(new Set(columns).size, 1)
    assert.equal(rows.length, 5)
    assert.doesNotMatch(out, / · /)
    assert.match(out, /^💻 Running/m)
    // Both Run steps say "Running". The second one used to have its label
    // blanked to mark it as a continuation, which left a bare argument under
    // the first with nothing to say what it was (Jeff 2026-09-10).
    assert.equal((out.match(/Running/g) ?? []).length, 2)
  })
  it('renders ordered reasoning summaries and actions in one live card', () => {
    const out = composeTrajectoryTimelineCard({
      label: 'Working with high effort',
      glyph: '✶',
      dots: '…',
      steps: [
        {
          kind: 'thinking',
          text: '**Inspecting the renderer**\nThe events are already present.',
          detail: 'I will compare the Discord and web renderers.',
        },
        { kind: 'action', text: 'Read', detail: 'live.ts' },
        {
          kind: 'thinking',
          text: '**Fixing the choke point**\nA rolling timeline preserves useful context.',
          detail: 'I will implement the bounded renderer.',
        },
      ],
    })

    assert.match(out, /^💭 ✶ \*\*Working with high effort…\*\*/)
    assert.match(out, /3 steps/)
    assert.match(out, /\*\*Inspecting the renderer\*\*/)
    assert.match(out, /> The events are already present\./)
    assert.match(out, /🔧 \*\*Tool call\*\*\n```text\n📖 Reading + live\.ts\n```/)
    assert.doesNotMatch(out, /• \*\*/)
    assert.ok(out.indexOf('Inspecting the renderer') < out.indexOf('Reading'))
    assert.ok(out.indexOf('Reading') < out.indexOf('Fixing the choke point'))
  })

  it('keeps a rolling tail within Discord limits and reports omitted steps', () => {
    const steps = Array.from({ length: 40 }, (_, index) => ({
      kind: 'thinking' as const,
      text: `**Milestone ${index}**\n${'Detailed public progress. '.repeat(20)}`,
      detail: `Working on stage ${index}.`,
    }))
    const out = composeTrajectoryTimelineCard({ label: 'Working', steps })

    assert.ok(out.length <= 2000)
    assert.match(out, /40 steps/)
    assert.match(out, /earlier steps omitted/)
    assert.doesNotMatch(out, /Milestone 0/)
    assert.match(out, /Milestone 39/)
  })

  it('renders running, completed, and failed actions legibly', () => {
    const out = composeTrajectoryTimelineCard({
      label: 'Worked for 12s',
      glyph: '✓',
      dots: '',
      steps: [
        { kind: 'action', text: 'Read', detail: 'renderer.ts', status: 'running' },
        { kind: 'action', text: 'Search', detail: 'current project', status: 'done', durationMs: 842 },
        { kind: 'action', text: 'Browse', detail: 'example.com', status: 'failed', durationMs: 6_200 },
      ],
    })

    assert.match(out, /^💭 ✓ \*\*Worked for 12s\*\*/)
    assert.match(out, /^📖 Reading… + renderer\.ts/m)
    assert.match(out, /^🌐 Searching + current project$/m)
    assert.match(out, /^❌ Browsing failed + example\.com$/m)
    assert.equal((out.match(/^```/gm) ?? []).length, 2)
  })

  it('labels every consecutive call and starts a new block after thinking', () => {
    const out = composeTrajectoryTimelineCard({ label: 'Working', steps: [
      { kind: 'action', text: 'Read', detail: 'first.ts' },
      { kind: 'action', text: 'Read', detail: 'second.ts' },
      { kind: 'action', text: 'Search', detail: 'query' },
      { kind: 'thinking', text: '**Checking results**' },
      { kind: 'action', text: 'Read', detail: 'third.ts' },
    ] })
    assert.match(out, /📖 Reading + first\.ts\n📖 Reading + second\.ts\n🌐 Searching + query\n```\n> \*\*Checking results\*\*/)
    assert.match(out, /Checking results\*\*\n🔧 \*\*Tool call\*\*\n```text\n📖 Reading + third\.ts/)
    assert.doesNotMatch(out, /\n\n/)
    assert.equal((out.match(/^```/gm) ?? []).length, 4)
  })

  it('keeps a long tool-only run bounded with a labelled first row and closed fence', () => {
    const steps = Array.from({ length: 80 }, (_, index) => ({
      kind: 'action' as const, text: 'Read', detail: `file-${index}.ts ` + 'long-path/'.repeat(15),
    }))
    const out = composeTrajectoryTimelineCard({ label: 'Working', steps })
    assert.ok(out.length <= 1960)
    assert.match(out, /80 steps/)
    assert.match(out, /earlier steps omitted/)
    assert.match(out, /```text\n📖 Reading + file-/)
    assert.match(out, /file-79\.ts/)
    assert.equal((out.match(/^```/gm) ?? []).length, 2)
    assert.ok(out.endsWith('```'))
  })

  it('aligns every target to one column when the labels differ in width', () => {
    const out = composeTrajectoryTimelineCard({ label: 'Working', steps: [
      { kind: 'action', text: 'Read', detail: 'first.ts', status: 'running' },
      { kind: 'action', text: 'Read', detail: 'second.ts', status: 'done' },
      { kind: 'action', text: 'Read', detail: 'third.ts', status: 'done' },
    ] })
    // "Reading…" is wider than "Reading", so the shorter rows take the slack
    // and all three arguments still start in the same column.
    const rows = out.split('\n').filter(row => row.includes('.ts'))
    const columns = rows.map(row => displayWidth(row.slice(0, row.search(/\S+\.ts/))))
    assert.equal(rows.length, 3)
    assert.equal(new Set(columns).size, 1)
    assert.match(out, /^📖 Reading… + first\.ts/m)
  })

  it('keeps tool fences intact with hostile backticks and a rolling mixed tail', () => {
    const steps = Array.from({ length: 40 }, (_, index) => index % 2 === 0
      ? { kind: 'thinking' as const, text: `**Stage ${index}**\nChecking the result.` }
      : { kind: 'action' as const, text: 'Bash', detail: 'echo ```example``` ' + 'argument '.repeat(50) })
    const out = composeTrajectoryTimelineCard({ label: 'Working', steps })
    assert.ok(out.length <= 2000)
    assert.match(out, /40 steps/)
    assert.match(out, /earlier steps omitted/)
    assert.doesNotMatch(out, /• \*\*|```example/)
    assert.equal((out.match(/^```/gm) ?? []).length % 2, 0)
    assert.match(out, /\*\*Stage 38\*\*[\s\S]*\*\*Tool call\*\*\n```text/)
  })
})

describe('trace row emoji', () => {
  it('only uses glyphs that default to emoji presentation', () => {
    // The rows line up because each opens with one glyph of the same rendered
    // width, so whatever Discord gives an emoji cancels out down the block. A
    // text-presentation character wearing U+FE0F (⌨️, ✍️, ⚠️) draws narrower
    // than a native emoji and knocks the whole column out -- which is why the
    // emoji were removed entirely on 2026-09-10 before being picked properly.
    assert.doesNotThrow(assertUniformEmojiWidth)
  })

  it('gives the fallback and the failure a glyph too', () => {
    // A row without one starts two columns left of its neighbours, so there is
    // no "this action has no icon" case.
    const out = composeTrajectoryTimelineCard({ label: 'Working', complete: true, steps: [
      { kind: 'action', text: 'Task', status: 'done' },
      { kind: 'action', text: 'Browse', detail: 'example.com', status: 'failed' },
      { kind: 'action', text: 'Read', detail: 'a.ts', status: 'done' },
    ] })
    const rows = out.split('```text\n')[1].split('\n```')[0].split('\n')
    assert.equal(rows.length, 3)
    for (const row of rows) {
      assert.match(row, /^\p{Emoji_Presentation} /u, row)
    }
  })
})

describe('tool call rows', () => {
  const card = (steps: any[]) => composeTrajectoryTimelineCard({
    label: 'Working', steps, complete: true,
  })

  it('carries no per-row timing at all', () => {
    // Jeff 2026-09-10, on the bracketed duration column shipped hours earlier:
    // "just drop the time like the 1.0s and all that". Per-call timing lives on
    // the 🔧 Tool trace card; this one says what is running, not how long it took.
    const out = card([
      { kind: 'tool', text: 'search', detail: 'gemini flash', durationMs: 235 },
      { kind: 'tool', text: 'run', detail: 'ls -la ~/repos', durationMs: 42_500 },
    ])
    assert.doesNotMatch(out, /235ms|42\.5s|\[/)
  })

  it('gives every row its own action, so none is left as an orphan argument', () => {
    // Two runs in a row used to collapse the second one's label away, leaving a
    // bare command floating under the first (Jeff 2026-09-10: "clusterfucks
    // like this").
    const out = card([
      { kind: 'tool', text: 'run', detail: 'ls -la ~/repos', durationMs: 1000 },
      { kind: 'tool', text: 'run', detail: 'systemctl --user list-units', durationMs: 2000 },
    ])
    const lines = out.split('\n').filter(l => l.includes('systemctl'))
    assert.equal(lines.length, 1)
    assert.match(lines[0], /Running/)
  })

  it('starts every argument in the same column', () => {
    const out = card([
      { kind: 'tool', text: 'search', detail: 'a short one', durationMs: 235 },
      { kind: 'tool', text: 'run', detail: 'a considerably longer argument here', durationMs: 3200 },
    ])
    const at = ['a short one', 'a considerably longer']
      .map(arg => out.split('\n').find(l => l.includes(arg)) ?? '')
      .map(l => displayWidth(l.slice(0, l.indexOf('a '))))
    assert.equal(at.length, 2)
    assert.equal(at[0], at[1])
  })
})
