# Gemma Standalone Bot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the broken MCP-based `discord-mcp` with a standalone Bun daemon ("Gemma") that reads Discord via `discord.js`, calls the Gemini API on allowed messages, and replies with text + optional emoji reactions. Deployed as a systemd user service on HOST.

**Architecture:** Single long-running Bun process. `discord.js` v14 client pushes `messageCreate` events through an access filter; on pass, attachments are downloaded while history is fetched in parallel; both feed a prompt builder that calls Gemini with `responseSchema` enforcing `{ react, reply }`; reactions and chunked text replies are dispatched in parallel. All state lives in `~/.gemini/channels/discord/` on HOST. No database, no MCP scaffolding.

**Tech Stack:** TypeScript, Bun 1.x, `discord.js` ^14.14.0, `@google/generative-ai` (latest), model `gemini-3.1-flash`, Node built-in test runner (`bun test`).

**Spec:** `docs/superpowers/specs/2026-04-16-gemma-standalone-bot-design.md`

---

## File Structure

After this plan completes, `src/` will contain:

```
src/
  gemma.ts         # main entry: env/state-dir bootstrap, client wiring, SIGHUP handler
  access.ts        # access.json load/reload, channel+user+mention filter (simplified rewrite)
  persona.ts       # persona.md loader, reload on SIGHUP
  history.ts       # fetch last N messages from a channel, format for Gemini
  attachments.ts   # download Discord attachments, mime-sniff, build inline data parts, cleanup
  gemini.ts        # Gemini client wrapper: build request, call API, parse structured response
  chunk.ts         # 2000-char splitter (unchanged, already correct)
tests/
  access.test.ts   # rewritten for simpler access model
  chunk.test.ts    # unchanged
  attachments.test.ts  # new
  gemini.test.ts       # new (parses structured output from canned JSON)
  history.test.ts      # new (history formatting)
```

Deleted: `src/server.ts`, `src/monitor.ts`, `fetch_dms.ts`, `talk.ts`, `test_bot.ts`, `test_bot2.ts`, `server_debug.log`, `server.log`, `test_bot.log`, `test_bot2.log`, `.mcp.json`.

---

## Task 1: Clean slate — remove MCP scaffolding & stale files

**Files:**
- Delete: `src/server.ts`, `src/monitor.ts`, `fetch_dms.ts`, `talk.ts`, `test_bot.ts`, `test_bot2.ts`
- Delete: `server_debug.log`, `server.log`, `test_bot.log`, `test_bot2.log`
- Delete: `.mcp.json`
- Modify: `.gitignore` — add `inbox/`, `*.log`

- [ ] **Step 1: Remove files**

```bash
cd ~/repos/discord-mcp
rm src/server.ts src/monitor.ts fetch_dms.ts talk.ts test_bot.ts test_bot2.ts
rm -f server_debug.log server.log test_bot.log test_bot2.log
rm .mcp.json
```

- [ ] **Step 2: Update .gitignore**

Replace `.gitignore` contents with:

```
node_modules/
dist/
.env
.DS_Store
inbox/
*.log
```

- [ ] **Step 3: Verify**

```bash
ls src/          # should show: access.ts, chunk.ts only (monitor.ts gone)
ls *.ts 2>/dev/null   # should be empty
```

Expected: only `src/access.ts` and `src/chunk.ts` remain in `src/`; no stray `.ts` files in repo root.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: remove MCP scaffolding and stale experiment files"
```

---

## Task 2: Update package.json for Bun + Gemini

**Files:**
- Modify: `package.json`
- Modify: `tsconfig.json` (already has `bun-types`, verify)

- [ ] **Step 1: Rewrite package.json**

Replace entire file:

```json
{
  "name": "gemma",
  "version": "1.0.0",
  "description": "Gemini-backed Discord bot",
  "main": "src/gemma.ts",
  "type": "module",
  "scripts": {
    "start": "bun src/gemma.ts",
    "test": "bun test"
  },
  "dependencies": {
    "@google/generative-ai": "^0.21.0",
    "discord.js": "^14.14.0",
    "dotenv": "^17.4.1"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "@types/node": "^20.0.0"
  }
}
```

- [ ] **Step 2: Install**

```bash
rm -rf node_modules package-lock.json
bun install
```

Expected: creates `bun.lockb`, `node_modules/` populated, no errors. If `@google/generative-ai` resolves to a different latest major version, update the caret range accordingly and note it in the commit message.

- [ ] **Step 3: Verify tsconfig compiles**

```bash
bun tsc --noEmit
```

Expected: existing `src/access.ts` and `src/chunk.ts` compile cleanly (they don't reference removed deps).

- [ ] **Step 4: Commit**

```bash
git add package.json bun.lockb .gitignore
git rm -f package-lock.json 2>/dev/null || true
git commit -m "feat: switch runtime to bun, drop MCP SDK, add gemini SDK"
```

---

## Task 3: Rewrite access.ts — simplified model

**Files:**
- Modify: `src/access.ts` (full rewrite)
- Modify: `tests/access.test.ts` (rewrite for new shape)

### Design

New `access.json` schema:

```json
{
  "users": { "<user_id>": { "allowed": true } },
  "channels": {
    "<channel_id>": { "enabled": true, "requireMention": false }
  }
}
```

- No pairing, no approved/ dir, no DM policy switch.
- Unknown user → denied. Unknown channel → denied.
- Channel match: `enabled` must be true. If `requireMention` is true, the message must `@Gemma`.
- Users can be empty (no per-user filter) if you want allow-all-from-this-channel. But we keep users as an explicit list for simplicity in v1.

- [ ] **Step 1: Write failing tests**

Replace `tests/access.test.ts`:

```typescript
import { describe, test, beforeEach } from 'bun:test'
import assert from 'node:assert/strict'
import { AccessManager } from '../src/access.ts'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'

const testDir = path.join(os.tmpdir(), `gemma-access-test-${process.pid}`)

async function writeAccess(obj: unknown) {
  await fs.mkdir(testDir, { recursive: true })
  await fs.writeFile(path.join(testDir, 'access.json'), JSON.stringify(obj), 'utf8')
}

