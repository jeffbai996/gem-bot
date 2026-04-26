import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { PinnedFactsStore } from '../src/pinned-facts.ts'

async function tmp(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pinned-facts-'))
  return path.join(dir, 'pinned-facts.md')
}

describe('PinnedFactsStore', () => {
  test('append creates section if missing', async () => {
    const file = await tmp()
    const s = new PinnedFactsStore(file)
    await s.append('C1', '#general', 'hello world')
    const content = await fs.readFile(file, 'utf8')
    assert.match(content, /## C1 — #general/)
    assert.match(content, /hello world/)
  })

  test('append to existing channel adds line, preserves old', async () => {
    const file = await tmp()
    const s = new PinnedFactsStore(file)
    await s.append('C1', '#general', 'first')
    await s.append('C1', '#general', 'second')
    const content = await fs.readFile(file, 'utf8')
    const matches = content.match(/^- \[/gm) ?? []
    assert.equal(matches.length, 2)
    assert.match(content, /first/)
    assert.match(content, /second/)
  })

  test('different channels get separate sections', async () => {
    const file = await tmp()
    const s = new PinnedFactsStore(file)
    await s.append('C1', '#a', 'one')
    await s.append('C2', '#b', 'two')
    const content = await fs.readFile(file, 'utf8')
    assert.match(content, /## C1/)
    assert.match(content, /## C2/)
  })

  test('long content truncates to 1500 chars + ellipsis', async () => {
    const file = await tmp()
    const s = new PinnedFactsStore(file)
    const long = 'x'.repeat(2000)
    await s.append('C1', '#a', long)
    const content = await fs.readFile(file, 'utf8')
    const line = content.split('\n').find(l => l.startsWith('- ['))!
    assert.ok(line.endsWith('...'), 'truncated with ellipsis')
    assert.ok(line.length < 1600)
  })

  test('readForChannel returns lines for that channel only', async () => {
    const file = await tmp()
    const s = new PinnedFactsStore(file)
    await s.append('C1', '#a', 'one')
    await s.append('C2', '#b', 'two')
    const facts = await s.readForChannel('C1')
    assert.equal(facts.length, 1)
    assert.equal(facts[0].content, 'one')
  })

  test('readForChannel on missing channel returns empty', async () => {
    const file = await tmp()
    const s = new PinnedFactsStore(file)
    const facts = await s.readForChannel('nope')
    assert.deepEqual(facts, [])
  })

  test('readForChannel on missing file returns empty', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pinned-facts-'))
    const s = new PinnedFactsStore(path.join(dir, 'no-such.md'))
    const facts = await s.readForChannel('C1')
    assert.deepEqual(facts, [])
  })

  test('readForChannelSync returns bullets for the channel', async () => {
    const file = await tmp()
    const s = new PinnedFactsStore(file)
    await s.append('C1', '#a', 'one')
    await s.append('C1', '#a', 'two')
    const body = s.readForChannelSync('C1')
    assert.match(body, /- \[.*\] one/)
    assert.match(body, /- \[.*\] two/)
  })

  test('newlines in content are flattened to spaces', async () => {
    const file = await tmp()
    const s = new PinnedFactsStore(file)
    await s.append('C1', '#a', 'line1\nline2\n\nline3')
    const facts = await s.readForChannel('C1')
    assert.equal(facts.length, 1)
    assert.ok(!facts[0].content.includes('\n'))
  })
})
