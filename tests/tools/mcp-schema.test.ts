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

  // --- Pydantic nullable union (anyOf: [T, null]) ---
  test('anyOf nullable string unwraps to STRING', () => {
    assert.deepEqual(
      mcpSchemaToGemini({ anyOf: [{ type: 'string' }, { type: 'null' }] }),
      { type: Type.STRING }
    )
  })

  test('anyOf nullable string preserves description', () => {
    assert.deepEqual(
      mcpSchemaToGemini({ anyOf: [{ type: 'string' }, { type: 'null' }], description: 'optional sym' }),
      { type: Type.STRING, description: 'optional sym' }
    )
  })

  test('anyOf nullable object unwraps to OBJECT', () => {
    const out = mcpSchemaToGemini({
      anyOf: [
        { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
        { type: 'null' }
      ]
    })
    assert.deepEqual(out, {
      type: Type.OBJECT,
      properties: { x: { type: Type.STRING } },
      required: ['x']
    })
  })

  // --- $ref resolution (IBKR pattern: params: {$ref: "#/$defs/Foo"}) ---
  test('$ref resolves against $defs at root', () => {
    const schema = {
      $defs: {
        QuoteInput: {
          type: 'object',
          properties: {
            symbols: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'comma-separated' },
            currency: { type: 'string', default: 'USD' }
          },
          required: []
        }
      },
      type: 'object',
      properties: {
        params: { $ref: '#/$defs/QuoteInput' }
      },
      required: ['params']
    }
    const out = mcpSchemaToGemini(schema)
    assert.deepEqual(out, {
      type: Type.OBJECT,
      properties: {
        params: {
          type: Type.OBJECT,
          properties: {
            symbols: { type: Type.STRING, description: 'comma-separated' },
            currency: { type: Type.STRING }
          },
          required: []
        }
      },
      required: ['params']
    })
  })

  test('unknown $ref returns null', () => {
    assert.equal(
      mcpSchemaToGemini({ $ref: '#/$defs/Missing' }),
      null
    )
  })
})
