import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeAgyThinkingChunk } from '../src/agy-chat.ts'

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
