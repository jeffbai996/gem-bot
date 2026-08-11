import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { executeGeminiCommand } from '../src/commands.ts'

const tmp = path.join(os.tmpdir(), `gem-model-restart-${process.pid}`)
const previousStateDir = process.env.DISCORD_STATE_DIR

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
  if (previousStateDir === undefined) delete process.env.DISCORD_STATE_DIR
  else process.env.DISCORD_STATE_DIR = previousStateDir
})

test('model changes acknowledge Discord before requesting coordinated restart', async () => {
  await fs.mkdir(tmp, { recursive: true })
  await fs.writeFile(path.join(tmp, '.env'), 'GEMINI_MODEL=old-model\n')
  process.env.DISCORD_STATE_DIR = tmp

  const order: string[] = []
  const interaction = {
    user: { id: 'admin' },
    options: {
      getSubcommand: () => 'api',
      getSubcommandGroup: () => 'model',
      getString: (name: string) => name === 'id' ? 'gemini-test-model' : null,
    },
    reply: async () => { order.push('reply') },
  }
  const deps = {
    summaryStore: {},
    summarizer: {},
    stats: {},
    requestRestart: () => { order.push('restart') },
  }

  await executeGeminiCommand(
    interaction as any,
    {} as any,
    {} as any,
    {} as any,
    'admin',
    deps as any,
  )

  assert.deepEqual(order, ['reply', 'restart'])
  assert.match(await fs.readFile(path.join(tmp, '.env'), 'utf8'), /^GEMINI_MODEL=gemini-test-model$/m)
})
