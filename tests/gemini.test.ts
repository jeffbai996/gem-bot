import { describe, test } from "node:test"
import assert from 'node:assert/strict'
import {
  parseResponse,
  extractModelText,
  extractGroundingSources,
  extractCodeArtifacts,
  extractUsage,
  extractFlaggedSafety,
  formatSystemPrompt
} from '../src/gemini.ts'

describe('extractModelText', () => {
  test('returns empty string for undefined parts', () => {
    assert.equal(extractModelText(undefined), '')
  })

  test('joins plain text parts', () => {
    assert.equal(
      extractModelText([{ text: 'hello' }, { text: 'world' }]),
      'hello\nworld'
    )
  })

  // Code execution parts share the same Part union type but carry the code
  // in `executableCode` or output in `codeExecutionResult`. The SDK sets
  // text="" on those parts. We must drop anything with those fields set,
  // even if text is also somehow present, because that text would be the
  // code-exec output and would break our JSON parsing downstream.
  test('drops executableCode parts', () => {
    const parts = [
      { executableCode: { language: 'PYTHON', code: 'print(1)' } } as any,
      { text: '{"reply":"real answer"}' }
    ]
    assert.equal(extractModelText(parts), '{"reply":"real answer"}')
  })

  test('drops codeExecutionResult parts', () => {
    const parts = [
      { codeExecutionResult: { outcome: 'OK', output: '1\n' } } as any,
      { text: '{"reply":"real answer"}' }
    ]
    assert.equal(extractModelText(parts), '{"reply":"real answer"}')
  })

  test('drops functionCall parts', () => {
    const parts = [
      { functionCall: { name: 'search', args: {} } } as any,
      { text: 'final text' }
    ]
    assert.equal(extractModelText(parts), 'final text')
  })
})

describe('parseResponse', () => {
  test('parses both fields', () => {
    const r = parseResponse('{"react":"🦆","reply":"hello"}')
    assert.equal(r.react, '🦆')
    assert.equal(r.reply, 'hello')
  })

  test('parses reply-only', () => {
    const r = parseResponse('{"react":null,"reply":"text"}')
    assert.equal(r.react, null)
    assert.equal(r.reply, 'text')
  })

  test('parses react-only', () => {
    const r = parseResponse('{"react":"👍","reply":null}')
    assert.equal(r.react, '👍')
    assert.equal(r.reply, null)
  })

  test('falls back to reply for malformed JSON', () => {
    const r = parseResponse('not json at all')
    assert.equal(r.react, null)
    assert.equal(r.reply, 'not json at all')
  })

  test('treats empty strings as null', () => {
    const r = parseResponse('{"react":"","reply":""}')
    assert.equal(r.react, null)
    assert.equal(r.reply, null)
  })

  test('ignores extra fields', () => {
    const r = parseResponse('{"react":"✅","reply":"ok","extra":"ignored"}')
    assert.equal(r.react, '✅')
    assert.equal(r.reply, 'ok')
  })

  test('parses thinking field', () => {
    const r = parseResponse('{"react":null,"thinking":"pondering","reply":"done"}')
    assert.equal(r.thinking, 'pondering')
    assert.equal(r.reply, 'done')
  })

  // With tools enabled, Gemini cannot be forced into strict JSON output.
  // It often wraps the JSON in a ```json ... ``` fence. Strip the fence.
  test('strips ```json fences', () => {
    const r = parseResponse('```json\n{"react":"👍","reply":"hi"}\n```')
    assert.equal(r.react, '👍')
    assert.equal(r.reply, 'hi')
  })

  test('strips bare ``` fences', () => {
    const r = parseResponse('```\n{"react":null,"reply":"hi"}\n```')
    assert.equal(r.reply, 'hi')
  })

  // Sometimes Gemini prepends preamble text before the JSON object.
  // Extract the last top-level {...} block and parse that.
  test('extracts JSON object from preamble', () => {
    const r = parseResponse('Here is the response:\n{"react":null,"reply":"actual reply"}')
    assert.equal(r.reply, 'actual reply')
  })

  // If truly no JSON can be extracted, fall back to plain-text reply.
  test('falls back when no JSON object is found', () => {
    const r = parseResponse('just plain text with no braces')
    assert.equal(r.reply, 'just plain text with no braces')
    assert.equal(r.react, null)
    assert.equal(r.thinking, null)
  })

  // The actual bug from Apr 19 2026: code-execution output leaked
  // alongside truncated JSON. Before the fix this dumped the whole mess
  // as the reply. After the fix, we extract only the JSON block.
  test('recovers from code-execution leakage', () => {
    const leaked = 'data = [(1, 2), (3, 4)]\ntotal = sum(a + b for a, b in data)\nprint(total)\n\n{"react":null,"thinking":"summed boxes","reply":"Net gain $342,565"}'
    const r = parseResponse(leaked)
    assert.equal(r.reply, 'Net gain $342,565')
    assert.equal(r.thinking, 'summed boxes')
  })

  describe('isPartial mode (Streaming)', () => {
    test('extracts fields from truncated JSON string', () => {
      const truncated = '{"react":null,"thinking":"I am pondering this deeply","re'
      const r = parseResponse(truncated, true)
      assert.equal(r.react, null)
      assert.equal(r.thinking, 'I am pondering this deeply')
      assert.equal(r.reply, null)
    })

    test('extracts incomplete field value at the end of the stream', () => {
      const truncated = '{"react":null,"thinking":"I am ponder'
      const r = parseResponse(truncated, true)
      assert.equal(r.thinking, 'I am ponder')
      assert.equal(r.reply, null)
    })

    test('extracts multiple fields from truncated JSON', () => {
      const truncated = '{"react":"👍","thinking":"done thinking","reply":"here is the an'
      const r = parseResponse(truncated, true)
      assert.equal(r.react, '👍')
      assert.equal(r.thinking, 'done thinking')
      assert.equal(r.reply, 'here is the an')
    })
    
    test('gracefully ignores broken trailing quotes', () => {
      const truncated = '{"react":null,"thinking":"I am ponder"'
      const r = parseResponse(truncated, true)
      assert.equal(r.thinking, 'I am ponder')
    })
  })
})

