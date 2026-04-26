# Handoff prompt: reaction-driven actions for a Claude-based Discord bot

Paste this into a Claude Code session running in your Claude bot's repo (e.g. `<agent-config-dir>/<bot-name>`). It tells Claude what to build and how, mirrored on the Gemma implementation in `~/gem-discord-bot`.

---

## Prompt to paste

I want to add reaction-driven actions to this Discord bot. The Gemma bot at `~/gem-discord-bot` already has this feature — read its design doc at `~/gem-discord-bot/docs/superpowers/specs/2026-04-24-reaction-driven-actions-design.md` and its plan at `~/gem-discord-bot/docs/superpowers/plans/2026-04-24-reaction-driven-actions.md` for full context. Then implement the equivalent in this repo, adapting to its language/runtime.

Use the brainstorming skill first to confirm the design fits this bot's architecture, then writing-plans, then implement task-by-task with TDD.

### Required vocabulary (must match Gemma exactly so the UX is consistent across bots)

| Emoji | Action |
|---|---|
| 🔁 | Regenerate the bot's reply (re-run the prompt that produced this message; edit the bot message in place) |
| 🔍 | Expand: post a new follow-up with more depth on the same topic |
| 📌 | Pin: append the bot's reply to a per-channel facts file that gets injected into the system prompt for future turns |
| ❌ | Delete the bot's message |
| 🔇 | Set channel `requireMention=true` (whatever the equivalent config is in this bot) |
| 🔊 | Set channel `requireMention=false` |
| ✏️ | Mark the bot message as edit-target; the user's next channel message edits that message instead of creating a new reply |

The 🔇 / 🔊 toggle is mandatory and must update the same access-config file that controls require-mention in normal flow.

### Confirmation reactions Gemma adds back

- `📌` → react `✅`
- `🔇` → react `🤐`
- `🔊` → react `🗣️`
- `✏️` → react `⏳`
- `🔁` / `🔍` with no message reference → react `🤷` (no-op fallback)
- `❌` → no confirmation (message is gone)

Match these in the Claude bot too so users see the same feedback emoji from any bot in the squad.

### Permissions

A reaction is honored iff:
1. The reacted-to message is authored by this bot.
2. The reactor is on the bot's user allowlist (whatever the equivalent of `access.json`'s `users[id].allowed === true` is in this codebase).
3. The channel is enabled for the bot.

Reactions never need the "require_mention" check — that gate only applies to the message-create flow.

### Architecture guidance

- One module for the emoji → action mapping (table-driven, easy to extend).
- One in-memory store for the ✏️ pending-edit marker. `Map<channelId, {messageId, expiresAt}>`. 5-minute TTL. No persistence needed.
- One module for the pinned-facts file (append + per-channel read). File format:
  ```markdown
  ## <channelId> — <channelName>

  - [<ISO timestamp>] <content, max 1500 chars, with newlines flattened to spaces, ellipsis if truncated>
  - [<ISO timestamp>] ...
  ```
- The system-prompt assembly reads the pinned-facts file and injects the matching channel's bullets as a section.
- Discord intents: add `GuildMessageReactions` and `Partials.Reaction` (or this language's equivalents).
- Reaction handler resolves partials before reading message fields, then routes to the per-action function.

### Refactor that comes with this work

The "regenerate" and "expand" actions need to re-run the bot's normal message-handling pipeline against an *earlier* user message, with two new options:

- `editTarget?: Message` — when set, edit this bot message in place instead of replying fresh.
- `expansion?: boolean` — when true, prepend an instruction to the user text like `"[The user wants you to expand on your previous reply with more depth and detail.]\n\n"` before passing to the model.

That probably means extracting whatever your `messageCreate` handler currently does into a function that takes those two opts, and having the original event listener call it with `{}`. Then the reaction handler also calls it with the appropriate opts.

The pending-edit (✏️) flow piggybacks on the same refactor: when a normal user message arrives, the listener checks the pending-edits store first; if there's an entry for this channel, fetch that bot message and call the handler with `editTarget` set instead of creating a new reply. Clear the pending entry whether the call succeeds or fails.

### Tests

Each module is unit-testable on its own:
- Vocabulary: emoji → action mapping, unknown returns null.
- Pending-edits: set/get/clear, TTL expiry, channel independence.
- Pinned-facts: append creates section, append to existing section, truncation, per-channel read, missing-file behavior.
- Action functions: pure functions where possible (pin, mute, unmute, markForEdit). Inject fakes for the Discord/access objects.
- Reaction handler: bot-message check, allowlist check, unknown emoji, action throw is caught.

Skip integration tests for the regenerate/expand actions if mocking your full pipeline is heavy — the handler's wiring is exercised manually.

### Out of scope (do not do)

- Persistent pending-edits.
- 📌-unpin.
- Per-action permission tiers (e.g. only admin can mute).
- `messageReactionRemove` triggers (only react on add).
- Bot-side reactions to its own messages.

### Definition of done

- All 7 emojis work end-to-end against this bot in a real channel.
- Pinned facts appear in the next-turn system prompt.
- 🔇/🔊 toggle persists in the bot's access config.
- Existing tests still pass; new tests for the modules above pass.
- The bot still serves messages normally when no reactions are involved.

Use TDD throughout. Frequent small commits. When done, update the bot's CLAUDE.md / README to document the reaction vocabulary so future you remembers what each emoji does.
