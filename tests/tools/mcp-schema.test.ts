import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { SchemaType } from '@google/generative-ai'
import { mcpSchemaToGemini } from '../../src/tools/mcp-schema.ts'

describe('mcpSchemaToGemini', () => {
  test('string primitive', () => {
    assert.deepEqual(
      mcpSchemaToGemini({ type: 'string' }),
      { type: SchemaType.STRING }
    )
  })

  test('integer → NUMBER (Gemini has no INTEGER)', () => {
    assert.deepEqual(
      mcpSchemaToGemini({ type: 'integer' }),
      { type: SchemaType.NUMBER }
    )
  })

  test('number and boolean primitives', () => {
    assert.deepEqual(mcpSchemaToGemini({ type: 'number' }), { type: SchemaType.NUMBER })
    assert.deepEqual(mcpSchemaToGemini({ type: 'boolean' }), { type: SchemaType.BOOLEAN })
  })

  test('array of strings', () => {
    assert.deepEqual(
      mcpSchemaToGemini({ type: 'array', items: { type: 'string' } }),
      { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } }
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
      type: SchemaType.OBJECT,
      properties: {
        symbol: { type: SchemaType.STRING, description: 'ticker' },
        qty: { type: SchemaType.NUMBER }
      },
      required: ['symbol']
    })
  })

  test('enum preserved on string', () => {
    const out = mcpSchemaToGemini({ type: 'string', enum: ['a', 'b', 'c'] })
    assert.deepEqual(out, { type: SchemaType.STRING, enum: ['a', 'b', 'c'] })
  })

  test('description preserved', () => {
    assert.deepEqual(
      mcpSchemaToGemini({ type: 'string', description: 'x' }),
      { type: SchemaType.STRING, description: 'x' }
    )
  })

  test('nullable union stripped to non-null type', () => {
    assert.deepEqual(
      mcpSchemaToGemini({ type: ['string', 'null'] }),
      { type: SchemaType.STRING }
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
      { type: SchemaType.OBJECT, properties: {}, required: [] }
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
      type: SchemaType.OBJECT,
      properties: { good: { type: SchemaType.STRING } },
      required: []
    })
  })
})
