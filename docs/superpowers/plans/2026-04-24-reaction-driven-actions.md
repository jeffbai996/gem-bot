# Reaction-Driven Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Implement 7-emoji reaction vocabulary (🔁 🔍 📌 ❌ 🔇 🔊 ✏️) on bot messages, with pinned-facts injected into system prompt and a refactored message-handling pipeline supporting edit-in-place and expansion modes.

**Spec:** `docs/superpowers/specs/2026-04-24-reaction-driven-actions-design.md`

**Tech Stack:** TypeScript, Node.js via tsx, discord.js, `node:test`.

---

## File Structure

**New:**
- `src/reactions/vocabulary.ts` — emoji → action map.
- `src/reactions/pending-edits.ts` — TTL store for ✏️.
- `src/reactions/actions.ts` — one function per action.
- `src/reactions/handler.ts` — messageReactionAdd handler.
- `src/pinned-facts.ts` — append/read pinned facts.
- `tests/reactions/{vocabulary,pending-edits,actions,handler}.test.ts`
- `tests/pinned-facts.test.ts`

**Modified:**
- `src/access.ts` — add `canReact()` method.
- `src/persona.ts` — `buildSystemPrompt` includes pinned facts.
- `src/gemma.ts` — intents, extract `handleUserMessage`, pending-edit check, reaction listener.

---

## Task 1: Vocabulary

**Files:** `src/reactions/vocabulary.ts`, `tests/reactions/vocabulary.test.ts`

- [ ] **Step 1: Write tests**

Create `tests/reactions/vocabulary.test.ts`:

```typescript
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { actionFor, REACTION_ACTIONS } from '../../src/reactions/vocabulary.ts'

describe('actionFor', () => {
  test('all 7 emojis map correctly', () => {
    assert.equal(actionFor('🔁'), 'regenerate')
    assert.equal(actionFor('🔍'), 'expand')
    assert.equal(actionFor('📌'), 'pin')
    assert.equal(actionFor('❌'), 'delete')
    assert.equal(actionFor('🔇'), 'mute')
    assert.equal(actionFor('🔊'), 'unmute')
    assert.equal(actionFor('✏️'), 'markForEdit')
  })

  test('unknown emoji returns null', () => {
    assert.equal(actionFor('🤣'), null)
    assert.equal(actionFor('🐻'), null)
    assert.equal(actionFor(''), null)
  })

  test('REACTION_ACTIONS has exactly 7 entries', () => {
    assert.equal(Object.keys(REACTION_ACTIONS).length, 7)
  })
})
```

- [ ] **Step 2: Run — expect fail (module missing)**

Run: `npm run test -- 'tests/reactions/vocabulary.test.ts'`
Expected: module not found.

- [ ] **Step 3: Implement**

Create `src/reactions/vocabulary.ts`:

```typescript
export type ReactionAction =
  | 'regenerate' | 'expand' | 'pin' | 'delete'
  | 'mute' | 'unmute' | 'markForEdit'

export const REACTION_ACTIONS: Record<string, ReactionAction> = {
  '🔁': 'regenerate',
  '🔍': 'expand',
  '📌': 'pin',
  '❌': 'delete',
  '🔇': 'mute',
  '🔊': 'unmute',
  '✏️': 'markForEdit'
}

export function actionFor(emoji: string): ReactionAction | null {
  return REACTION_ACTIONS[emoji] ?? null
}
```

- [ ] **Step 4: Run — pass; commit**

```bash
npm run test -- 'tests/reactions/vocabulary.test.ts'
git add src/reactions/vocabulary.ts tests/reactions/vocabulary.test.ts
git commit -m "feat: reaction emoji → action vocabulary"
```

---

## Task 2: Pending-edits store

**Files:** `src/reactions/pending-edits.ts`, `tests/reactions/pending-edits.test.ts`

- [ ] **Step 1: Write tests**

Create `tests/reactions/pending-edits.test.ts`:

```typescript
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { PendingEditsStore } from '../../src/reactions/pending-edits.ts'

describe('PendingEditsStore', () => {
  test('set + get returns the bot message id', () => {
    const s = new PendingEditsStore()
    s.set('C1', 'M1', 60_000)
    assert.equal(s.get('C1'), 'M1')
  })

  test('get after ttl expiry returns null', () => {
    const s = new PendingEditsStore()
    s.set('C1', 'M1', -1)  // already expired
    assert.equal(s.get('C1'), null)
  })

  test('expired entry is removed lazily', () => {
    const s = new PendingEditsStore()
    s.set('C1', 'M1', -1)
    s.get('C1')  // triggers eviction
    // Setting again should work clean
    s.set('C1', 'M2', 60_000)
    assert.equal(s.get('C1'), 'M2')
  })

  test('clear removes entry', () => {
    const s = new PendingEditsStore()
    s.set('C1', 'M1', 60_000)
    s.clear('C1')
    assert.equal(s.get('C1'), null)
  })

  test('different channels are independent', () => {
    const s = new PendingEditsStore()
    s.set('C1', 'M1', 60_000)
    s.set('C2', 'M2', 60_000)
    assert.equal(s.get('C1'), 'M1')
    assert.equal(s.get('C2'), 'M2')
  })

  test('get on never-set channel returns null', () => {
    const s = new PendingEditsStore()
    assert.equal(s.get('nope'), null)
  })
})
```

- [ ] **Step 2: Run — fail**

Run: `npm run test -- 'tests/reactions/pending-edits.test.ts'`

- [ ] **Step 3: Implement**

Create `src/reactions/pending-edits.ts`:

```typescript
interface PendingEdit {
  botMessageId: string
  expiresAt: number
}

export class PendingEditsStore {
  private map = new Map<string, PendingEdit>()

  set(channelId: string, botMessageId: string, ttlMs: number = 5 * 60 * 1000): void {
    this.map.set(channelId, { botMessageId, expiresAt: Date.now() + ttlMs })
  }

  get(channelId: string): string | null {
    const entry = this.map.get(channelId)
    if (!entry) return null
    if (Date.now() >= entry.expiresAt) {
      this.map.delete(channelId)
      return null
    }
    return entry.botMessageId
  }

  clear(channelId: string): void {
    this.map.delete(channelId)
  }
}
```

- [ ] **Step 4: Pass + commit**

```bash
npm run test -- 'tests/reactions/pending-edits.test.ts'
git add src/reactions/pending-edits.ts tests/reactions/pending-edits.test.ts
git commit -m "feat: PendingEditsStore for ✏️ edit-on-next-reply marker"
```

---

## Task 3: Pinned-facts store + persona integration

**Files:** `src/pinned-facts.ts`, `src/persona.ts`, `tests/pinned-facts.test.ts`

- [ ] **Step 1: Write tests**

Create `tests/pinned-facts.test.ts`:

```typescript
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

  test('long content truncates to 1500 chars', async () => {
    const file = await tmp()
    const s = new PinnedFactsStore(file)
    const long = 'x'.repeat(2000)
    await s.append('C1', '#a', long)
    const content = await fs.readFile(file, 'utf8')
    // Find the bullet line
    const line = content.split('\n').find(l => l.startsWith('- ['))!
    assert.ok(line.endsWith('...'), 'truncated with ellipsis')
    assert.ok(line.length < 1600)  // 1500 + timestamp + bullet prefix
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
})
```

- [ ] **Step 2: Run — fail**

- [ ] **Step 3: Implement**

Create `src/pinned-facts.ts`:

```typescript
import fs from 'fs/promises'
import fsSync from 'fs'

const MAX_FACT_LEN = 1500

export interface PinnedFact {
  timestamp: string
  content: string
}

export class PinnedFactsStore {
  constructor(private file: string) {}

  async append(channelId: string, channelName: string, content: string): Promise<void> {
    const truncated = content.length > MAX_FACT_LEN
      ? content.slice(0, MAX_FACT_LEN) + '...'
      : content
    const line = `- [${new Date().toISOString()}] ${truncated.replace(/\n+/g, ' ')}`

    let body = ''
    try { body = await fs.readFile(this.file, 'utf8') } catch { /* new file */ }

    const sectionHeader = `## ${channelId} — ${channelName}`
    if (body.includes(sectionHeader)) {
      // Append after the existing section header / its bullets
      const lines = body.split('\n')
      const idx = lines.findIndex(l => l === sectionHeader)
      // Find end of this section (next "## " or end)
      let end = idx + 1
      while (end < lines.length && !lines[end].startsWith('## ')) end++
      // Insert before end
      lines.splice(end, 0, line)
      body = lines.join('\n')
    } else {
      // Append a new section
      if (body && !body.endsWith('\n')) body += '\n'
      if (body) body += '\n'
      body += `${sectionHeader}\n\n${line}\n`
    }
    await fs.writeFile(this.file, body, 'utf8')
  }

  async readForChannel(channelId: string): Promise<PinnedFact[]> {
    let body: string
    try { body = await fs.readFile(this.file, 'utf8') } catch { return [] }
    const lines = body.split('\n')
    const headerRegex = new RegExp(`^## ${channelId} — `)
    const idx = lines.findIndex(l => headerRegex.test(l))
    if (idx === -1) return []
    const out: PinnedFact[] = []
    for (let i = idx + 1; i < lines.length; i++) {
      if (lines[i].startsWith('## ')) break
      const m = lines[i].match(/^- \[([^\]]+)\] (.*)$/)
      if (m) out.push({ timestamp: m[1], content: m[2] })
    }
    return out
  }

  // Sync read for system-prompt assembly. Returns the markdown body for a
  // channel (without the section header) or empty string.
  readForChannelSync(channelId: string): string {
    let body: string
    try { body = fsSync.readFileSync(this.file, 'utf8') } catch { return '' }
    const lines = body.split('\n')
    const headerRegex = new RegExp(`^## ${channelId} — `)
    const idx = lines.findIndex(l => headerRegex.test(l))
    if (idx === -1) return ''
    const out: string[] = []
    for (let i = idx + 1; i < lines.length; i++) {
      if (lines[i].startsWith('## ')) break
      if (lines[i].trim()) out.push(lines[i])
    }
    return out.join('\n').trim()
  }
}
```

- [ ] **Step 4: Pass tests, commit**

```bash
npm run test -- 'tests/pinned-facts.test.ts'
git add src/pinned-facts.ts tests/pinned-facts.test.ts
git commit -m "feat: PinnedFactsStore — append/read per-channel pinned facts"
```

- [ ] **Step 5: Integrate into PersonaLoader**

Modify `src/persona.ts`:

Add field + setter:
```typescript
import { PinnedFactsStore } from './pinned-facts.ts'

export class PersonaLoader {
  // … existing fields …
  private pinnedFacts: PinnedFactsStore | null = null