describe('AccessManager', () => {
  let mgr: AccessManager

  beforeEach(async () => {
    process.env.DISCORD_STATE_DIR = testDir
    await fs.rm(testDir, { recursive: true, force: true })
  })

  test('denies unknown user in unknown channel', async () => {
    await writeAccess({ users: {}, channels: {} })
    mgr = new AccessManager()
    await mgr.load()
    assert.equal(mgr.canHandle({ channelId: 'C1', userId: 'U1', isMention: false }), false)
  })

  test('denies allowed user in unknown channel', async () => {
    await writeAccess({ users: { U1: { allowed: true } }, channels: {} })
    mgr = new AccessManager()
    await mgr.load()
    assert.equal(mgr.canHandle({ channelId: 'C1', userId: 'U1', isMention: false }), false)
  })

  test('allows known user in enabled channel without requireMention', async () => {
    await writeAccess({
      users: { U1: { allowed: true } },
      channels: { C1: { enabled: true, requireMention: false } }
    })
    mgr = new AccessManager()
    await mgr.load()
    assert.equal(mgr.canHandle({ channelId: 'C1', userId: 'U1', isMention: false }), true)
  })

  test('denies known user in requireMention channel without mention', async () => {
    await writeAccess({
      users: { U1: { allowed: true } },
      channels: { C1: { enabled: true, requireMention: true } }
    })
    mgr = new AccessManager()
    await mgr.load()
    assert.equal(mgr.canHandle({ channelId: 'C1', userId: 'U1', isMention: false }), false)
    assert.equal(mgr.canHandle({ channelId: 'C1', userId: 'U1', isMention: true }), true)
  })

  test('denies when channel is disabled', async () => {
    await writeAccess({
      users: { U1: { allowed: true } },
      channels: { C1: { enabled: false, requireMention: false } }
    })
    mgr = new AccessManager()
    await mgr.load()
    assert.equal(mgr.canHandle({ channelId: 'C1', userId: 'U1', isMention: false }), false)
  })

  test('creates empty access.json if missing', async () => {
    await fs.mkdir(testDir, { recursive: true })
    mgr = new AccessManager()
    await mgr.load()
    const raw = await fs.readFile(path.join(testDir, 'access.json'), 'utf8')
    const parsed = JSON.parse(raw)
    assert.deepEqual(parsed, { users: {}, channels: {} })
  })

  test('reload picks up edits without process restart', async () => {
    await writeAccess({ users: {}, channels: {} })
    mgr = new AccessManager()
    await mgr.load()
    assert.equal(mgr.canHandle({ channelId: 'C1', userId: 'U1', isMention: false }), false)

    await writeAccess({
      users: { U1: { allowed: true } },
      channels: { C1: { enabled: true, requireMention: false } }
    })
    await mgr.load()
    assert.equal(mgr.canHandle({ channelId: 'C1', userId: 'U1', isMention: false }), true)
  })
})
```

- [ ] **Step 2: Run tests — verify failure**

```bash
bun test tests/access.test.ts
```

Expected: FAIL (AccessManager shape doesn't match new tests yet — method signature changed from multi-arg to single-object arg, no pairing, etc.)

- [ ] **Step 3: Rewrite src/access.ts**

Replace entire file:

```typescript
import fs from 'fs/promises'
import path from 'path'
import os from 'os'

export interface AccessFile {
  users: Record<string, { allowed: boolean }>
  channels: Record<string, { enabled: boolean; requireMention: boolean }>
}

export interface CanHandleInput {
  channelId: string
  userId: string
  isMention: boolean
}

const EMPTY: AccessFile = { users: {}, channels: {} }

export class AccessManager {
  private stateDir: string
  private file: string
  private data: AccessFile = { ...EMPTY }

  constructor() {
    this.stateDir = process.env.DISCORD_STATE_DIR || path.join(os.homedir(), '.gemini', 'channels', 'discord')
    this.file = path.join(this.stateDir, 'access.json')
  }

  async load(): Promise<void> {
    await fs.mkdir(this.stateDir, { recursive: true })
    try {
      const raw = await fs.readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw) as Partial<AccessFile>
      this.data = {
        users: parsed.users ?? {},
        channels: parsed.channels ?? {}
      }
    } catch (e: any) {
      if (e.code === 'ENOENT') {
        this.data = { ...EMPTY }
        await fs.writeFile(this.file, JSON.stringify(this.data, null, 2), 'utf8')
      } else {
        throw e
      }
    }
  }

  canHandle({ channelId, userId, isMention }: CanHandleInput): boolean {
    const user = this.data.users[userId]
    if (!user?.allowed) return false

    const channel = this.data.channels[channelId]
    if (!channel?.enabled) return false

    if (channel.requireMention && !isMention) return false

    return true
  }
}
```

- [ ] **Step 4: Run tests — verify pass**

```bash
bun test tests/access.test.ts
```

Expected: all 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/access.ts tests/access.test.ts
git commit -m "refactor: simplify access model — no pairing, explicit allowlist"
```

---

## Task 4: persona.ts — persona + shared squad context loader

**Files:**
- Create: `src/persona.ts`
- Create: `tests/persona.test.ts`

### Design

Gemma's final system prompt is composed from three sources at request time:

1. **Gemma persona** — `~/.gemini/channels/discord/persona.md` (loaded once at startup; reloaded on SIGHUP)
2. **Shared squad memories** — all `<your-shared-context-dir>/memories/*.md` files, concatenated (loaded once; reloaded on SIGHUP)
3. **Channel summary** — `<your-shared-context-dir>/summaries/<channel_id>.md` — read at build-prompt time (fresh each turn, since the hourly `summarise_channels.py` cron rewrites it; reading on every turn is a single small file open and avoids staleness)
4. **Bot roster** — hard-coded constant listing the known bots (IDs + one-line public descriptions). Gemma's own ID (`1492759800688152637`) is included so she recognizes self-tags.

**What Gemma does NOT read:** individual bot persona files like `<agent-config-dir>/CLAUDE.md`. Those are private to each bot.

The loader exposes a single method `buildSystemPrompt(channelId: string): string` that assembles everything. We test it with fixtures under a temp dir, toggling the presence/absence of each source.

