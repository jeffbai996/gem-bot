import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { agyWatchdogPolicy, normalizeAgyThinkingChunk } from '../src/agy-chat.ts'

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