  setPinnedFactsStore(store: PinnedFactsStore): void {
    this.pinnedFacts = store
  }
  // … existing methods …
}
```

Update `buildSystemPrompt`:
```typescript
buildSystemPrompt(channelId: string): string {
  const summary = this.readChannelSummary(channelId)
  const pinned = this.pinnedFacts?.readForChannelSync(channelId) ?? ''

  const sections: string[] = [this.persona]
  if (this.memories) {
    sections.push(`## Shared squad memories\n\n${this.memories}`)
  }
  if (summary) {
    sections.push(`## Current channel summary\n\n${summary}`)
  }
  if (pinned) {
    sections.push(`## Pinned facts for this channel\n\n${pinned}`)
  }
  return sections.join('\n\n---\n\n')
}
```

Run: `npm run test`
Expected: persona tests still pass (we didn't change observable defaults).

```bash
git add src/persona.ts
git commit -m "feat: persona system prompt includes pinned facts when set"
```

---

## Task 4: AccessManager.canReact

**Files:** `src/access.ts`, `tests/access.test.ts`

- [ ] **Step 1: Add method to AccessManager**

In `src/access.ts`, add inside the class:

```typescript
canReact(userId: string, channelId: string): boolean {
  const user = this.data.users[userId]
  if (!user?.allowed) return false
  const channel = this.data.channels[channelId]
  if (!channel?.enabled) return false
  return true
}
```

- [ ] **Step 2: Add tests**

Append to `tests/access.test.ts` inside an existing describe or a new one:

```typescript
describe('canReact', () => {
  test('allowed user in enabled channel can react', async () => {
    const a = new AccessManager()
    await a.load()
    await a.allowUser('U1')
    await a.setChannel('C1', true, false)
    assert.equal(a.canReact('U1', 'C1'), true)
  })

  test('not-allowed user cannot react', async () => {
    const a = new AccessManager()
    await a.load()
    await a.setChannel('C1', true, false)
    assert.equal(a.canReact('U1', 'C1'), false)
  })

  test('disabled channel blocks reaction', async () => {
    const a = new AccessManager()
    await a.load()
    await a.allowUser('U1')
    await a.setChannel('C1', false, false)
    assert.equal(a.canReact('U1', 'C1'), false)
  })

  test('require-mention setting does not affect canReact', async () => {
    const a = new AccessManager()
    await a.load()
    await a.allowUser('U1')
    await a.setChannel('C1', true, true)  // requireMention=true
    assert.equal(a.canReact('U1', 'C1'), true)
  })
})
```

- [ ] **Step 3: Run + commit**

```bash
npm run test -- 'tests/access.test.ts'
git add src/access.ts tests/access.test.ts
git commit -m "feat: AccessManager.canReact for reaction permission gate"
```

---

## Task 5: Action functions (low-blast subset: pin, delete, mute, unmute, markForEdit)

These don't depend on the rerunHandler refactor. Building first lets us land them safely.

**Files:** `src/reactions/actions.ts`, `tests/reactions/actions.test.ts`

- [ ] **Step 1: Define ActionContext and stub regenerate/expand**

Create `src/reactions/actions.ts`:

```typescript
import type { Message, User, Client } from 'discord.js'
import type { GeminiClient } from '../gemini.ts'
import type { AccessManager } from '../access.ts'
import type { PersonaLoader } from '../persona.ts'
import type { PendingEditsStore } from './pending-edits.ts'
import type { PinnedFactsStore } from '../pinned-facts.ts'

export interface ActionContext {
  message: Message
  reactor: User
  client: Client
  gemini: GeminiClient
  access: AccessManager
  persona: PersonaLoader
  pendingEdits: PendingEditsStore
  pinnedFacts: PinnedFactsStore
  rerunHandler: (
    originalUserMessage: Message,
    targetMessage: Message | null,
    expansion: boolean
  ) => Promise<void>
}

export async function pin(ctx: ActionContext): Promise<void> {
  const channelName = (ctx.message.channel as any).name ?? 'dm'
  await ctx.pinnedFacts.append(ctx.message.channelId, channelName, ctx.message.content)
  await ctx.message.react('✅').catch(() => {})
}

export async function deleteMessage(ctx: ActionContext): Promise<void> {
  await ctx.message.delete().catch(e => console.error('[reactions] delete failed:', e))
}

export async function mute(ctx: ActionContext): Promise<void> {
  const flags = ctx.access.channelFlags(ctx.message.channelId)
  await ctx.access.setChannel(ctx.message.channelId, true, true, flags)
  await ctx.message.react('🤐').catch(() => {})
}

export async function unmute(ctx: ActionContext): Promise<void> {
  const flags = ctx.access.channelFlags(ctx.message.channelId)
  await ctx.access.setChannel(ctx.message.channelId, true, false, flags)
  await ctx.message.react('🗣️').catch(() => {})
}

export async function markForEdit(ctx: ActionContext): Promise<void> {
  ctx.pendingEdits.set(ctx.message.channelId, ctx.message.id)
  await ctx.message.react('⏳').catch(() => {})
}

export async function regenerate(ctx: ActionContext): Promise<void> {
  const original = await ctx.message.fetchReference().catch(() => null)
  if (!original) {
    await ctx.message.react('🤷').catch(() => {})
    return
  }
  await ctx.rerunHandler(original, ctx.message, false)
}