Squad-context dir path resolution:
- `SQUAD_CONTEXT_DIR` env var wins if set
- Otherwise `<your-shared-context-dir>` (the HOST convention)
- Missing dir is fine — loader reports empty shared sections; Gemma still runs with just her persona + roster.

- [ ] **Step 1: Write failing tests**

Create `tests/persona.test.ts`:

```typescript
import { describe, test, beforeEach } from 'bun:test'
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

  test('uses default prompt + bot roster if everything missing', async () => {
    const loader = new PersonaLoader()
    await loader.load()
    const prompt = loader.buildSystemPrompt('unknown-channel-id')
    assert.ok(prompt.toLowerCase().includes('gemma'))
    assert.ok(prompt.includes('1492759800688152637'))  // Gemma's own ID
    assert.ok(prompt.includes('Fraggy'))              // roster entry
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
    await fs.writeFile(path.join(squadDir, 'memories', 'jeff_prefs.md'), 'Jeff likes dry humor.', 'utf8')
    await fs.writeFile(path.join(squadDir, 'memories', 'market_state.md'), 'Market is risk-off.', 'utf8')

    const loader = new PersonaLoader()
    await loader.load()
    const prompt = loader.buildSystemPrompt('c1')
    assert.ok(prompt.includes('Jeff likes dry humor.'))
    assert.ok(prompt.includes('Market is risk-off.'))
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

    // cron-driven summary rewrite between turns
    await fs.writeFile(path.join(squadDir, 'summaries', 'C1.md'), 'summary v2', 'utf8')
    assert.ok(loader.buildSystemPrompt('C1').includes('summary v2'))
  })
})
```

- [ ] **Step 2: Run — verify fail**

```bash
bun test tests/persona.test.ts
```

Expected: FAIL (module not found).

- [ ] **Step 3: Write src/persona.ts**

```typescript
import fs from 'fs/promises'
import fsSync from 'fs'
import path from 'path'
import os from 'os'

const DEFAULT_PERSONA = `You are Gemma, a Discord bot backed by Google's Gemini model. You are part of a small squad of AI bots in this server. Be helpful, concise, and match the channel's tone. You can respond with text, an emoji reaction, or both.`

const BOT_ROSTER = `## Other bots in the squad

You are Gemma — Discord user_id 1492759800688152637. When someone says "@Gemma" or tags your ID, they mean you.

Other members (do not impersonate them; respond as Gemma):
- MacClaude (Scott MacClaude) — user_id 1491304655152746517. Claude-backed, runs on Jeff's Mac. Scottish persona.
- Fraggy — user_id REDACTED_BOT_ID_A. Claude-backed, runs on HOST. West-Coast/PNW persona.
- Claudsson (assistant-b) — user_id REDACTED_BOT_ID_B. Claude-backed, runs on HOST. Norwegian fisherman-philosopher, bear case specialist.
- Claude总 — user_id 1493298328635703306. Claude-backed, runs on HOST. Chinese-native persona, family-warmth counterweight.

Bots do not @mention each other — if another bot is quoted in history, respond to Jeff, not to them.`

function stateDir(): string {
  return process.env.DISCORD_STATE_DIR || path.join(os.homedir(), '.gemini', 'channels', 'discord')
}

function squadDir(): string {
  return process.env.SQUAD_CONTEXT_DIR || path.join(os.homedir(), 'claude-agents', 'shared', 'squad-context')
}

export class PersonaLoader {
  private persona: string = DEFAULT_PERSONA
  private memories: string = ''

  async load(): Promise<void> {
    this.persona = await this.readPersona()
    this.memories = await this.readMemories()
  }

  private async readPersona(): Promise<string> {
    const file = path.join(stateDir(), 'persona.md')
    try {
      const text = (await fs.readFile(file, 'utf8')).trim()
      return text || DEFAULT_PERSONA
    } catch (e: any) {
      if (e.code === 'ENOENT') return DEFAULT_PERSONA
      throw e
    }
  }

  private async readMemories(): Promise<string> {
    const dir = path.join(squadDir(), 'memories')
    try {
      const entries = await fs.readdir(dir)
      const mdFiles = entries.filter(f => f.endsWith('.md')).sort()
      const bodies: string[] = []
      for (const f of mdFiles) {
        try {
          const body = (await fs.readFile(path.join(dir, f), 'utf8')).trim()
          if (body) bodies.push(`### ${f}\n${body}`)
        } catch { /* skip unreadable file */ }
      }
      return bodies.join('\n\n')
    } catch (e: any) {
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return ''
      throw e
    }
  }

  private readChannelSummary(channelId: string): string {
    const file = path.join(squadDir(), 'summaries', `${channelId}.md`)
    try {
      return fsSync.readFileSync(file, 'utf8').trim()
    } catch {
      return ''
    }
  }

  buildSystemPrompt(channelId: string): string {
    const summary = this.readChannelSummary(channelId)

    const sections: string[] = [this.persona, BOT_ROSTER]
    if (this.memories) {
      sections.push(`## Shared squad memories\n\n${this.memories}`)
    }
    if (summary) {
      sections.push(`## Current channel summary\n\n${summary}`)
    }
    return sections.join('\n\n---\n\n')
  }
}
```

- [ ] **Step 4: Run — verify pass**

```bash
bun test tests/persona.test.ts
```

Expected: all 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/persona.ts tests/persona.test.ts
git commit -m "feat: persona loader with shared squad context + per-channel summary"
```

---

## Task 5: history.ts — fetch + format last N messages

**Files:**
- Create: `src/history.ts`
- Create: `tests/history.test.ts`

### Design

`formatHistory(messages, selfId)` returns an array of Gemini `Content` items shaped as `{ role: 'user' | 'model', parts: [{ text }] }`. Messages authored by Gemma herself become `role: 'model'`; everyone else is `role: 'user'` prefixed with `Username: ` so the model knows who's who. Attachments in history are replaced by `[previous image]` etc.

We separate the fetch (hits Discord API) from the format (pure function) so format is cheaply testable.

- [ ] **Step 1: Write failing test**

Create `tests/history.test.ts`:

