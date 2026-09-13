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

  it('keeps a fenced block closed and reopened across every chunk', () => {
    const text = `\`\`\`diff\n${Array.from({ length: 30 }, (_, i) => `+ row ${i}`).join('\n')}\n\`\`\``
    const result = chunk(text, 80)

    assert.ok(result.length >= 4)
    for (const piece of result) {
      assert.ok(piece.length <= 80)
      assert.match(piece, /^```diff\n/)
      assert.match(piece, /\n```$/)
    }
  })
})

describe('quoted paragraph pagination', () => {
  it('retains the quote prefix on every continuation without losing text', () => {
    const body = 'A sample explanation with several words. '.repeat(200)
    const result = chunk(`> ${body}`, 2000)
    assert.ok(result.length >= 4)
    for (const page of result) {
      assert.ok(page.length <= 2000)
      assert.match(page, /^> /)
    }
    assert.equal(result.map(page => page.slice(2)).join(''), body)
  })

  it('preserves nested quotes but does not quote the following answer', () => {
    const body = 'Nested explanation. '.repeat(100)
    const result = chunk(`> > ${body}\n\nFinal answer.`, 400)
    assert.ok(result.slice(1).every(page => page.startsWith('> > ') || page.startsWith('Final answer.')))
    assert.ok(result.every(page => page.length <= 400))
    assert.ok(result.join('\n').endsWith('\n\nFinal answer.'))
    assert.doesNotMatch(result.join('\n'), /> Final answer/)
  })

  it('leaves quote-looking lines inside code fences unchanged', () => {
    const body = `> ${'literal shell output '.repeat(100)}`
    const result = chunk(`\`\`\`text\n${body}\n\`\`\``, 400)
    const restored = result.map(page => page.replace(/^```text\n/, '').replace(/\n```$/, '')).join('')
    assert.equal(restored, body)
  })
})