export async function expand(ctx: ActionContext): Promise<void> {
  const original = await ctx.message.fetchReference().catch(() => null)
  if (!original) {
    await ctx.message.react('🤷').catch(() => {})
    return
  }
  await ctx.rerunHandler(original, null, true)
}
```

- [ ] **Step 2: Write tests for low-blast actions**

Create `tests/reactions/actions.test.ts`:

```typescript
import { describe, test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { pin, deleteMessage, mute, unmute, markForEdit, regenerate, expand } from '../../src/reactions/actions.ts'
import { PendingEditsStore } from '../../src/reactions/pending-edits.ts'
import { PinnedFactsStore } from '../../src/pinned-facts.ts'

interface FakeMessage {
  channelId: string
  id: string
  content: string
  channel: { name?: string }
  reactions: string[]
  deleted: boolean
  fetchReferenceResult: any
  reactionsAdded: string[]
  edits: string[]
}

function makeMessage(overrides: Partial<FakeMessage> = {}): any {
  const reactionsAdded: string[] = []
  const m: any = {
    channelId: 'C1',
    id: 'M1',
    content: 'hello',
    channel: { name: 'general' },
    reactionsAdded,
    react: async (emoji: string) => { reactionsAdded.push(emoji); return null },
    delete: async () => { (m as any).deleted = true },
    fetchReference: async () => overrides.fetchReferenceResult ?? null,
    deleted: false,
    ...overrides
  }
  return m
}

function makeAccess() {
  const calls: any[] = []
  return {
    calls,
    channelFlags: () => ({ thinking: 'auto', showCode: false }),
    setChannel: async (channelId: string, enabled: boolean, requireMention: boolean, flags: any) => {
      calls.push({ channelId, enabled, requireMention, flags })
    }
  } as any
}

async function tmpFactsFile() {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'actions-test-'))
  return path.join(d, 'pinned.md')
}

describe('pin', () => {
  test('appends to pinned facts and reacts ✅', async () => {
    const file = await tmpFactsFile()
    const facts = new PinnedFactsStore(file)
    const message = makeMessage({ content: 'pinned content' })
    await pin({ message, pinnedFacts: facts } as any)
    const got = await facts.readForChannel('C1')
    assert.equal(got.length, 1)
    assert.equal(got[0].content, 'pinned content')
    assert.deepEqual(message.reactionsAdded, ['✅'])
  })
})

describe('deleteMessage', () => {
  test('calls message.delete', async () => {
    const message = makeMessage()
    await deleteMessage({ message } as any)
    assert.equal(message.deleted, true)
  })
})

describe('mute', () => {
  test('calls setChannel with requireMention=true', async () => {
    const access = makeAccess()
    const message = makeMessage()
    await mute({ message, access } as any)
    assert.equal(access.calls.length, 1)
    assert.equal(access.calls[0].requireMention, true)
    assert.deepEqual(message.reactionsAdded, ['🤐'])
  })
})

describe('unmute', () => {
  test('calls setChannel with requireMention=false', async () => {
    const access = makeAccess()
    const message = makeMessage()
    await unmute({ message, access } as any)
    assert.equal(access.calls.length, 1)
    assert.equal(access.calls[0].requireMention, false)
    assert.deepEqual(message.reactionsAdded, ['🗣️'])
  })
})

describe('markForEdit', () => {
  test('writes pending-edits entry and reacts ⏳', async () => {
    const pendingEdits = new PendingEditsStore()
    const message = makeMessage()
    await markForEdit({ message, pendingEdits } as any)
    assert.equal(pendingEdits.get('C1'), 'M1')
    assert.deepEqual(message.reactionsAdded, ['⏳'])
  })
})

describe('regenerate', () => {
  test('no reference → reacts 🤷, no rerun', async () => {
    const message = makeMessage({ fetchReferenceResult: null })
    let rerunCalled = false
    const ctx = {
      message,
      rerunHandler: async () => { rerunCalled = true }
    } as any
    await regenerate(ctx)
    assert.equal(rerunCalled, false)
    assert.deepEqual(message.reactionsAdded, ['🤷'])
  })

  test('with reference → calls rerunHandler with editTarget=message, expansion=false', async () => {
    const ref = { id: 'U1', content: 'original prompt' }
    const message = makeMessage({ fetchReferenceResult: ref })
    let captured: any = null
    const ctx = {
      message,
      rerunHandler: async (orig: any, target: any, expansion: any) => {
        captured = { orig, target, expansion }
      }
    } as any
    await regenerate(ctx)
    assert.equal(captured.orig, ref)
    assert.equal(captured.target, message)
    assert.equal(captured.expansion, false)
  })
})