```typescript
import { describe, test } from 'bun:test'
import assert from 'node:assert/strict'
import { formatHistory, type HistoryMessage } from '../src/history.ts'

describe('formatHistory', () => {
  const SELF = 'bot-id-gemma'

  test('empty history returns empty array', () => {
    assert.deepEqual(formatHistory([], SELF), [])
  })

  test('formats user and bot messages with correct roles', () => {
    const msgs: HistoryMessage[] = [
      { authorId: 'U1', authorName: 'Jeff', content: 'hello', attachments: [] },
      { authorId: SELF, authorName: 'Gemma', content: 'hi there', attachments: [] },
      { authorId: 'U1', authorName: 'Jeff', content: 'how are you', attachments: [] }
    ]
    const result = formatHistory(msgs, SELF)
    assert.equal(result.length, 3)
    assert.equal(result[0].role, 'user')
    assert.equal(result[0].parts[0].text, 'Jeff: hello')
    assert.equal(result[1].role, 'model')
    assert.equal(result[1].parts[0].text, 'hi there')
    assert.equal(result[2].role, 'user')
    assert.equal(result[2].parts[0].text, 'Jeff: how are you')
  })

  test('references attachments in text without uploading', () => {
    const msgs: HistoryMessage[] = [
      {
        authorId: 'U1',
        authorName: 'Jeff',
        content: 'check this out',
        attachments: [{ name: 'chart.png', mimeType: 'image/png' }]
      }
    ]
    const result = formatHistory(msgs, SELF)
    assert.equal(result[0].parts[0].text, 'Jeff: check this out [previous image: chart.png]')
  })

  test('handles message with only attachment (no text)', () => {
    const msgs: HistoryMessage[] = [
      {
        authorId: 'U1',
        authorName: 'Jeff',
        content: '',
        attachments: [{ name: 'clip.mp4', mimeType: 'video/mp4' }]
      }
    ]
    const result = formatHistory(msgs, SELF)
    assert.equal(result[0].parts[0].text, 'Jeff: [previous video: clip.mp4]')
  })

  test('handles multiple attachments', () => {
    const msgs: HistoryMessage[] = [
      {
        authorId: 'U1',
        authorName: 'Jeff',
        content: 'screenshots',
        attachments: [
          { name: 'a.png', mimeType: 'image/png' },
          { name: 'b.png', mimeType: 'image/png' }
        ]
      }
    ]
    const result = formatHistory(msgs, SELF)
    assert.equal(
      result[0].parts[0].text,
      'Jeff: screenshots [previous image: a.png] [previous image: b.png]'
    )
  })
})
```

- [ ] **Step 2: Run — verify fail**

```bash
bun test tests/history.test.ts
```

Expected: FAIL (module not found).

- [ ] **Step 3: Write src/history.ts**

```typescript
import type { Message, TextChannel, DMChannel, ThreadChannel } from 'discord.js'

export interface HistoryAttachment {
  name: string
  mimeType: string | null
}

export interface HistoryMessage {
  authorId: string
  authorName: string
  content: string
  attachments: HistoryAttachment[]
}

export interface GeminiContent {
  role: 'user' | 'model'
  parts: { text: string }[]
}

const HISTORY_LIMIT = 20

export async function fetchHistory(
  channel: TextChannel | DMChannel | ThreadChannel,
  beforeMessageId: string
): Promise<HistoryMessage[]> {
  const fetched = await channel.messages.fetch({ limit: HISTORY_LIMIT, before: beforeMessageId })
  const arr: HistoryMessage[] = []
  for (const m of fetched.values()) {
    arr.push({
      authorId: m.author.id,
      authorName: m.author.username,
      content: m.content,
      attachments: [...m.attachments.values()].map(a => ({
        name: a.name,
        mimeType: a.contentType
      }))
    })
  }
  // Discord returns newest-first; reverse to chronological
  return arr.reverse()
}

function describeAttachment(att: HistoryAttachment): string {
  const mime = att.mimeType ?? ''
  const kind = mime.startsWith('image/') ? 'image'
    : mime.startsWith('video/') ? 'video'
    : mime.startsWith('audio/') ? 'audio'
    : 'file'
  return `[previous ${kind}: ${att.name}]`
}

export function formatHistory(messages: HistoryMessage[], selfId: string): GeminiContent[] {
  return messages.map(m => {
    const isSelf = m.authorId === selfId
    const attachmentText = m.attachments.map(describeAttachment).join(' ')
    let text: string
    if (isSelf) {
      text = [m.content, attachmentText].filter(Boolean).join(' ')
    } else {
      const body = [m.content, attachmentText].filter(Boolean).join(' ')
      text = `${m.authorName}: ${body}`
    }
    return { role: isSelf ? 'model' : 'user', parts: [{ text }] }
  })
}
```

- [ ] **Step 4: Run — verify pass**

```bash
bun test tests/history.test.ts
```

Expected: all 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/history.ts tests/history.test.ts
git commit -m "feat: history fetch + format for Gemini context"
```

---

## Task 6: attachments.ts — download, sniff, build inline parts

**Files:**
- Create: `src/attachments.ts`
- Create: `tests/attachments.test.ts`

### Design

- **Supported mime prefixes for v1:** `image/png`, `image/jpeg`, `image/webp`, `image/gif`.
- Size cap: 20 MB. Anything larger is rejected with `{ skipped: true, reason: 'too_large' }`.
- Unsupported mime: `{ skipped: true, reason: 'unsupported_type' }`.
- Downloaded bytes are written to `inbox/<messageId>/<filename>` under the state dir, so failures can be inspected post-hoc. Cleanup happens after the Gemini call in `gemma.ts`.
- Returns `{ parts: InlinePart[], skipped: SkippedAttachment[] }` so the caller can decide how to tell the user about skips.

- [ ] **Step 1: Write failing tests**

Create `tests/attachments.test.ts`:

```typescript
import { describe, test, beforeEach } from 'bun:test'
import assert from 'node:assert/strict'
import { processAttachments, type InputAttachment } from '../src/attachments.ts'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import http from 'http'

const testDir = path.join(os.tmpdir(), `gemma-attachments-test-${process.pid}`)

