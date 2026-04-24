import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { selectWithinBudget } from '../src/token-budget.ts'
import type { GeminiContent } from '../src/history.ts'

function msg(text: string): GeminiContent {
  return { role: 'user', parts: [{ text }] }
}

describe('selectWithinBudget', () => {
  test('empty array returns empty array', async () => {
    const out = await selectWithinBudget([], async () => 0, { budget: 1000 })
    assert.deepEqual(out, [])
  })

  test('contents at or below minRetain short-circuits without counting', async () => {
    let calls = 0
    const contents = [msg('a'), msg('b'), msg('c')]
    const out = await selectWithinBudget(contents, async () => { calls++; return 999999 }, { budget: 1, minRetain: 3 })
    assert.deepEqual(out, contents)
    assert.equal(calls, 0)
  })

  test('under budget passes through unchanged', async () => {
    const contents = [msg('a'), msg('b'), msg('c'), msg('d'), msg('e')]
    const out = await selectWithinBudget(contents, async () => 100, { budget: 1000 })
    assert.equal(out.length, 5)
  })

  test('trims oldest when over budget', async () => {
    const contents = [msg('a'), msg('b'), msg('c'), msg('d'), msg('e')]
    const scripted = [1500, 800]
    let i = 0
    const out = await selectWithinBudget(contents, async () => scripted[i++], { budget: 1000 })
    assert.equal(out.length, 4)
    assert.equal((out[0].parts[0] as any).text, 'b')
  })

  test('trims multiple messages until under budget', async () => {
    // 6 messages so floor (3) doesn't short-circuit before budget is met.
    const contents = [msg('a'), msg('b'), msg('c'), msg('d'), msg('e'), msg('f')]
    // Call 1 [a..f]=3000 over, 2 [b..f]=2500 over, 3 [c..f]=800 under -> return [c,d,e,f]
    const scripted = [3000, 2500, 800]
    let i = 0
    const out = await selectWithinBudget(contents, async () => scripted[i++], { budget: 1000 })
    assert.equal(out.length, 4)
    assert.equal((out[0].parts[0] as any).text, 'c')
    assert.equal((out[3].parts[0] as any).text, 'f')
  })

  test('respects minRetain floor even if still over budget', async () => {
    const contents = [msg('a'), msg('b'), msg('c'), msg('d'), msg('e')]
    const out = await selectWithinBudget(contents, async () => 99999, { budget: 1, minRetain: 3 })
    assert.equal(out.length, 3)
    assert.equal((out[0].parts[0] as any).text, 'c')
  })

  test('defaults minRetain to 3 when omitted', async () => {
    const contents = [msg('a'), msg('b'), msg('c'), msg('d'), msg('e')]
    const out = await selectWithinBudget(contents, async () => 99999, { budget: 1 })
    assert.equal(out.length, 3)
  })

  test('falls back to last 20 on countTokens throw', async () => {
    const contents: GeminiContent[] = []
    for (let i = 0; i < 30; i++) contents.push(msg(`m${i}`))
    const out = await selectWithinBudget(contents, async () => { throw new Error('api down') }, { budget: 1000 })
    assert.equal(out.length, 20)
    assert.equal((out[0].parts[0] as any).text, 'm10')
    assert.equal((out[19].parts[0] as any).text, 'm29')
  })

  test('fallback returns full contents if shorter than 20', async () => {
    const contents = [msg('a'), msg('b')]
    const out = await selectWithinBudget(contents, async () => { throw new Error('x') }, { budget: 1000 })
    assert.deepEqual(out, contents)
  })
})
