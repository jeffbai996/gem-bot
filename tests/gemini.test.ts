import { describe, test } from 'bun:test'
import assert from 'node:assert/strict'
import { parseResponse, extractModelText } from '../src/gemini.ts'

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
})