function startServer(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{ url: string, close: () => void }> {
  return new Promise(resolve => {
    const srv = http.createServer(handler)
    srv.listen(0, () => {
      const port = (srv.address() as any).port
      resolve({ url: `http://127.0.0.1:${port}`, close: () => srv.close() })
    })
  })
}

describe('processAttachments', () => {
  beforeEach(async () => {
    process.env.DISCORD_STATE_DIR = testDir
    await fs.rm(testDir, { recursive: true, force: true })
    await fs.mkdir(testDir, { recursive: true })
  })

  test('downloads and inlines a PNG', async () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const srv = await startServer((_, res) => { res.writeHead(200); res.end(pngBytes) })
    const input: InputAttachment[] = [{
      url: `${srv.url}/chart.png`,
      name: 'chart.png',
      size: pngBytes.length,
      contentType: 'image/png'
    }]
    const result = await processAttachments('msg1', input)
    srv.close()

    assert.equal(result.parts.length, 1)
    assert.equal(result.parts[0].inlineData.mimeType, 'image/png')
    assert.equal(Buffer.from(result.parts[0].inlineData.data, 'base64').toString('hex'), pngBytes.toString('hex'))
    assert.equal(result.skipped.length, 0)
  })

  test('skips oversized file', async () => {
    const srv = await startServer((_, res) => { res.writeHead(200); res.end('x') })
    const input: InputAttachment[] = [{
      url: `${srv.url}/huge.png`,
      name: 'huge.png',
      size: 25 * 1024 * 1024,
      contentType: 'image/png'
    }]
    const result = await processAttachments('msg2', input)
    srv.close()

    assert.equal(result.parts.length, 0)
    assert.equal(result.skipped.length, 1)
    assert.equal(result.skipped[0].reason, 'too_large')
  })

  test('skips unsupported mime', async () => {
    const srv = await startServer((_, res) => { res.writeHead(200); res.end('x') })
    const input: InputAttachment[] = [{
      url: `${srv.url}/doc.pdf`,
      name: 'doc.pdf',
      size: 1024,
      contentType: 'application/pdf'
    }]
    const result = await processAttachments('msg3', input)
    srv.close()

    assert.equal(result.parts.length, 0)
    assert.equal(result.skipped.length, 1)
    assert.equal(result.skipped[0].reason, 'unsupported_type')
  })

  test('cleanup removes message inbox dir', async () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    const srv = await startServer((_, res) => { res.writeHead(200); res.end(pngBytes) })
    const input: InputAttachment[] = [{
      url: `${srv.url}/a.png`,
      name: 'a.png',
      size: pngBytes.length,
      contentType: 'image/png'
    }]
    const { cleanup } = await processAttachments('msg4', input)
    const msgDir = path.join(testDir, 'inbox', 'msg4')
    await fs.access(msgDir)  // exists
    await cleanup()
    srv.close()
    await assert.rejects(() => fs.access(msgDir))
  })
})
```

- [ ] **Step 2: Run — verify fail**

```bash
bun test tests/attachments.test.ts
```

Expected: FAIL (module not found).

- [ ] **Step 3: Write src/attachments.ts**

```typescript
import fs from 'fs/promises'
import path from 'path'
import os from 'os'

const MAX_BYTES = 20 * 1024 * 1024
const ALLOWED_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

export interface InputAttachment {
  url: string
  name: string
  size: number
  contentType: string | null
}

export interface InlinePart {
  inlineData: { mimeType: string; data: string }
}

export interface SkippedAttachment {
  name: string
  reason: 'too_large' | 'unsupported_type' | 'download_failed'
}

export interface ProcessResult {
  parts: InlinePart[]
  skipped: SkippedAttachment[]
  cleanup: () => Promise<void>
}

function stateDir(): string {
  return process.env.DISCORD_STATE_DIR || path.join(os.homedir(), '.gemini', 'channels', 'discord')
}

export async function processAttachments(messageId: string, inputs: InputAttachment[]): Promise<ProcessResult> {
  const parts: InlinePart[] = []
  const skipped: SkippedAttachment[] = []
  const msgDir = path.join(stateDir(), 'inbox', messageId)

  if (inputs.length === 0) {
    return { parts, skipped, cleanup: async () => {} }
  }

  await fs.mkdir(msgDir, { recursive: true })

  for (const att of inputs) {
    const mime = att.contentType ?? ''
    if (!ALLOWED_IMAGE_MIMES.has(mime)) {
      skipped.push({ name: att.name, reason: 'unsupported_type' })
      continue
    }
    if (att.size > MAX_BYTES) {
      skipped.push({ name: att.name, reason: 'too_large' })
      continue
    }

    try {
      const res = await fetch(att.url)
      if (!res.ok) throw new Error(`status ${res.status}`)
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length > MAX_BYTES) {
        skipped.push({ name: att.name, reason: 'too_large' })
        continue
      }
      await fs.writeFile(path.join(msgDir, att.name), buf)
      parts.push({ inlineData: { mimeType: mime, data: buf.toString('base64') } })
    } catch (e) {
      skipped.push({ name: att.name, reason: 'download_failed' })
    }
  }

  return {
    parts,
    skipped,
    cleanup: async () => {
      await fs.rm(msgDir, { recursive: true, force: true })
    }
  }
}
```

- [ ] **Step 4: Run — verify pass**

```bash
bun test tests/attachments.test.ts
```

Expected: all 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/attachments.ts tests/attachments.test.ts
git commit -m "feat: attachment download, mime filter, inline parts for Gemini"
```

---

## Task 7: gemini.ts — API wrapper with structured response

**Files:**
- Create: `src/gemini.ts`
- Create: `tests/gemini.test.ts`

### Design

Two exports:
1. `parseResponse(text: string): { react: string | null, reply: string | null }` — pure function, easy to test with canned JSON strings.
2. `GeminiClient` — wraps `@google/generative-ai`, builds the request, calls the model, returns the parsed shape. We test `parseResponse` in isolation; the client's network call is exercised end-to-end in manual smoke tests (Task 10).

Response schema we pass to Gemini:

```json
{
  "type": "object",
  "properties": {
    "react": { "type": ["string", "null"] },
    "reply": { "type": ["string", "null"] }
  },
  "required": ["react", "reply"]
}
```

