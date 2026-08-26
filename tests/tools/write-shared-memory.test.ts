import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  cardFields, clampText, postWrite, describe as say,
  squadWriteTools, saveSquadMemoryTool, addSquadScratchTool, storeToken
} from '../../src/tools/write-shared-memory.ts'

const HOME = '111111111111111111'

/** Run body with env set, always restoring — these are process-wide. */
function withEnv(env: Record<string, string | undefined>, body: () => any) {
  const prev: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(env)) {
    prev[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try { return body() } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

/** Capture the request body a tool would send, without touching the network. */
async function captureBody(run: () => Promise<any>): Promise<any> {
  let body: any = null
  const orig = globalThis.fetch
  globalThis.fetch = (async (_u: string, init: any) => {
    body = JSON.parse(init.body)
    return { ok: true, status: 201, json: async () => ({ ok: true }) }
  }) as any
  try { await run() } finally { globalThis.fetch = orig }
  return body
}

describe('card routing', () => {
  it('a user-requested write cards in the home channel', () => {
    withEnv({ GEMMA_CARD_CHANNEL_ID: HOME }, () => {
      const f = cardFields(true)
      assert.equal(f.discord_chat_id, HOME)
      assert.ok(!f.discord_self_initiated, 'an asked-for write is not self-initiated')
    })
  })

  it('a self-initiated write is flagged so the store badges it auto', () => {
    withEnv({ GEMMA_CARD_CHANNEL_ID: HOME }, () => {
      const f = cardFields(false)
      assert.equal(f.discord_self_initiated, true)
      assert.ok(!f.discord_chat_id, 'no chat target - the store routes it to alerts')
    })
  })

  it('falls back to the alerts room when no home channel is configured', () => {
    withEnv({ GEMMA_CARD_CHANNEL_ID: undefined }, () => {
      // An unattributed card in the alerts room beats a silent write.
      assert.equal(cardFields(true).discord_self_initiated, true)
    })
  })
})

describe('requests', () => {
  it('identifies itself, or the store refuses the write outright', async () => {
    let seen: any = null
    const fake = async (_u: string, init: any) => {
      seen = init
      return { ok: true, status: 201, json: async () => ({ ok: true }) } as any
    }
    await postWrite('/api/memory', { text: 'x' }, false, fake as any)
    assert.equal(seen.headers['X-Squad-Bot'], 'gemma')
    assert.equal(JSON.parse(seen.body).author, 'gemma')
  })

  it('a rejected write never reads as saved', async () => {
    const fake = async () => ({
      ok: false, status: 403, json: async () => ({ error: 'refused: anonymous write' }),
    }) as any
    const out = await postWrite('/api/memory', { text: 'x' }, false, fake as any)
    const said = say('the memory', out, false)
    assert.match(said, /NOT saved/)
    assert.match(said, /refused/)
  })

  it('a store that does not answer is an error, not a success', async () => {
    const fake = async () => { throw new Error('ECONNREFUSED') }
    const out = await postWrite('/api/memory', { text: 'x' }, false, fake as any)
    assert.equal(out.ok, false)
    assert.match(say('the memory', out, false), /NOT saved/)
  })
})

describe('input limits', () => {
  it('clamps a wall of fetched text instead of pouring it into the store', () => {
    const out = clampText('x'.repeat(9000))
    assert.ok(out.length <= 2000, `got ${out.length}`)
    assert.ok(out.endsWith('\u2026'))
  })

  it('refuses an empty write rather than saving a blank row', async () => {
    for (const tool of squadWriteTools) {
      const said = await tool.execute({ text: '   ' }, {} as any)
      assert.match(said, /NOT saved/, `${tool.name} accepted an empty write`)
    }
  })

  it('clamps an absurd scratch TTL', async () => {
    const body = await captureBody(() =>
      addSquadScratchTool.execute({ text: 'note', ttl_hours: 100000 }, {} as any))
    assert.ok(body.ttl_hours <= 72, `ttl was ${body.ttl_hours}`)
  })
})

describe('registration', () => {
  it('exposes exactly the three agreed surfaces', () => {
    assert.deepEqual(squadWriteTools.map(t => t.name).sort(),
      ['add_squad_scratch', 'add_squad_todo', 'save_squad_memory'])
  })

  it('defaults to self-initiated when the model does not claim it was asked', async () => {
    const body = await withEnv({ GEMMA_CARD_CHANNEL_ID: HOME }, () =>
      captureBody(() => saveSquadMemoryTool.execute({ text: 'a fact' }, {} as any)))
    assert.equal(body.discord_self_initiated, true)
    assert.ok(!body.discord_chat_id)
  })
})

// ── authorization ────────────────────────────────────────────────────────
// Every unsafe store route requires X-Squad-Token. Gemma sent X-Squad-Bot and
// not the token, so every write she made between 2026-08-24 and 2026-08-25 was
// a 401 that reached nothing. The old tests mocked fetch, and a mocked fetch
// cannot 401 — which is exactly why this shipped broken and looked fine.
describe('storeToken', () => {
  const saved = process.env.SQUAD_STORE_TOKEN

  afterEach(() => {
    if (saved === undefined) delete process.env.SQUAD_STORE_TOKEN
    else process.env.SQUAD_STORE_TOKEN = saved
  })

  it('reads the credential from the environment', () => {
    process.env.SQUAD_STORE_TOKEN = 'from-env'
    assert.equal(storeToken(), 'from-env')
  })

  it('trims whitespace, which a unit file will supply', () => {
    process.env.SQUAD_STORE_TOKEN = '  padded  '
    assert.equal(storeToken(), 'padded')
  })

  it('is empty when unset, rather than throwing', () => {
    delete process.env.SQUAD_STORE_TOKEN
    assert.equal(storeToken(), '')
  })

})

describe('postWrite authorization header', () => {
  const saved = process.env.SQUAD_STORE_TOKEN
  afterEach(() => {
    if (saved === undefined) delete process.env.SQUAD_STORE_TOKEN
    else process.env.SQUAD_STORE_TOKEN = saved
  })

  it('sends X-Squad-Token so the write is not refused', async () => {
    process.env.SQUAD_STORE_TOKEN = 'tok'
    let seen: any = null
    const fake = async (_u: string, init: any) => {
      seen = init.headers
      return { ok: true, status: 201, json: async () => ({ ok: true }) } as any
    }
    await postWrite('/api/todo', { text: 't' }, false, fake as any)
    assert.equal(seen['X-Squad-Token'], 'tok')
    assert.equal(seen['X-Squad-Bot'], 'gemma')
  })

  it('omits the header entirely when unset, and still sends', async () => {
    delete process.env.SQUAD_STORE_TOKEN
    let seen: any = null
    const fake = async (_u: string, init: any) => {
      seen = init.headers
      return { ok: true, status: 201, json: async () => ({ ok: true }) } as any
    }
    await postWrite('/api/todo', { text: 't' }, false, fake as any)
    assert.ok(!('X-Squad-Token' in seen))
    // a missing credential must not swallow the call — it fails at the server
    assert.equal(seen['X-Squad-Bot'], 'gemma')
  })
})

