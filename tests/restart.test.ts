import { describe, test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { rewriteEnvVar } from '../src/restart.ts'

const tmp = path.join(os.tmpdir(), `gemma-restart-test-${process.pid}`)
const envPath = path.join(tmp, '.env')

async function setup(initial: string) {
  await fs.rm(tmp, { recursive: true, force: true })
  await fs.mkdir(tmp, { recursive: true })
  await fs.writeFile(envPath, initial)
}

describe('rewriteEnvVar', () => {
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true })
  })

  test('replaces an existing key in place', async () => {
    await setup('GEMINI_MODEL=gemini-3-flash-preview\nDISCORD_BOT_TOKEN=abc\n')
    await rewriteEnvVar(envPath, 'GEMINI_MODEL', 'gemini-3-pro-preview')
    const body = await fs.readFile(envPath, 'utf8')
    assert.match(body, /^GEMINI_MODEL=gemini-3-pro-preview$/m)
    // Other keys preserved.
    assert.match(body, /^DISCORD_BOT_TOKEN=abc$/m)
    // Only one model line — no duplicates.
    assert.equal(body.match(/^GEMINI_MODEL=/gm)!.length, 1)
  })

  test('preserves comments and ordering', async () => {
    const initial = '# secrets\nDISCORD_BOT_TOKEN=tok\n\n# admin\nSQUAD_HELPER_ADMIN_ID=42\nGEMINI_MODEL=old\n'
    await setup(initial)
    await rewriteEnvVar(envPath, 'GEMINI_MODEL', 'new')
    const body = await fs.readFile(envPath, 'utf8')
    const lines = body.split('\n')
    assert.equal(lines[0], '# secrets')
    assert.equal(lines[3], '# admin')
    assert.equal(lines[4], 'SQUAD_HELPER_ADMIN_ID=42')
    assert.equal(lines[5], 'GEMINI_MODEL=new')
  })

  test('appends a missing key with trailing newline', async () => {
    await setup('DISCORD_BOT_TOKEN=tok\n')
    await rewriteEnvVar(envPath, 'GEMINI_MODEL', 'gemini-3-pro-preview')
    const body = await fs.readFile(envPath, 'utf8')
    assert.match(body, /^DISCORD_BOT_TOKEN=tok$/m)
    assert.match(body, /^GEMINI_MODEL=gemini-3-pro-preview$/m)
    assert.ok(body.endsWith('\n'), 'file should end with a newline')
  })

  test('creates the file if it does not exist', async () => {
    await fs.rm(tmp, { recursive: true, force: true })
    await fs.mkdir(tmp, { recursive: true })
    await rewriteEnvVar(envPath, 'GEMINI_MODEL', 'flash')
    const body = await fs.readFile(envPath, 'utf8')
    assert.match(body, /^GEMINI_MODEL=flash$/m)
  })

  test('write is atomic (no .tmp left behind)', async () => {
    await setup('GEMINI_MODEL=old\n')
    await rewriteEnvVar(envPath, 'GEMINI_MODEL', 'new')
    const entries = await fs.readdir(tmp)
    assert.deepEqual(entries.sort(), ['.env'])
  })

  test('does not match keys that share a prefix', async () => {
    await setup('GEMINI_MODEL_NICKNAME=robot\nGEMINI_MODEL=old\n')
    await rewriteEnvVar(envPath, 'GEMINI_MODEL', 'new')
    const body = await fs.readFile(envPath, 'utf8')
    assert.match(body, /^GEMINI_MODEL_NICKNAME=robot$/m)
    assert.match(body, /^GEMINI_MODEL=new$/m)
  })
})