describe('expand', () => {
  test('with reference → rerunHandler with target=null, expansion=true', async () => {
    const ref = { id: 'U1', content: 'original' }
    const message = makeMessage({ fetchReferenceResult: ref })
    let captured: any = null
    const ctx = {
      message,
      rerunHandler: async (orig: any, target: any, expansion: any) => {
        captured = { orig, target, expansion }
      }
    } as any
    await expand(ctx)
    assert.equal(captured.target, null)
    assert.equal(captured.expansion, true)
  })

  test('no reference → 🤷, no rerun', async () => {
    const message = makeMessage({ fetchReferenceResult: null })
    let rerunCalled = false
    const ctx = {
      message,
      rerunHandler: async () => { rerunCalled = true }
    } as any
    await expand(ctx)
    assert.equal(rerunCalled, false)
    assert.deepEqual(message.reactionsAdded, ['🤷'])
  })
})
```

- [ ] **Step 3: Run + commit**

```bash
npm run test
git add src/reactions/actions.ts tests/reactions/actions.test.ts
git commit -m "feat: reaction action functions (pin, delete, mute/unmute, edit-mark, regenerate, expand)"
```

---

## Task 6: Reaction handler

**Files:** `src/reactions/handler.ts`, `tests/reactions/handler.test.ts`

- [ ] **Step 1: Implement handler**

Create `src/reactions/handler.ts`:

```typescript
import type { MessageReaction, PartialMessageReaction, User, PartialUser, Client } from 'discord.js'
import { actionFor } from './vocabulary.ts'
import * as actions from './actions.ts'
import type { ActionContext } from './actions.ts'

interface HandlerDeps {
  client: Client
  buildContext: (message: any, reactor: User) => ActionContext
  access: { canReact: (userId: string, channelId: string) => boolean }
}

export async function handleReaction(
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser,
  deps: HandlerDeps
): Promise<void> {
  // Resolve partials
  if (reaction.partial) {
    try { await reaction.fetch() } catch { return }
  }
  if (user.partial) {
    try { await user.fetch() } catch { return }
  }

  const message = reaction.message
  if (message.author?.id !== deps.client.user?.id) return  // not Gemma's message
  if (user.bot) return
  if (!deps.access.canReact(user.id, message.channelId)) return

  const emoji = reaction.emoji.name
  if (!emoji) return
  const action = actionFor(emoji)
  if (!action) return

  const ctx = deps.buildContext(message, user as User)

  try {
    switch (action) {
      case 'regenerate': await actions.regenerate(ctx); break
      case 'expand': await actions.expand(ctx); break
      case 'pin': await actions.pin(ctx); break
      case 'delete': await actions.deleteMessage(ctx); break
      case 'mute': await actions.mute(ctx); break
      case 'unmute': await actions.unmute(ctx); break
      case 'markForEdit': await actions.markForEdit(ctx); break
    }
  } catch (e) {
    console.error(`[reactions] action ${action} failed:`, e)
  }
}
```

- [ ] **Step 2: Write tests**

Create `tests/reactions/handler.test.ts`:

```typescript
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { handleReaction } from '../../src/reactions/handler.ts'

function makeReaction(emoji: string, authorId: string, msgOpts: any = {}) {
  return {
    partial: false,
    emoji: { name: emoji },
    message: {
      author: { id: authorId },
      channelId: 'C1',
      id: 'M1',
      content: 'hi',
      channel: { name: 'general' },
      react: async () => {},
      delete: async () => {},
      fetchReference: async () => null,
      ...msgOpts
    },
    fetch: async () => {}
  } as any
}

const botUser = { id: 'BOT' }
const allowedUser = { id: 'U1', bot: false, partial: false } as any

const buildCtxNoop = () => ({} as any)

const accessAllow = { canReact: () => true }
const accessDeny = { canReact: () => false }

