import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { chunk } from '../src/chunk.js'

describe('Chunking Logic', () => {
  it('should not chunk text under the limit', () => {
    const text = 'Hello world'
    const result = chunk(text, 2000)
    assert.deepEqual(result, ['Hello world'])
  })

  it('should chunk at exact limit', () => {
    const text = 'A'.repeat(2000)
    const result = chunk(text, 2000)
    assert.deepEqual(result, [text])
  })

  it('should chunk longer text with newlines', () => {
    const p1 = 'Paragraph 1\n\n'
    const p2 = 'Paragraph 2\n\n'
    const p3 = 'Paragraph 3'
    const text = p1 + p2 + p3
    
    // limit 20 means it should split after p1
    const result = chunk(text, 20)
    assert.equal(result.length, 3)
    assert.equal(result[0], p1)
    assert.equal(result[1], p2)
    assert.equal(result[2], p3)
  })

  it('should hard cut if no spaces or newlines', () => {
    const text = 'A'.repeat(50)
    const result = chunk(text, 20)
    assert.equal(result.length, 3)
    assert.equal(result[0], 'A'.repeat(20))
    assert.equal(result[1], 'A'.repeat(20))
    assert.equal(result[2], 'A'.repeat(10))
  })
})