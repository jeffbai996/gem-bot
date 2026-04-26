# Reaction-Driven Actions — Design

**Date:** 2026-04-24
**Status:** Approved (auto mode), ready for implementation plan

## Motivation

Slash commands and chat are the only way users interact with Gemma today. Reactions are a natural, lightweight UX — one click, no typing, no command grammar to remember. Wiring reactions to actions gives users tactile control over Gemma's output without polluting the channel.

## Goals

A 7-emoji reaction vocabulary, registered against bot-authored messages, gated by the existing user/channel allowlist:

| Emoji | Action |
|---|---|
| 🔁 | Regenerate the bot's reply (re-run original prompt, edit message in place) |
| 🔍 | Expand — bot posts a follow-up with more depth on the same topic |
| 📌 | Pin the bot reply to a per-channel facts file injected into the system prompt |
| ❌ | Delete the bot message |
| 🔇 | Set channel `requireMention=true` |
| 🔊 | Set channel `requireMention=false` |
| ✏️ | Mark the bot message as edit-target; user's next channel message edits it |

## Non-Goals (Stashed)

- Persisting the pending-edits map across restart (in-memory + 5min TTL is fine).
- 📌-unpin / pin entry IDs.
- Per-action permission tiers (e.g. only admin can mute).
- Bot-side reactions (Gemma adding reactions to her own messages reactively).
- Reaction *removal* triggers (`messageReactionRemove`). Add only on add.
- DM-mute/unmute, since `requireMention` doesn't really apply in DMs (bot already knows the user is talking to it).

## Architecture

### Module layout

```
src/reactions/
  vocabulary.ts        — REACTION_ACTIONS map: emoji → action name
  pending-edits.ts     — in-memory store with TTL for ✏️ markers
  actions.ts           — one async function per action; pure-ish (Discord & deps injected)
  handler.ts           — messageReactionAdd handler, routes emoji → action
src/pinned-facts.ts    — read+append helper for pinned-facts.md
src/persona.ts         — modified to include pinned facts in system prompt
src/gemma.ts           — register reaction event; check pending-edits in messageCreate
tests/reactions/
  pending-edits.test.ts
  vocabulary.test.ts
  actions.test.ts
  handler.test.ts
tests/pinned-facts.test.ts
```

### Data flow

```
user reacts 🔁 to bot message M
  → Discord fires messageReactionAdd(reaction, user)
  → handler.handleReaction()
    → ignore if reaction.message.author !== client.user (not Gemma's message)
    → ignore if !accessManager.canHandle({channelId, userId, isMention:false})
       (Note: `isMention` is irrelevant for reactions; we check user-allowed only)
    → look up emoji in REACTION_ACTIONS; ignore if unknown
    → dispatch to action function with action context
  → action runs: edit/delete/post/write/etc.
```

### Permissions

A reaction is honored iff:
1. `reaction.message.author.id === client.user.id` — only Gemma's own messages.
2. `user.id` is on the user allowlist (`access.data.users[userId].allowed === true`).
3. The channel where the reaction lives is enabled (`access.canHandle` minus the mention check).

We expose a new `AccessManager.canReact(userId, channelId): boolean` that wraps these checks. Distinct from `canHandle` because reactions don't have a mention concept.

### Action contracts

Each action is `async (ctx: ActionContext) => Promise<void>`. `ActionContext`:

```typescript
interface ActionContext {
  message: Message            // the bot message being reacted to
  reactor: User               // who clicked
  client: Client              // Discord client
  gemini: GeminiClient
  access: AccessManager
  persona: PersonaLoader
  pendingEdits: PendingEditsStore
  pinnedFacts: PinnedFactsStore
  toolRegistry: ToolRegistry
  // Plus the bits gemma.ts needs to re-run a turn:
  rerunHandler: (originalUserMessage: Message, targetMessage: Message | null, expansion: boolean) => Promise<void>
}
```

`rerunHandler` is the existing `messageCreate` body extracted as a function so reactions and the live event both call into it. Two new params:
- `targetMessage`: when non-null, edit this message instead of sending a new one (used by 🔁 and ✏️ flows).
- `expansion`: when true, prepend an "expand on the previous reply" instruction to the prompt (used by 🔍).

### Action implementations