If the model returns malformed JSON (shouldn't happen with `responseMimeType: 'application/json'` + `responseSchema`, but belt + suspenders), `parseResponse` falls back to `{ react: null, reply: <raw text> }`.

- [ ] **Step 1: Write failing tests**

Create `tests/gemini.test.ts`:

```typescript
import { describe, test } from 'bun:test'
import assert from 'node:assert/strict'
import { parseResponse } from '../src/gemini.ts'

describe('parseResponse', () => {
  test('parses both fields', () => {
    const r = parseResponse('{"react":"🦆","reply":"hello"}')
    assert.equal(r.react, '🦆')
    assert.equal(r.reply, 'hello')
  })

  test('parses reply-only', () => {
    const r = parseResponse('{"react":null,"reply":"text"}')
    assert.equal(r.react, null)
    assert.equal(r.reply, 'text')
  })

  test('parses react-only', () => {
    const r = parseResponse('{"react":"👍","reply":null}')
    assert.equal(r.react, '👍')
    assert.equal(r.reply, null)
  })

  test('falls back to reply for malformed JSON', () => {
    const r = parseResponse('not json at all')
    assert.equal(r.react, null)
    assert.equal(r.reply, 'not json at all')
  })

  test('treats empty strings as null', () => {
    const r = parseResponse('{"react":"","reply":""}')
    assert.equal(r.react, null)
    assert.equal(r.reply, null)
  })

  test('ignores extra fields', () => {
    const r = parseResponse('{"react":"✅","reply":"ok","extra":"ignored"}')
    assert.equal(r.react, '✅')
    assert.equal(r.reply, 'ok')
  })
})
```

- [ ] **Step 2: Run — verify fail**

```bash
bun test tests/gemini.test.ts
```

Expected: FAIL (module not found).

- [ ] **Step 3: Write src/gemini.ts**

```typescript
import { GoogleGenerativeAI, type Content, type Part, SchemaType } from '@google/generative-ai'

export interface ParsedResponse {
  react: string | null
  reply: string | null
}

export function parseResponse(text: string): ParsedResponse {
  try {
    const obj = JSON.parse(text)
    const react = typeof obj.react === 'string' && obj.react.length > 0 ? obj.react : null
    const reply = typeof obj.reply === 'string' && obj.reply.length > 0 ? obj.reply : null
    return { react, reply }
  } catch {
    return { react: null, reply: text.trim() || null }
  }
}

export interface BuildRequestArgs {
  systemPrompt: string
  history: Content[]
  userMessageText: string
  userMediaParts: Part[]
  userName: string
}

export function buildUserTurn(args: BuildRequestArgs): Content {
  const textBody = `${args.userName}: ${args.userMessageText || '(no text)'}`
  const parts: Part[] = [{ text: textBody }, ...args.userMediaParts]
  return { role: 'user', parts }
}

export class GeminiClient {
  private model: ReturnType<GoogleGenerativeAI['getGenerativeModel']>

  constructor(apiKey: string, modelName: string = 'gemini-3.1-flash') {
    const genAI = new GoogleGenerativeAI(apiKey)
    this.model = genAI.getGenerativeModel({
      model: modelName,
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: SchemaType.OBJECT,
          properties: {
            react: { type: SchemaType.STRING, nullable: true },
            reply: { type: SchemaType.STRING, nullable: true }
          },
          required: ['react', 'reply']
        }
      }
    })
  }

  async respond(args: BuildRequestArgs): Promise<ParsedResponse> {
    const userTurn = buildUserTurn(args)
    const result = await this.model.generateContent({
      systemInstruction: { role: 'system', parts: [{ text: args.systemPrompt }] },
      contents: [...args.history, userTurn]
    })
    const text = result.response.text()
    return parseResponse(text)
  }
}
```

- [ ] **Step 4: Run — verify pass**

```bash
bun test tests/gemini.test.ts
```

Expected: all 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/gemini.ts tests/gemini.test.ts
git commit -m "feat: Gemini client with structured { react, reply } response"
```

---

## Task 8: gemma.ts — main entry, wire everything together

**Files:**
- Create: `src/gemma.ts`

No separate test — this is glue code; end-to-end verification happens in Task 10 (smoke test).

- [ ] **Step 1: Write src/gemma.ts**

```typescript
import { Client, GatewayIntentBits, Partials, type Message } from 'discord.js'
import fs from 'fs'
import path from 'path'
import os from 'os'
import dotenv from 'dotenv'
import { AccessManager } from './access.ts'
import { PersonaLoader } from './persona.ts'
import { fetchHistory, formatHistory } from './history.ts'
import { processAttachments, type InputAttachment } from './attachments.ts'
import { GeminiClient } from './gemini.ts'
import { chunk } from './chunk.ts'

const STATE_DIR = process.env.DISCORD_STATE_DIR || path.join(os.homedir(), '.gemini', 'channels', 'discord')
dotenv.config({ path: path.join(STATE_DIR, '.env') })

const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN
const GEMINI_API_KEY = process.env.GEMINI_API_KEY
const MODEL_NAME = process.env.GEMINI_MODEL || 'gemini-3.1-flash'

if (!DISCORD_TOKEN) {
  console.error(`FATAL: DISCORD_BOT_TOKEN missing. Set in ${path.join(STATE_DIR, '.env')}`)
  process.exit(1)
}
if (!GEMINI_API_KEY) {
  console.error(`FATAL: GEMINI_API_KEY missing. Set in ${path.join(STATE_DIR, '.env')}`)
  process.exit(1)
}

const access = new AccessManager()
const persona = new PersonaLoader()
const gemini = new GeminiClient(GEMINI_API_KEY, MODEL_NAME)

await access.load()
await persona.load()

process.on('SIGHUP', async () => {
  console.error('SIGHUP received — reloading access.json and persona.md')
  try {
    await access.load()
    await persona.load()
    console.error('reload complete')
  } catch (e) {
    console.error('reload failed:', e)
  }
})

process.on('unhandledRejection', err => console.error('unhandledRejection:', err))
process.on('uncaughtException', err => console.error('uncaughtException:', err))

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel, Partials.Message]
})

client.once('ready', () => {
  console.error(`Gemma online as ${client.user?.tag} (${client.user?.id})`)
})

