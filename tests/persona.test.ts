import { describe, test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { PersonaLoader } from '../src/persona.ts'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'

const stateDir = path.join(os.tmpdir(), `gemma-persona-state-${process.pid}`)
const squadDir = path.join(os.tmpdir(), `gemma-persona-squad-${process.pid}`)

async function reset() {
  await fs.rm(stateDir, { recursive: true, force: true })
  await fs.rm(squadDir, { recursive: true, force: true })
  await fs.mkdir(stateDir, { recursive: true })
}

describe('PersonaLoader', () => {
  beforeEach(async () => {
    process.env.DISCORD_STATE_DIR = stateDir
    process.env.SQUAD_CONTEXT_DIR = squadDir
    await reset()
  })

  test('falls back to default persona when persona.md missing', async () => {
    const loader = new PersonaLoader()
    await loader.load()
    const prompt = loader.buildSystemPrompt('unknown-channel-id')
    assert.ok(prompt.toLowerCase().includes('gemma'))
  })

  test('includes persona.md contents', async () => {
    await fs.writeFile(path.join(stateDir, 'persona.md'), 'Custom persona text here.', 'utf8')
    const loader = new PersonaLoader()
    await loader.load()
    const prompt = loader.buildSystemPrompt('c1')
    assert.ok(prompt.includes('Custom persona text here.'))
  })

  test('includes shared memories', async () => {
    await fs.mkdir(path.join(squadDir, 'memories'), { recursive: true })
    await fs.writeFile(path.join(squadDir, 'memories', 'user_prefs.md'), 'User likes dry humor.', 'utf8')
    await fs.writeFile(path.join(squadDir, 'memories', 'context.md'), 'Context snippet.', 'utf8')

    const loader = new PersonaLoader()
    await loader.load()
    const prompt = loader.buildSystemPrompt('c1')
    assert.ok(prompt.includes('User likes dry humor.'))
    assert.ok(prompt.includes('Context snippet.'))
  })

  test('includes channel-specific summary for the given channel', async () => {
    await fs.mkdir(path.join(squadDir, 'summaries'), { recursive: true })
    await fs.writeFile(path.join(squadDir, 'summaries', 'CHAN_A.md'), 'Summary for A.', 'utf8')
    await fs.writeFile(path.join(squadDir, 'summaries', 'CHAN_B.md'), 'Summary for B.', 'utf8')

    const loader = new PersonaLoader()
    await loader.load()
    const promptA = loader.buildSystemPrompt('CHAN_A')
    assert.ok(promptA.includes('Summary for A.'))
    assert.ok(!promptA.includes('Summary for B.'))
  })

  test('tolerates missing squad-context dir', async () => {
    await fs.rm(squadDir, { recursive: true, force: true })
    const loader = new PersonaLoader()
    await loader.load()                                  // must not throw
    const prompt = loader.buildSystemPrompt('c1')        // must not throw
    assert.ok(prompt.length > 0)
  })

  test('load() picks up persona.md and memory edits on reload', async () => {
    await fs.writeFile(path.join(stateDir, 'persona.md'), 'v1 persona', 'utf8')
    const loader = new PersonaLoader()
    await loader.load()
    assert.ok(loader.buildSystemPrompt('c1').includes('v1 persona'))

    await fs.writeFile(path.join(stateDir, 'persona.md'), 'v2 persona', 'utf8')
    await fs.mkdir(path.join(squadDir, 'memories'), { recursive: true })
    await fs.writeFile(path.join(squadDir, 'memories', 'new.md'), 'new memory', 'utf8')

    await loader.load()
    const prompt = loader.buildSystemPrompt('c1')
    assert.ok(prompt.includes('v2 persona'))
    assert.ok(prompt.includes('new memory'))
  })

  test('channel summary is read fresh on each buildSystemPrompt call', async () => {
    await fs.mkdir(path.join(squadDir, 'summaries'), { recursive: true })
    await fs.writeFile(path.join(squadDir, 'summaries', 'C1.md'), 'summary v1', 'utf8')

    const loader = new PersonaLoader()
    await loader.load()
    assert.ok(loader.buildSystemPrompt('C1').includes('summary v1'))

    // simulate cron rewrite between turns
    await fs.writeFile(path.join(squadDir, 'summaries', 'C1.md'), 'summary v2', 'utf8')
    assert.ok(loader.buildSystemPrompt('C1').includes('summary v2'))
  })
})
