import { describe, test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {
  GRACEFUL_SHUTDOWN_DEADLINE_MS,
  RESTART_DRAIN_DEADLINE_MS,
  RestartCoordinator,
  ShutdownGate,
  rewriteEnvVar,
  waitForIdleOrDeadline,
} from '../src/restart.ts'

const tick = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

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

describe('RestartCoordinator', () => {
  test('keeps intake open until every accepted turn reaches idle', async () => {
    const gate = new ShutdownGate()
    const firstDone = gate.enter()
    assert.ok(firstDone)
    let launches = 0
    const coordinator = new RestartCoordinator(
      () => gate.waitForIdle(),
      () => { launches++ },
      () => gate.beginDrain(),
    )

    assert.equal(coordinator.request(), true)
    assert.equal(coordinator.request(), false)
    const secondDone = gate.enter()
    assert.ok(secondDone, 'a pending model-change restart must admit unrelated work')
    firstDone()
    await Promise.resolve()
    assert.equal(launches, 0)
    secondDone()
    await Promise.resolve()
    assert.equal(launches, 1)
    assert.equal(gate.enter(), null)
  })

  test('warns on an overrun without closing intake or launching', async () => {
    const gate = new ShutdownGate()
    let expired = 0
    let launches = 0
    const coordinator = new RestartCoordinator(
      () => new Promise<void>(() => {}),
      () => { launches++ },
      () => gate.beginDrain(),
      { deadlineMs: 5, onDeadline: () => { expired++ } },
    )

    coordinator.request()
    await tick(30)
    assert.equal(expired, 1)
    assert.equal(launches, 0)
    assert.equal(gate.isDraining(), false)
  })
})

describe('graceful shutdown', () => {
  test('has bounded defaults and distinguishes idle from timeout', async () => {
    assert.ok(RESTART_DRAIN_DEADLINE_MS > 0 && RESTART_DRAIN_DEADLINE_MS <= 30 * 60_000)
    assert.ok(GRACEFUL_SHUTDOWN_DEADLINE_MS > 0 && GRACEFUL_SHUTDOWN_DEADLINE_MS <= 30_000)
    assert.equal(await waitForIdleOrDeadline(Promise.resolve(), 30), 'idle')
    assert.equal(await waitForIdleOrDeadline(new Promise<void>(() => {}), 5), 'timeout')
  })

  test('SIGTERM can begin exit after restart cutover begins', () => {
    const gate = new ShutdownGate()
    assert.equal(gate.beginDrain(), true)
    assert.equal(gate.beginExit(), true)
    assert.equal(gate.beginExit(), false)
  })
})