client.on('messageCreate', async (message: Message) => {
  if (message.author.bot) return
  if (!client.user) return

  const isMention = message.mentions.users.has(client.user.id)
  const gate = access.canHandle({
    channelId: message.channelId,
    userId: message.author.id,
    isMention
  })
  if (!gate) return

  try {
    const [history, attachmentResult] = await Promise.all([
      fetchHistory(message.channel as any, message.id).then(msgs => formatHistory(msgs, client.user!.id)),
      processAttachments(
        message.id,
        [...message.attachments.values()].map<InputAttachment>(a => ({
          url: a.url,
          name: a.name,
          size: a.size,
          contentType: a.contentType
        }))
      )
    ])

    // Tell user about skipped attachments, but still proceed with whatever survived
    if (attachmentResult.skipped.length > 0) {
      const notes = attachmentResult.skipped.map(s => `- ${s.name}: ${s.reason}`).join('\n')
      await message.reply({
        content: `skipped some attachments:\n${notes}`,
        allowedMentions: { repliedUser: false }
      })
    }

    const parsed = await gemini.respond({
      systemPrompt: persona.buildSystemPrompt(message.channelId),
      history,
      userMessageText: message.content,
      userMediaParts: attachmentResult.parts,
      userName: message.author.username
    })

    const tasks: Promise<unknown>[] = []

    if (parsed.react) {
      tasks.push(message.react(parsed.react).catch(e => console.error('react failed:', e)))
    }

    if (parsed.reply) {
      const pieces = chunk(parsed.reply, 2000, 'newline')
      for (const piece of pieces) {
        tasks.push(message.channel.send({
          content: piece,
          allowedMentions: { repliedUser: false }
        }).catch(e => console.error('send failed:', e)))
      }
    }

    await Promise.all(tasks)
    await attachmentResult.cleanup()

  } catch (e: any) {
    console.error('message handler error:', e)
    const isRateLimit = e?.status === 429 || /rate/i.test(String(e?.message || ''))
    const msg = isRateLimit
      ? "hitting Gemini's rate limit — give me a minute"
      : "something broke reaching Gemini. check logs."
    try {
      await message.reply({ content: msg, allowedMentions: { repliedUser: false } })
    } catch { /* nothing to do */ }
  }
})

await client.login(DISCORD_TOKEN)
```

- [ ] **Step 2: Type-check**

```bash
bun tsc --noEmit
```

Expected: no errors. If there are errors about `message.channel` not having `messages.fetch`, the cast `as any` handles it — discord.js's channel union type is narrow; in practice `GuildText`, `DM`, and thread channels all expose `messages.fetch`.

- [ ] **Step 3: Commit**

```bash
git add src/gemma.ts
git commit -m "feat: gemma entrypoint — discord client wired to access, gemini, chunk"
```

---

## Task 9: README rewrite

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Replace README.md**

```markdown
# Gemma

A standalone Discord bot backed by Google's Gemini. Runs as a Bun process, one event loop, one purpose: respond to allowlisted messages in allowlisted channels.

## Why not MCP?

An earlier version of this repo tried to be a Gemini-CLI MCP plugin. It didn't work: Gemini CLI has no push-event ingestion pathway, so there was no way for Discord messages to reach the model unprompted. Rebuilt as a standalone daemon instead — see `docs/superpowers/specs/2026-04-16-gemma-standalone-bot-design.md`.

## Stack

- TypeScript + Bun 1.x
- `discord.js` v14
- `@google/generative-ai` (Gemini 3.1 Flash by default)

## State directory

All runtime state lives in `~/.gemini/channels/discord/`:

- `.env` — `DISCORD_BOT_TOKEN`, `GEMINI_API_KEY`, optional `GEMINI_MODEL`
- `access.json` — allowlists (users + channels); see format below
- `persona.md` — system prompt (optional; built-in default if missing)
- `inbox/` — per-message attachment scratch dir (auto-cleaned)

### access.json format

```json
{
  "users": {
    "<discord_user_id>": { "allowed": true }
  },
  "channels": {
    "<channel_id>": { "enabled": true, "requireMention": false }
  }
}
```

Edits are picked up on `SIGHUP` — no restart needed:

```bash
kill -HUP $(pgrep -f 'bun src/gemma.ts')
```

## Running locally

```bash
bun install
mkdir -p ~/.gemini/channels/discord
cat > ~/.gemini/channels/discord/.env <<EOF
DISCORD_BOT_TOKEN=...
GEMINI_API_KEY=...
EOF
bun src/gemma.ts
```

## Deployment (HOST)

See `docs/superpowers/specs/2026-04-16-gemma-standalone-bot-design.md` §Deployment. systemd user service at `~/.config/systemd/user/gemma.service`.

## Tests

```bash
bun test
```
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: rewrite README for standalone-bot architecture"
```

---

## Task 10: Local smoke test (manual verification before deploying)

No code changes. This task verifies the bot actually runs and responds in Discord before we touch HOST.

- [ ] **Step 1: Prepare local state dir**

```bash
mkdir -p ~/.gemini/channels/discord
cat > ~/.gemini/channels/discord/.env <<'EOF'
DISCORD_BOT_TOKEN=<paste-gemma-token>
GEMINI_API_KEY=<paste-ai-studio-key>
EOF
chmod 600 ~/.gemini/channels/discord/.env
```

- [ ] **Step 2: Write access.json**

Fill in with Jeff's Discord user ID and at least one channel ID. Get user ID from `/Users/user/.claude/projects/-Users-jeffbai-repos/memory/reference_discord_bots.md` (channel IDs are listed there too — use a test-only channel for smoke test; the private channel is a safe choice).

```bash
cat > ~/.gemini/channels/discord/access.json <<'EOF'
{
  "users": {
    "<jeff_user_id>": { "allowed": true }
  },
  "channels": {
    "<test_channel_id>": { "enabled": true, "requireMention": true }
  }
}
EOF
```

- [ ] **Step 3: Run the bot**

```bash
cd ~/repos/discord-mcp
bun src/gemma.ts
```

Expected stderr: `Gemma online as Gemma#XXXX (<bot-id>)`.

- [ ] **Step 4: Send a test message in Discord**

In the configured test channel: `@Gemma say hi`.

Expected: Gemma posts a reply within ~3-5 seconds.

- [ ] **Step 5: Send an image**