describe('formatSystemPrompt', () => {
  test('auto mode appends only the base format instruction', () => {
    const out = formatSystemPrompt('You are a bot.', 'auto')
    assert.match(out, /You are a bot\./)
    assert.match(out, /Response format \(mandatory\)/)
    assert.doesNotMatch(out, /Thinking override/)
  })

  test('always mode adds the ALWAYS addendum', () => {
    const out = formatSystemPrompt('persona', 'always')
    assert.match(out, /Thinking override — THIS CHANNEL/)
    assert.match(out, /forced to ALWAYS/)
  })

  test('never mode adds the NEVER addendum', () => {
    const out = formatSystemPrompt('persona', 'never')
    assert.match(out, /Thinking override — THIS CHANNEL/)
    assert.match(out, /forced to NEVER/)
  })
})

describe('extractGroundingSources', () => {
  test('returns [] for candidate without grounding metadata', () => {
    assert.deepEqual(extractGroundingSources({}), [])
    assert.deepEqual(extractGroundingSources({ groundingMetadata: {} }), [])
  })

  test('extracts web sources with title + uri', () => {
    const candidate = {
      groundingMetadata: {
        groundingChunks: [
          { web: { uri: 'https://a.com', title: 'Site A' } },
          { web: { uri: 'https://b.com', title: 'Site B' } }
        ]
      }
    }
    const out = extractGroundingSources(candidate)
    assert.equal(out.length, 2)
    assert.deepEqual(out[0], { uri: 'https://a.com', title: 'Site A' })
  })

  test('dedupes by URI', () => {
    const candidate = {
      groundingMetadata: {
        groundingChunks: [
          { web: { uri: 'https://a.com', title: 'Site A' } },
          { web: { uri: 'https://a.com', title: 'Site A (dup)' } },
          { web: { uri: 'https://b.com', title: 'Site B' } }
        ]
      }
    }
    assert.equal(extractGroundingSources(candidate).length, 2)
  })

  test('skips chunks with no uri', () => {
    const candidate = {
      groundingMetadata: {
        groundingChunks: [
          { web: { title: 'No URI' } },
          { web: { uri: 'https://a.com', title: 'Site A' } }
        ]
      }
    }
    assert.equal(extractGroundingSources(candidate).length, 1)
  })

  test('falls back title to uri when title missing', () => {
    const candidate = {
      groundingMetadata: {
        groundingChunks: [{ web: { uri: 'https://a.com' } }]
      }
    }
    assert.equal(extractGroundingSources(candidate)[0].title, 'https://a.com')
  })
})