**🔁 regenerate:**
1. `original = await message.fetchReference()` — the user message Gemma was replying to.
2. If no reference, react with 🤷 and return.
3. Call `rerunHandler(original, message, false)` — re-runs the pipeline and edits `message` with the new reply. Pending edits cleared.

**🔍 expand:**
1. `original = await message.fetchReference()`.
2. If no reference, react with 🤷 and return.
3. Call `rerunHandler(original, null, true)` — sends a *new* reply (not an edit) referencing the bot message, with an "expand on previous reply" preamble in the prompt.

**📌 pin:**
1. Extract `message.content` (the bot's text reply).
2. Append to `pinned-facts.md` under the channel section: `- [{ISO timestamp}] {content}`.
3. React with ✅ to confirm.

**❌ delete:**
1. `await message.delete()`.
2. No confirmation reaction (the message is gone).
3. Note: requires Gemma to have "Manage Messages" if the message is in a thread/guild and not authored by Gemma. Since we only delete bot-authored messages, the standard Send Messages permission suffices.

**🔇 mute (requireMention=true):**
1. Read current channel config from access.
2. Call `access.setChannel(channelId, enabled=true, requireMention=true, flags={...})`.
3. React with 🤐 to confirm.
4. No-op (with reaction) if already muted.

**🔊 unmute (requireMention=false):**
1. Same as above, but `requireMention=false`.
2. React with 🗣️ to confirm.

**✏️ mark-for-edit:**
1. `pendingEdits.set(channelId, message.id, ttl=5min)`.
2. React with ⏳ to indicate "waiting for your next message."

When a user message arrives via `messageCreate`:
- Check `pendingEdits.get(channelId)` first.
- If a non-expired entry exists: fetch that bot message and call `rerunHandler(userMessage, botMessage, false)` to edit it. Clear the entry.
- Else: normal flow.

### Pending-edits store

```typescript
// src/reactions/pending-edits.ts
interface PendingEdit {
  botMessageId: string
  expiresAt: number  // Date.now() + ttl
}

class PendingEditsStore {
  private map = new Map<string, PendingEdit>()
  set(channelId: string, botMessageId: string, ttlMs: number = 5 * 60 * 1000): void
  get(channelId: string): string | null   // returns botMessageId if non-expired, else null + delete
  clear(channelId: string): void
}
```

Pure in-memory. No persistence. Periodic GC unnecessary because `get()` evicts expired entries lazily. The Map will accumulate stale-but-not-yet-checked entries, but at one entry per channel × tiny memory footprint, that's a non-issue at our scale.

### Pinned-facts store

```typescript
// src/pinned-facts.ts
interface PinnedFact {
  timestamp: string
  content: string
}

class PinnedFactsStore {
  private file: string
  async append(channelId: string, channelName: string, content: string): Promise<void>
  async readAll(): Promise<string>   // returns the markdown body for system-prompt injection
  async readForChannel(channelId: string): Promise<PinnedFact[]>  // structured, for tests
}
```

File: `~/.gemini/channels/discord/pinned-facts.md`. Format:
```markdown
## <channelId> — <channelName>

- [2026-04-24T18:32:00.000Z] message excerpt up to 1500 chars
- [2026-04-24T19:02:11.123Z] another one
```

`append()` finds or creates the channel section and appends. Long messages truncate to 1500 chars with a `...` suffix to keep the file readable.

### Persona integration

`PersonaLoader.buildSystemPrompt(channelId)` adds a fourth section between channel summary and the response-format instructions:

```typescript
const pinned = await this.readPinnedFacts(channelId)
if (pinned) {
  sections.push(`## Pinned facts for this channel\n\n${pinned}`)
}
```

`readPinnedFacts(channelId)` reads pinned-facts.md and returns just this channel's section (or empty). Sync read is fine — same pattern as `readChannelSummary`.

Wait: `buildSystemPrompt` is currently sync. Make it async, or use sync `fs.readFileSync` like the existing summary reader. Going sync to avoid touching every caller. Aligns with existing pattern.

### Vocabulary registry

```typescript
// src/reactions/vocabulary.ts
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

