import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildAgyArgs,
  buildAgyPrompt,
  agyWatchdogPolicy,
  normalizeAgyThinkingChunk,
  parseAgyTrajectoryText,
  agySpawnEnv,
} from '../src/agy-chat.ts'

describe('agy media bridge', () => {
  test('tells agy to inspect local Discord attachments with view_file', () => {
    const prompt = buildAgyPrompt({
      systemPrompt: 'You are Gemma.',
      history: [],
      userMessageText: 'what happens in this?',
      userName: 'Alice',
      mediaFiles: [{
        path: '/tmp/gem/inbox/message-1/0-clip.mp4',
        name: 'clip.mp4',
        mimeType: 'video/mp4',
      }],
    })

    assert.match(prompt, /Discord attachments/)
    assert.match(prompt, /view_file/)
    assert.match(prompt, /0-clip\.mp4/)
    assert.match(prompt, /video\/mp4/)
  })

  test('grants every attachment directory before the prompt positional', () => {
    const args = buildAgyArgs(['/tmp/gem/inbox/message-1', '/tmp/gem/inbox/message-1'])
    const promptIndex = args.indexOf('-p')
    const granted = args
      .map((arg, index) => arg === '--add-dir' ? args[index + 1] : null)
      .filter(Boolean)

    assert.ok(promptIndex > 0)
    assert.equal(granted.length, 2)
    assert.match(granted[0] ?? '', /\/\.local\/bin$/)
    assert.equal(granted[1], '/tmp/gem/inbox/message-1')
    assert.ok(args.indexOf('/tmp/gem/inbox/message-1') < promptIndex)
  })
})

describe('normalizeAgyThinkingChunk', () => {
  test('keeps headings attached to their body and strips leaked blockquote markers', () => {
    const input = `Analyzing bot response behavior
>
I'm thinking that the code path could lead to it appearing dead.

Formulating a response

Since the user asked "why is that," I want to provide a thoughtful answer.`

    assert.equal(
      normalizeAgyThinkingChunk(input),
      `Analyzing bot response behavior
I'm thinking that the code path could lead to it appearing dead.
Formulating a response
Since the user asked "why is that," I want to provide a thoughtful answer.`,
    )
  })
})

describe('agyWatchdogPolicy', () => {
  test('uses an idle watchdog plus a longer hard runaway fuse', () => {
    const origIdle = process.env.GEMMA_AGY_IDLE_TIMEOUT_MS
    const origHard = process.env.GEMMA_AGY_CHAT_TIMEOUT_MS
    const origPrint = process.env.GEMMA_AGY_PRINT_TIMEOUT_MS

    delete process.env.GEMMA_AGY_IDLE_TIMEOUT_MS
    delete process.env.GEMMA_AGY_CHAT_TIMEOUT_MS
    delete process.env.GEMMA_AGY_PRINT_TIMEOUT_MS

    try {
      assert.deepEqual(agyWatchdogPolicy(), {
        idleTimeoutMs: 600_000,
        hardTimeoutMs: 2_700_000,
        printTimeoutMs: 2_700_000,
      })
    } finally {
      if (origIdle !== undefined) process.env.GEMMA_AGY_IDLE_TIMEOUT_MS = origIdle
      else delete process.env.GEMMA_AGY_IDLE_TIMEOUT_MS
      if (origHard !== undefined) process.env.GEMMA_AGY_CHAT_TIMEOUT_MS = origHard
      else delete process.env.GEMMA_AGY_CHAT_TIMEOUT_MS
      if (origPrint !== undefined) process.env.GEMMA_AGY_PRINT_TIMEOUT_MS = origPrint
      else delete process.env.GEMMA_AGY_PRINT_TIMEOUT_MS
    }
  })
})

describe('parseAgyTrajectoryText live narration', () => {
  test('keeps the final thought history but exposes only the latest live snapshot', () => {
    const rows = [
      {
        step_index: 2,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        content: 'I will inspect the repository.',
        tool_calls: [{ name: 'list_dir', args: { DirectoryPath: '/workspace' } }],
      },
      {
        step_index: 5,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        thinking: '**Finding the real path**\nThe service points at a different checkout.',
        content: 'I will inspect the service checkout.',
        tool_calls: [{ name: 'view_file', args: { AbsolutePath: '/workspace/service.ts' } }],
      },
      {
        step_index: 8,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        content: 'The service was using the stale checkout.',
        tool_calls: [],
      },
    ]
    const parsed = parseAgyTrajectoryText(rows.map(row => JSON.stringify(row)).join('\n'))

    assert.match(parsed.thinking ?? '', /I will inspect the repository/)
    assert.match(parsed.thinking ?? '', /Finding the real path/)
    assert.equal(parsed.liveThinking, '**Finding the real path**\nThe service points at a different checkout.')
    assert.equal(parsed.liveProgress, 'I will inspect the service checkout.')
    assert.equal(parsed.answer, 'The service was using the stale checkout.')
  })

  test('keeps the latest Antigravity heading available for the compact live card', () => {
    const parsed = parseAgyTrajectoryText([
      {
        step_index: 2,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        thinking: '**Checking System Guidelines**\n\nI am reviewing a long block of internal setup details.',
        content: 'I will inspect the repository.',
        tool_calls: [{ name: 'list_dir', args: { DirectoryPath: '/workspace' } }],
      },
      {
        step_index: 5,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        thinking: '**Inspecting The Renderer**\n\nI am now carefully reviewing a verbose paragraph about the renderer.',
        content: 'I will inspect the live renderer.',
        tool_calls: [{ name: 'view_file', args: { AbsolutePath: '/workspace/live.ts' } }],
      },
    ].map(row => JSON.stringify(row)).join('\n'))

    assert.equal(
      parsed.liveThinking,
      '**Inspecting The Renderer**\nI am now carefully reviewing a verbose paragraph about the renderer.',
    )
  })

  test('treats a current tool-bearing last step as live progress, not a final answer', () => {
    const parsed = parseAgyTrajectoryText(JSON.stringify({
      step_index: 2,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      content: 'I will search the command implementation.',
      tool_calls: [{ name: 'grep_search', args: { Query: 'limits' } }],
    }))

    assert.equal(parsed.liveProgress, 'I will search the command implementation.')
  })
})

describe('agy spawn env hygiene', () => {
  test('agy never inherits gemma’s discord token or gemini key', () => {
    // Regression: dotenv puts both into process.env, spawn copied the lot, and
    // agy logged its environment into ~/.gemini/.../brain/ -- 27 plaintext files
    // (Jeff 2026-07-27). agy authenticates off the flat subscription and needs
    // neither, so they must never reach the child.
    process.env.DISCORD_BOT_TOKEN = 'tok123'
    process.env.GEMINI_API_KEY = 'AQ.secret'
    const env = agySpawnEnv({ SQUAD_STORE_URL: 'http://127.0.0.1:5005' })
    assert.equal(env.DISCORD_BOT_TOKEN, undefined)
    assert.equal(env.GEMINI_API_KEY, undefined)
    // ...while everything agy genuinely needs still gets through.
    assert.equal(env.SQUAD_STORE_URL, 'http://127.0.0.1:5005')
    assert.equal(env.PATH, process.env.PATH)
  })

  test('stripping secrets does not mutate gemma’s own environment', () => {
    // The bot still needs its token to stay on Discord -- delete from the COPY.
    process.env.DISCORD_BOT_TOKEN = 'tok123'
    agySpawnEnv()
    assert.equal(process.env.DISCORD_BOT_TOKEN, 'tok123')
  })
})