describe('extractCodeArtifacts', () => {
  test('returns [] for empty parts', () => {
    assert.deepEqual(extractCodeArtifacts(undefined), [])
    assert.deepEqual(extractCodeArtifacts([]), [])
  })

  test('pairs executableCode with following codeExecutionResult', () => {
    const parts = [
      { text: 'let me compute' },
      { executableCode: { language: 'PYTHON', code: 'print(2+2)' } },
      { codeExecutionResult: { outcome: 'OUTCOME_OK', output: '4\n' } },
      { text: '{"reply":"4"}' }
    ]
    const arts = extractCodeArtifacts(parts)
    assert.equal(arts.length, 1)
    assert.equal(arts[0].code, 'print(2+2)')
    assert.equal(arts[0].output, '4\n')
    assert.equal(arts[0].outcome, 'OUTCOME_OK')
    assert.equal(arts[0].language, 'python')
  })

  test('emits executableCode with null output when no result follows', () => {
    const parts = [
      { executableCode: { language: 'PYTHON', code: 'x = 1' } }
    ]
    const arts = extractCodeArtifacts(parts)
    assert.equal(arts.length, 1)
    assert.equal(arts[0].output, null)
  })

  test('handles multiple code executions in one response', () => {
    const parts = [
      { executableCode: { language: 'PYTHON', code: 'print(1)' } },
      { codeExecutionResult: { outcome: 'OUTCOME_OK', output: '1\n' } },
      { executableCode: { language: 'PYTHON', code: 'print(2)' } },
      { codeExecutionResult: { outcome: 'OUTCOME_OK', output: '2\n' } }
    ]
    const arts = extractCodeArtifacts(parts)
    assert.equal(arts.length, 2)
    assert.equal(arts[0].output, '1\n')
    assert.equal(arts[1].output, '2\n')
  })
})

describe('extractUsage', () => {
  test('returns null when usageMetadata missing', () => {
    assert.equal(extractUsage({}), null)
    assert.equal(extractUsage({ usageMetadata: null }), null)
  })

  test('extracts token counts', () => {
    const u = extractUsage({
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 200, totalTokenCount: 300 }
    })
    assert.deepEqual(u, { promptTokens: 100, responseTokens: 200, totalTokens: 300 })
  })
})

describe('extractFlaggedSafety', () => {
  test('returns [] when no ratings', () => {
    assert.deepEqual(extractFlaggedSafety({}), [])
  })

  test('drops NEGLIGIBLE and LOW', () => {
    const candidate = {
      safetyRatings: [
        { category: 'HARM_CATEGORY_HARASSMENT', probability: 'NEGLIGIBLE' },
        { category: 'HARM_CATEGORY_HATE_SPEECH', probability: 'LOW' }
      ]
    }
    assert.deepEqual(extractFlaggedSafety(candidate), [])
  })

  test('keeps MEDIUM and HIGH', () => {
    const candidate = {
      safetyRatings: [
        { category: 'HARM_CATEGORY_HARASSMENT', probability: 'MEDIUM' },
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', probability: 'HIGH' },
        { category: 'HARM_CATEGORY_HATE_SPEECH', probability: 'LOW' }
      ]
    }
    const out = extractFlaggedSafety(candidate)
    assert.equal(out.length, 2)
    assert.equal(out[0].probability, 'MEDIUM')
    assert.equal(out[1].probability, 'HIGH')
  })
})