describe('handleReaction', () => {
  test('non-bot message → ignored', async () => {
    let called = false
    const reaction = makeReaction('🔁', 'someone-else')
    reaction.message.fetchReference = async () => { called = true; return null }
    await handleReaction(reaction, allowedUser, {
      client: { user: botUser } as any,
      buildContext: buildCtxNoop,
      access: accessAllow
    })
    assert.equal(called, false)
  })

  test('disallowed user → ignored', async () => {
    let called = false
    const reaction = makeReaction('🔁', botUser.id)
    reaction.message.fetchReference = async () => { called = true; return null }
    await handleReaction(reaction, allowedUser, {
      client: { user: botUser } as any,
      buildContext: buildCtxNoop,
      access: accessDeny
    })
    assert.equal(called, false)
  })

  test('unknown emoji → ignored', async () => {
    let called = false
    const reaction = makeReaction('🤣', botUser.id)
    reaction.message.fetchReference = async () => { called = true; return null }
    await handleReaction(reaction, allowedUser, {
      client: { user: botUser } as any,
      buildContext: buildCtxNoop,
      access: accessAllow
    })
    assert.equal(called, false)
  })

  test('bot reactor → ignored', async () => {
    let called = false
    const reaction = makeReaction('🔁', botUser.id)
    reaction.message.fetchReference = async () => { called = true; return null }
    const botReactor = { id: 'B', bot: true, partial: false } as any
    await handleReaction(reaction, botReactor, {
      client: { user: botUser } as any,
      buildContext: buildCtxNoop,
      access: accessAllow
    })
    assert.equal(called, false)
  })

  test('valid bot-message + allowed user + known emoji → action runs', async () => {
    const reactionsAdded: string[] = []
    const reaction = makeReaction('📌', botUser.id, {
      react: async (e: string) => { reactionsAdded.push(e) }
    })
    let appendedContent = ''
    const ctx = {
      message: reaction.message,
      pinnedFacts: { append: async (_c: string, _n: string, content: string) => { appendedContent = content } }
    } as any
    await handleReaction(reaction, allowedUser, {
      client: { user: botUser } as any,
      buildContext: () => ctx,
      access: accessAllow
    })
    assert.equal(appendedContent, 'hi')
    assert.deepEqual(reactionsAdded, ['✅'])
  })

  test('action throw is caught', async () => {
    const reaction = makeReaction('❌', botUser.id, {
      delete: async () => { throw new Error('no perms') }
    })
    // Should not throw
    await handleReaction(reaction, allowedUser, {
      client: { user: botUser } as any,
      buildContext: () => ({ message: reaction.message } as any),
      access: accessAllow
    })
  })
})
```

- [ ] **Step 3: Run + commit**

```bash
npm run test
git add src/reactions/handler.ts tests/reactions/handler.test.ts
git commit -m "feat: messageReactionAdd handler with allowlist + emoji routing"
```

---

## Task 7: handleUserMessage extraction in gemma.ts

This is the invasive part. Extract the existing `messageCreate` body into a function that supports `editTarget` and `expansion` opts. No reactions yet — pure refactor.

**Files:** `src/gemma.ts`

- [ ] **Step 1: Identify the current messageCreate body**

In `src/gemma.ts`, find the `client.on('messageCreate', async (message: Message) => { ... })` block. The body runs from the `if (message.author.bot) return` check through the final reply send.

- [ ] **Step 2: Extract**

Refactor to:

```typescript
interface HandleOpts {
  editTarget?: Message
  expansion?: boolean
}

async function handleUserMessage(message: Message, opts: HandleOpts = {}): Promise<void> {
  if (message.author.bot) return
  if (!client.user) return

  const isMention = message.mentions.users.has(client.user.id)
  const gate = access.canHandle({
    channelId: message.channelId,
    userId: message.author.id,
    isMention
  })
  if (!gate) return

  // … all the existing pipeline body, but:
  // - prepend "[The user wants you to expand on your previous reply with more depth and detail.]\n" to userText if opts.expansion
  // - if opts.editTarget exists, replace message.reply(...) with opts.editTarget.edit(...) at every send/edit step
  //   (streaming progress also routes to opts.editTarget.edit)
}

