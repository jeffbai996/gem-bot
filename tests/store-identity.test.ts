// gemma names itself when it writes to the shared store. Same fix as the gpt
// bot's -- see the comment on agySpawnEnv. agy has no CLAUDE_CONFIG_DIR, so
// without an explicit SQUAD_STORE_BOT its writes were recorded against the
// box's default identity.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { agySpawnEnv, SQUAD_STORE_IDENTITY } from '../src/agy-chat.ts'

test('every agy spawn carries an identity for the store', () => {
  assert.equal(agySpawnEnv().SQUAD_STORE_BOT, SQUAD_STORE_IDENTITY)
  assert.equal(SQUAD_STORE_IDENTITY, process.env.SQUAD_STORE_BOT || 'gemma')
})

test('the identity does not depend on a systemd drop-in existing', () => {
  assert.notEqual(SQUAD_STORE_IDENTITY, '')
  assert.notEqual(SQUAD_STORE_IDENTITY, undefined)
})

test('an explicit override still wins over the identity', () => {
  assert.equal(agySpawnEnv({ SQUAD_STORE_BOT: 'somebody-else' }).SQUAD_STORE_BOT, 'somebody-else')
})

test('adding the identity did not undo the secret stripping', () => {
  process.env.DISCORD_BOT_TOKEN = 'should-not-leak'
  try {
    const env = agySpawnEnv()
    assert.equal(env.DISCORD_BOT_TOKEN, undefined)
    assert.equal(env.GEMINI_API_KEY, undefined)
  } finally {
    delete process.env.DISCORD_BOT_TOKEN
  }
})