export function actionFor(emoji: string): ReactionAction | null
```

Centralized so a future `/gemini reactions` slash command can list them.

### gemma.ts wiring

1. Add `GatewayIntentBits.GuildMessageReactions` to client intents.
2. Add `Partials.Reaction` to partials (so reactions on uncached messages still fire).
3. Extract messageCreate body into `handleUserMessage(message, opts)` where `opts = { editTarget?: Message, expansion?: boolean }`.
4. The original `messageCreate` listener becomes:
```typescript
client.on('messageCreate', async (message) => {
  if (message.author.bot) return
  // pending-edit check first
  const editTargetId = pendingEdits.get(message.channelId)
  if (editTargetId) {
    pendingEdits.clear(message.channelId)
    try {
      const target = await message.channel.messages.fetch(editTargetId)
      await handleUserMessage(message, { editTarget: target, expansion: false })
      return
    } catch { /* fall through to normal handling */ }
  }
  await handleUserMessage(message, {})
})
```
5. Register the reaction handler:
```typescript
client.on('messageReactionAdd', async (reaction, user) => {
  await handleReaction({ reaction, user, ctx: actionContext })
})
```

### handleUserMessage extraction

Currently the `messageCreate` listener runs ~150 lines of pipeline (history, attachments, gemini.respond, chunk, send). Extracting into a function with `{ editTarget?, expansion? }` opts:

- If `editTarget`: replace the final `message.reply(...)` step with `editTarget.edit(...)`. Streaming still works — we already use `editMessage` during stream progress; we just use `editTarget.id` instead of the new message id.
- If `expansion`: prepend `"[The user wants you to expand on your previous reply with more depth and detail.]\n"` to the user message text before passing to Gemini.

This is the most invasive change in the spec. We accept the refactor as in-scope because regenerate/expand/edit-on-reply require it.

## Testing

`tests/reactions/vocabulary.test.ts`:
- Each emoji maps to expected action.
- `actionFor('🤣')` returns null.
- `actionFor('✏️')` works (variation selector).

`tests/reactions/pending-edits.test.ts`:
- Set + get returns botMessageId.
- Get after TTL returns null.
- Clear removes entry.
- Get after clear returns null.

`tests/reactions/actions.test.ts`:
- `pin`: append writes correct line, reads back, channel-sectioned.
- `mute`: calls `access.setChannel` with requireMention=true, preserves other flags.
- `unmute`: requireMention=false.
- `delete`: calls `message.delete()`.
- `markForEdit`: writes pendingEdits entry.
- `regenerate` and `expand`: integration tests using fake `rerunHandler`; assert it's called with right args.

`tests/reactions/handler.test.ts`:
- Bot-authored message + allowed user + known emoji → action dispatched.
- Non-bot message → no dispatch.
- Disallowed user → no dispatch.
- Unknown emoji → no dispatch.
- Action throws → logged, no crash.

`tests/pinned-facts.test.ts`:
- Append creates section if missing.
- Append adds to existing section.
- Long content truncates with `...`.
- Read returns formatted markdown for one channel.
- Read on missing file returns empty.

## Configuration

No new env vars. Pinned-facts file lives next to `access.json` in `DISCORD_STATE_DIR`.

## Migration plan

1. Add intents/partials for reactions.
2. Build `pending-edits.ts` + tests.
3. Build `vocabulary.ts` + tests.
4. Build `pinned-facts.ts` + tests; integrate into `persona.ts`.
5. Build `actions.ts` for low-blast actions first (pin, delete, mute, unmute, markForEdit) + tests.
6. Refactor `messageCreate` body into `handleUserMessage(message, opts)`.
7. Add regenerate + expand actions on top of `handleUserMessage` + tests.
8. Build reaction `handler.ts` + tests.
9. Wire handler into `gemma.ts` + pending-edit check in messageCreate.
10. Full test run.

## Open questions resolved

- **Edit-vs-new flow:** ✏️ + next message edits; 🔁 edits in place; 🔍 sends new. Matches user mental model.
- **Pin truncation:** 1500 chars. Long enough for typical replies, short enough to keep the prompt-injection cost bounded.
- **Confirmation reactions:** ✅ for pin, ⏳ for mark-for-edit, 🤐 for mute, 🗣️ for unmute, 🤷 for "no reference found." Lightweight feedback without channel noise.
- **DM behavior:** all actions work in DMs too. Mute/unmute toggle works but is largely meaningless in a DM (bot already knows you're addressing it). No special-casing — the registry just toggles the flag.
