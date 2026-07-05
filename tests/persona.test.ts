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

  test('falls back to default persona when GEMINI.md and persona.md are missing', async () => {
    const loader = new PersonaLoader()
    await loader.load()
    const prompt = loader.buildSystemPrompt('unknown-channel-id')
    assert.ok(prompt.toLowerCase().includes('gemma'))
  })

  test('includes GEMINI.md contents', async () => {
    await fs.writeFile(path.join(stateDir, 'GEMINI.md'), 'Custom Gemini text here.', 'utf8')
    const loader = new PersonaLoader()
    await loader.load()
    const prompt = loader.buildSystemPrompt('c1')
    assert.ok(prompt.includes('Custom Gemini text here.'))
  })

  test('falls back to legacy persona.md when GEMINI.md is missing', async () => {
    await fs.writeFile(path.join(stateDir, 'persona.md'), 'Legacy persona text here.', 'utf8')
    const loader = new PersonaLoader()
    await loader.load()
    const prompt = loader.buildSystemPrompt('c1')
    assert.ok(prompt.includes('Legacy persona text here.'))
  })

  test('prefers GEMINI.md over legacy persona.md', async () => {
    await fs.writeFile(path.join(stateDir, 'GEMINI.md'), 'New Gemini text here.', 'utf8')
    await fs.writeFile(path.join(stateDir, 'persona.md'), 'Legacy persona text here.', 'utf8')
    const loader = new PersonaLoader()
    await loader.load()
    const prompt = loader.buildSystemPrompt('c1')
    assert.ok(prompt.includes('New Gemini text here.'))
    assert.ok(!prompt.includes('Legacy persona text here.'))
  })

  test('tolerates missing squad-context dir', async () => {
    await fs.rm(squadDir, { recursive: true, force: true })
    const loader = new PersonaLoader()
    await loader.load()                                  // must not throw
    const prompt = loader.buildSystemPrompt('c1')        // must not throw
    assert.ok(prompt.length > 0)
  })

  test('load() picks up GEMINI.md edits on reload', async () => {
    await fs.writeFile(path.join(stateDir, 'GEMINI.md'), 'v1 persona', 'utf8')
    const loader = new PersonaLoader()
    await loader.load()
    assert.ok(loader.buildSystemPrompt('c1').includes('v1 persona'))

    await fs.writeFile(path.join(stateDir, 'GEMINI.md'), 'v2 persona', 'utf8')
    await loader.load()
    assert.ok(loader.buildSystemPrompt('c1').includes('v2 persona'))
  })

  // Tests for the legacy markdown shared-memories path
  // (~/agents/shared/squad-context/memories/) and the markdown
  // channel-summary path (~/agents/shared/squad-context/summaries/)
  // were removed in 2026-05-01 — both dirs were nuked in the squad-store
  // rebuild on 2026-04-26 and the corresponding readers in persona.ts went
  // with them. The live channel summary now flows through SummaryStore
  // (see summarization/store.ts and the SummarizationScheduler).
})