client.on('messageCreate', async (message: Message) => {
  // Pending-edit check
  const pending = pendingEdits.get(message.channelId)
  if (pending && !message.author.bot) {
    pendingEdits.clear(message.channelId)
    try {
      const target = await message.channel.messages.fetch(pending)
      await handleUserMessage(message, { editTarget: target })
      return
    } catch (e) {
      console.error('[reactions] edit-target fetch failed, falling through:', e)
    }
  }
  await handleUserMessage(message, {})
})
```

The expansion prefix gets prepended where the user-text variable is built (currently inline in the messageCreate body — search for the line that constructs the text passed to `gemini.respond`).

For `editTarget`: every place that currently does `message.reply(...)` or `replyMsg.edit(...)` for streaming chunks instead writes to `editTarget`. Conditional ternary at each call site:
```typescript
const replyMsg = opts.editTarget ?? await message.reply(...)
// streaming progress: await replyMsg.edit(...)  — works for both
```

- [ ] **Step 3: Run full tests**

Run: `npm run test`
Expected: all green. The refactor doesn't change observable behavior in the no-opts path.

- [ ] **Step 4: Smoke-start (if env available)**

`npm run start`
Expected: bot boots, normal replies work.

- [ ] **Step 5: Commit**

```bash
git add src/gemma.ts
git commit -m "refactor: extract handleUserMessage; supports editTarget + expansion"
```

---

## Task 8: Wire reaction listener and pending-edits

**Files:** `src/gemma.ts`

- [ ] **Step 1: Add intents and partials**

In the `new Client({ intents: [...] })` block, add `GatewayIntentBits.GuildMessageReactions`. In the `partials: [...]` array, add `Partials.Reaction`.

- [ ] **Step 2: Instantiate stores**

Near the top with other singletons:
```typescript
import { PendingEditsStore } from './reactions/pending-edits.ts'
import { PinnedFactsStore } from './pinned-facts.ts'
import path from 'path'

const pendingEdits = new PendingEditsStore()
const pinnedFacts = new PinnedFactsStore(path.join(STATE_DIR, 'pinned-facts.md'))
persona.setPinnedFactsStore(pinnedFacts)
```

- [ ] **Step 3: Wire reaction event**

After the `messageCreate` handler:

```typescript
import { handleReaction } from './reactions/handler.ts'

client.on('messageReactionAdd', async (reaction, user) => {
  await handleReaction(reaction, user, {
    client,
    access: access,
    buildContext: (message, reactor) => ({
      message,
      reactor,
      client,
      gemini,
      access,
      persona,
      pendingEdits,
      pinnedFacts,
      rerunHandler: async (originalUserMessage, targetMessage, expansion) => {
        await handleUserMessage(originalUserMessage, {
          editTarget: targetMessage ?? undefined,
          expansion
        })
      }
    })
  })
})
```

- [ ] **Step 4: Full test run**

Run: `npm run test`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/gemma.ts
git commit -m "feat: wire messageReactionAdd handler + pending-edits + pinned-facts stores"
```

---

## Task 9: Final verification

- [ ] **Step 1: Test count**

Run: `npm run test`
Expected: significantly more tests than before; all pass.

- [ ] **Step 2: Smoke-start**

`npm run start`
Expected: prints `Gemma online`, `Slash commands registered`. No reaction-related errors at boot.

- [ ] **Step 3: Manual smoke checklist** (when deploying)

- [ ] React 🔁 to a Gemma message → original prompt re-runs, message edited.
- [ ] React 🔍 → expansion reply posted.
- [ ] React 📌 → ✅ added; check `~/.gemini/channels/discord/pinned-facts.md`.
- [ ] React ❌ → message deleted.
- [ ] React 🔇 → 🤐 added; bot only responds when @-mentioned afterward.
- [ ] React 🔊 → 🗣️ added; bot responds without mention again.
- [ ] React ✏️ → ⏳ added; next message in channel edits the reacted message.
- [ ] Pinned fact appears in next-turn system prompt (verify by asking Gemma "what's pinned in this channel?").

---

## Out of Scope

- Persistent pending-edits.
- 📌 unpin.
- Per-action permission tiers.
- Bot-side reactive emoji.
- `messageReactionRemove` triggers.
