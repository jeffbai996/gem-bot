import { describe, test } from 'bun:test'
import assert from 'node:assert/strict'
import { parseResponse } from '../src/gemini.ts'

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
})
