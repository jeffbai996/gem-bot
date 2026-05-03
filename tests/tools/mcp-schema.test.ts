import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { Type } from '@google/genai'
import { mcpSchemaToGemini } from '../../src/tools/mcp-schema.ts'

describe('mcpSchemaToGemini', () => {
  test('string primitive', () => {
    assert.deepEqual(
      mcpSchemaToGemini({ type: 'string' }),
      { type: Type.STRING }
    )
  })

  test('integer → NUMBER (Gemini has no INTEGER)', () => {
    assert.deepEqual(
      mcpSchemaToGemini({ type: 'integer' }),
      { type: Type.NUMBER }
    )
  })

  test('number and boolean primitives', () => {
    assert.deepEqual(mcpSchemaToGemini({ type: 'number' }), { type: Type.NUMBER })
    assert.deepEqual(mcpSchemaToGemini({ type: 'boolean' }), { type: Type.BOOLEAN })
  })

  test('array of strings', () => {
    assert.deepEqual(
      mcpSchemaToGemini({ type: 'array', items: { type: 'string' } }),
      { type: Type.ARRAY, items: { type: Type.STRING } }
    )
  })

  test('object with properties and required', () => {
    const out = mcpSchemaToGemini({
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'ticker' },
        qty: { type: 'integer' }
      },
      required: ['symbol']
    })
    assert.deepEqual(out, {
      type: Type.OBJECT,
      properties: {
        symbol: { type: Type.STRING, description: 'ticker' },
        qty: { type: Type.NUMBER }
      },
      required: ['symbol']
    })
  })

  test('enum preserved on string', () => {
    const out = mcpSchemaToGemini({ type: 'string', enum: ['a', 'b', 'c'] })
    assert.deepEqual(out, { type: Type.STRING, enum: ['a', 'b', 'c'] })
  })

  test('description preserved', () => {
    assert.deepEqual(
      mcpSchemaToGemini({ type: 'string', description: 'x' }),
      { type: Type.STRING, description: 'x' }
    )
  })

  test('nullable union stripped to non-null type', () => {
    assert.deepEqual(
      mcpSchemaToGemini({ type: ['string', 'null'] }),
      { type: Type.STRING }
    )
  })

  test('anyOf returns null', () => {
    assert.equal(
      mcpSchemaToGemini({ anyOf: [{ type: 'string' }, { type: 'number' }] }),
      null
    )
  })

  test('oneOf returns null', () => {
    assert.equal(
      mcpSchemaToGemini({ oneOf: [{ type: 'string' }, { type: 'number' }] }),
      null
    )
  })

  test('missing type returns null', () => {
    assert.equal(mcpSchemaToGemini({ description: 'no type' }), null)
  })

  test('empty object schema → OBJECT with empty properties', () => {
    assert.deepEqual(
      mcpSchemaToGemini({ type: 'object' }),
      { type: Type.OBJECT, properties: {}, required: [] }
    )
  })

  test('object with unrepresentable property skips that property', () => {
    const out = mcpSchemaToGemini({
      type: 'object',
      properties: {
        good: { type: 'string' },
        bad: { anyOf: [{ type: 'string' }, { type: 'number' }] }
      }
    })
    assert.deepEqual(out, {
      type: Type.OBJECT,
      properties: { good: { type: Type.STRING } },
      required: []
    })
  })
})
