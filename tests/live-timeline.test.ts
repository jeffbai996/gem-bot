import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { LiveTimelineBuffer, visibleTimelineSteps, describeToolAction } from '../src/live-timeline.ts'

describe('LiveTimelineBuffer', () => {
  it('retains completed edit diffs in the live timeline', () => {
    const timeline = new LiveTimelineBuffer()
    timeline.startTool('edit_file', { path: 'example.ts' })
    timeline.finishTool('edit_file', { failed: false, diff: '+new line' })
    assert.equal(timeline.snapshot()[0].diff, '+new line')
  })
  it('preserves shell targets for both AGY display names and native arguments', () => {
    assert.equal(describeToolAction('Bash(ls -la)').detail, 'ls -la')
    assert.equal(describeToolAction('run_command', { CommandLine: 'ls -la' }).detail, 'ls -la')
    assert.equal(describeToolAction('exec_command', { cmd: 'pwd' }).detail, 'pwd')
  })
  it('builds one chronological API timeline from thought and tool events', () => {
    const timeline = new LiveTimelineBuffer()

    timeline.pushThought('**Checking squad context**')
    timeline.pushThought('\nThe stored facts should settle this.')
    timeline.startTool('search_squad_memory', { query: 'current project' })
    timeline.finishTool('search_squad_memory', {
      durationMs: 842,
      resultPreview: 'Found 3 memories',
      failed: false,
    })
    timeline.pushThought('**Synthesizing the result**\nI have enough evidence now.')

    assert.deepEqual(timeline.snapshot(), [
      {
        kind: 'thinking',
        text: '**Checking squad context**\nThe stored facts should settle this.',
      },
      {
        kind: 'action',
        text: 'Search',
        detail: 'current project',
        status: 'done',
        durationMs: 842,
      },
      {
        kind: 'thinking',
        text: '**Synthesizing the result**\nI have enough evidence now.',
      },
    ])
  })

  it('preserves spaces split across streamed thought chunks', () => {
    const timeline = new LiveTimelineBuffer()
    timeline.pushThought('**Checking the ')
    timeline.pushThought('renderer**\nThe event stream ')
    timeline.pushThought('is complete.')

    assert.equal(
      timeline.snapshot()[0]?.text,
      '**Checking the renderer**\nThe event stream is complete.',
    )
  })

  it('shows running and failed tools without leaking their result bodies', () => {
    const timeline = new LiveTimelineBuffer()
    timeline.startTool('fetch_url', { url: 'https://example.com/a/very/long/path' })
    assert.deepEqual(timeline.snapshot()[0], {
      kind: 'action',
      text: 'Browse',
      detail: 'example.com/a/very/long/path',
      status: 'running',
    })

    timeline.finishTool('fetch_url', {
      durationMs: 6_200,
      resultPreview: 'PRIVATE RESPONSE BODY MUST NOT ENTER THE TIMELINE',
      failed: true,
    })
    assert.deepEqual(timeline.snapshot()[0], {
      kind: 'action',
      text: 'Browse',
      detail: 'example.com/a/very/long/path',
      status: 'failed',
      durationMs: 6_200,
    })
  })

  it('replaces the API timeline with the authoritative Agy trajectory', () => {
    const timeline = new LiveTimelineBuffer()
    timeline.pushThought('temporary API fallback thought')
    timeline.replace([
      { kind: 'thinking', text: '**Inspecting the renderer**' },
      { kind: 'action', text: 'Read', detail: 'gemma.ts' },
    ])

    assert.deepEqual(timeline.snapshot(), [
      { kind: 'thinking', text: '**Inspecting the renderer**' },
      { kind: 'action', text: 'Read', detail: 'gemma.ts' },
    ])
  })

  it('matches wrapped MCP tool completion to its running row', () => {
    const timeline = new LiveTimelineBuffer()
    const args = {
      ToolName: 'search',
      Arguments: { params: { query: 'operator traces' } },
    }
    timeline.startTool('call_mcp_tool', args)
    timeline.finishTool('call_mcp_tool', { failed: false, durationMs: 120 }, args)

    assert.deepEqual(timeline.snapshot(), [{
      kind: 'action',
      text: 'Search',
      detail: 'operator traces',
      status: 'done',
      durationMs: 120,
    }])
  })

  it('honors trace off by keeping actions out of the thinking card', () => {
    const steps = [
      { kind: 'thinking' as const, text: '**Planning the answer**' },
      { kind: 'action' as const, text: 'Search', detail: 'private query', status: 'done' as const },
    ]

    assert.deepEqual(visibleTimelineSteps(steps, 'off'), [steps[0]])
    assert.deepEqual(visibleTimelineSteps(steps, 'collapse'), steps)
  })
})