Drop a PNG in the channel with caption `@Gemma what's in this image?`.

Expected: Gemma describes the image content.

- [ ] **Step 6: Test SIGHUP reload**

While the bot runs, edit `access.json` (e.g., flip `requireMention` to `false`), then in another terminal:

```bash
kill -HUP $(pgrep -f 'bun src/gemma.ts')
```

Expected stderr: `SIGHUP received — reloading access.json and persona.md\nreload complete`.

Send a message without `@Gemma` — bot should now respond.

- [ ] **Step 7: Stop the bot**

Ctrl+C the bot. No commit — this task was verification only.

---

## Task 11: Deploy to HOST

**Files:**
- Create (on HOST): `~/.config/systemd/user/gemma.service`
- Create (on HOST): `~/.gemini/channels/discord/.env`, `access.json`

- [ ] **Step 1: Push local repo**

```bash
cd ~/repos/discord-mcp
git push origin main
```

- [ ] **Step 2: Clone/pull on HOST**

```bash
ssh <deploy-user>@<deploy-host> 'wsl -u jbai -e bash -lc "cd ~/repos && (test -d discord-mcp || git clone git@github.com:jeffbai996/discord-mcp.git) && cd discord-mcp && git pull && bun install"'
```

Expected: no errors, `bun.lockb` present, `node_modules` populated.

- [ ] **Step 3: Create state dir + secrets on HOST**

```bash
ssh <deploy-user>@<deploy-host> 'wsl -u jbai -e bash -lc "mkdir -p ~/.gemini/channels/discord && chmod 700 ~/.gemini/channels/discord"'
```

Then manually (interactively — don't commit tokens to anywhere) populate `.env`:

```bash
ssh <deploy-user>@<deploy-host> 'wsl -u jbai -e bash -lc "cat > ~/.gemini/channels/discord/.env"'
# paste:
# DISCORD_BOT_TOKEN=...
# GEMINI_API_KEY=...
# (Ctrl+D)
ssh <deploy-user>@<deploy-host> 'wsl -u jbai -e bash -lc "chmod 600 ~/.gemini/channels/discord/.env"'
```

And `access.json`:

```bash
ssh <deploy-user>@<deploy-host> 'wsl -u jbai -e bash -lc "cat > ~/.gemini/channels/discord/access.json"'
# paste the real allowlist json, then Ctrl+D
```

- [ ] **Step 4: Install systemd user unit**

On HOST:

```bash
ssh <deploy-user>@<deploy-host> 'wsl -u jbai -e bash -lc "mkdir -p ~/.config/systemd/user && cat > ~/.config/systemd/user/gemma.service <<EOF
[Unit]
Description=Gemma — Gemini Discord bot
After=network-online.target

[Service]
Type=simple
Environment=SQUAD_CONTEXT_DIR=<your-shared-context-dir>
WorkingDirectory=<your-mcp-repo>
ExecStart=~/.bun/bin/bun src/gemma.ts
Restart=always
RestartSec=10
StandardOutput=append:~/.gemini/channels/discord/gemma.log
StandardError=append:~/.gemini/channels/discord/gemma.log

[Install]
WantedBy=default.target
EOF"'
```

- [ ] **Step 5: Enable lingering (survives logout), reload systemd, enable service**

```bash
ssh <deploy-user>@<deploy-host> 'wsl -u jbai -e bash -lc "sudo loginctl enable-linger jbai"'
ssh <deploy-user>@<deploy-host> 'wsl -u jbai -e bash -lc "systemctl --user daemon-reload && systemctl --user enable --now gemma"'
```

- [ ] **Step 6: Verify running**

```bash
ssh <deploy-user>@<deploy-host> 'wsl -u jbai -e bash -lc "systemctl --user status gemma --no-pager"'
```

Expected: `active (running)`.

```bash
ssh <deploy-user>@<deploy-host> 'wsl -u jbai -e bash -lc "tail -20 ~/.gemini/channels/discord/gemma.log"'
```

Expected: `Gemma online as ...`.

- [ ] **Step 7: Send Discord test message**

In the configured channel, @Gemma. Expected: reply within a few seconds.

- [ ] **Step 8: Final commit**

Nothing committed in this task — it's all ops. If you hit any issues that required code changes in gemma.ts, commit those as a follow-up fix and `systemctl --user restart gemma` on HOST.

---

## Self-Review

**1. Spec coverage:**

| Spec section | Task(s) |
|---|---|
| Why standalone / Runtime & Stack | Tasks 1, 2 |
| Architecture (flow diagram) | Task 8 (integration), supported by 3-7 |
| Access Control (no pairing, manual edits) | Task 3 |
| Multimodal (images only v1, 20MB cap) | Task 6 |
| Emoji Reactions (structured {react,reply}) | Task 7 |
| System Prompt & Persona (persona.md + shared squad context, NOT other bots' personas) | Task 4, SIGHUP + SQUAD_CONTEXT_DIR in Task 8 & 11 |
| Error Handling (429, API failures, unhandled rejections) | Task 8 (try/catch + process handlers) |
| State directory layout | Task 10 (local setup), Task 11 (HOST) |
| systemd user service | Task 11 |
| Deployment flow (push → pull → restart) | Task 11 |
| File inventory | Tasks 1, 3-8 |

All spec sections have tasks.

**2. Placeholder scan:** no TBDs; all code is complete and runnable. User/channel IDs in Tasks 10 & 11 reference the memory file with instructions to fill in actual values from there.

**3. Type consistency:**
- `AccessManager.canHandle` takes `{ channelId, userId, isMention }` everywhere (access.test.ts, gemma.ts). ✓
- `HistoryMessage` / `formatHistory` / `fetchHistory` signatures consistent between Task 5 and Task 8. ✓
- `ProcessResult.parts` and `InlinePart` consumed in Task 8 matches Task 6 definition. ✓
- `ParsedResponse { react, reply }` consistent Task 7 ↔ Task 8. ✓
- `GeminiClient.respond({ systemPrompt, history, userMessageText, userMediaParts, userName })` — shape consistent between Task 7 definition and Task 8 call site. ✓

**4. Scope:** single focused plan — one repo, one service, one system. No subsystem decomposition needed.

No issues found.
