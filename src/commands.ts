import { SlashCommandBuilder, PermissionFlagsBits, ChatInputCommandInteraction, TextChannel } from 'discord.js'
import path from 'node:path'
import os from 'node:os'
import { AccessManager, type ThinkingMode, type ChatEngine, type CounterMode, type TraceMode } from './access.ts'
import { PersonaLoader } from './persona.ts'
import { GeminiClient } from './gemini.ts'
import { GeminiCacheManager } from './cache.ts'
import { insertMessage } from './db.ts'
import { rewriteEnvVar, scheduleSelfRestart } from './restart.ts'
import { activeTurns } from './active-turns.ts'

// Valid agy `--model` display strings (from `agy models`). The /gemini model
// `agy_model` choice list is built from this, and the handler re-validates
// against it so an API-style id (e.g. gemini-3-flash-preview) can never be
// written as the agy model — agy's --model only accepts these display strings.
// Add new tiers here when `agy models` grows.
const VALID_AGY_MODELS: string[] = [
  'Gemini 3.5 Flash (Medium)',
  'Gemini 3.5 Flash (High)',
  'Gemini 3.5 Flash (Low)',
  'Gemini 3.1 Pro (Low)',
  'Gemini 3.1 Pro (High)',
  'Claude Sonnet 4.6 (Thinking)',
  'Claude Opus 4.6 (Thinking)',
]

export const geminiCommand = new SlashCommandBuilder()
  .setName('gemini')
  .setDescription('Admin controls for the Gem bot')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator) // Requires Server Admin by default
  .addSubcommand(subcommand =>
    subcommand
      .setName('allow')
      .setDescription('Allow a user to interact with the bot')
      .addUserOption(option => option.setName('user').setDescription('The user to allow').setRequired(true))
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('revoke')
      .setDescription('Revoke a user\'s access to the bot')
      .addUserOption(option => option.setName('user').setDescription('The user to revoke').setRequired(true))
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('channel')
      .setDescription('Set bot access for a channel — enable + mention rule. Other flags via /gemini set.')
      .addChannelOption(option => option.setName('channel').setDescription('The channel to configure').setRequired(true))
      .addBooleanOption(option => option.setName('enabled').setDescription('Enable bot in this channel').setRequired(true))
      .addBooleanOption(option => option.setName('require_mention').setDescription('Require explicit mention').setRequired(true))
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('persona')
      .setDescription('Hot-swap the bot persona')
      .addStringOption(option => option.setName('filename').setDescription('The persona filename (e.g. GEMINI.md)').setRequired(true))
  )
  // Switch the GEMINI_MODEL env var and auto-restart so the new model takes
  // effect. Choices are pinned to known-good IDs — Gemini's model namespace
  // mutates often (deprecations, alias renames) so we don't accept arbitrary
  // strings. Add new entries here when a new model is qualified.
  // /gemini model api|agy — split into a subcommand group (Jeff 2026-06-30:
  // "aren't forced to pick an engine and a model at the same time, engine
  // already has its own command"). Each subcommand IS its engine — no
  // separate `engine` string to fill in or infer from, no ambiguity with the
  // unrelated /gemini engine (that one sets the channel's active chat
  // engine; this sets which model string that engine uses). Picking `api`
  // only ever rewrites GEMINI_MODEL; picking `agy` only ever rewrites
  // GEMMA_AGY_MODEL — the other engine's setting is never touched.
  .addSubcommandGroup(group =>
    group
      .setName('model')
      .setDescription('Switch the api or agy model (auto-restarts gemma)')
      .addSubcommand(s => s
        .setName('api')
        .setDescription('Metered Gemini API model (GEMINI_MODEL)')
        // Pinned to known-good Gemini ids — the namespace mutates
        // (deprecations, alias renames), so we don't accept arbitrary strings.
        // Add entries here as new models qualify.
        .addStringOption(option => option
          .setName('id')
          .setDescription('omit to show current')
          .setRequired(false)
          .addChoices(
            { name: 'gemini-3-pro-preview — strongest reasoning, ~10x cost', value: 'gemini-3-pro-preview' },
            { name: 'gemini-3.5-flash — newer, repriced ~5x ($1.50/$9.00 per 1M)', value: 'gemini-3.5-flash' },
            { name: 'gemini-3-flash-preview — balanced default', value: 'gemini-3-flash-preview' },
            { name: 'gemini-3.1-flash-lite-preview — cheapest, low-latency', value: 'gemini-3.1-flash-lite-preview' },
          )
        )
      )
      .addSubcommand(s => s
        .setName('agy')
        .setDescription('Antigravity CLI flat-sub model (GEMMA_AGY_MODEL)')
        // MUST be a full agy display string from `agy models`, NOT an API id —
        // agy's --model expects exactly these. The choice list is what blocks
        // a user from setting an API-style id here (the handler re-validates
        // against VALID_AGY_MODELS too, in case the option is filled raw).
        .addStringOption(option => option
          .setName('agy_model')
          .setDescription('omit to show current')
          .setRequired(false)
          .addChoices(
            { name: 'Gemini 3.5 Flash (Medium) — balanced default', value: 'Gemini 3.5 Flash (Medium)' },
            { name: 'Gemini 3.5 Flash (High) — more reasoning', value: 'Gemini 3.5 Flash (High)' },
            { name: 'Gemini 3.5 Flash (Low) — fastest/cheapest', value: 'Gemini 3.5 Flash (Low)' },
            { name: 'Gemini 3.1 Pro (Low) — Pro tier, lighter', value: 'Gemini 3.1 Pro (Low)' },
            { name: 'Gemini 3.1 Pro (High) — Pro tier, strongest', value: 'Gemini 3.1 Pro (High)' },
            { name: 'Claude Sonnet 4.6 (Thinking)', value: 'Claude Sonnet 4.6 (Thinking)' },
            { name: 'Claude Opus 4.6 (Thinking)', value: 'Claude Opus 4.6 (Thinking)' },
          )
        )
      )
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('backfill')
      .setDescription('Backfill historical messages into semantic memory')
      .addChannelOption(option => option.setName('channel').setDescription('Channel to scrape').setRequired(true))
      .addIntegerOption(option => option.setName('limit').setDescription('Max messages to embed').setMinValue(1).setMaxValue(500).setRequired(false))
  )
  // `value` is a string because values vary per flag (thinking: always|auto|
  // never; others: true|false). The handler validates. `cache on/off` lives
  // under the cache subcommand group below since it shares semantics with
  // cache info|ttl|flush.
  .addSubcommand(subcommand =>
    subcommand
      .setName('thinking')
      .setDescription('When to render the 💭 thinking block: off | on | collapse.')
      .addStringOption(option => option
        .setName('mode')
        .setDescription('off (no block) | on (force every reply) | collapse (show then strip after a linger)')
        .setRequired(true)
        .addChoices(
          { name: 'off — no thinking block (default)', value: 'off' },
          { name: 'on — force a thinking block every reply', value: 'on' },
          { name: 'collapse — show it, then strip after the linger', value: 'collapse' },
        )
      )
      .addChannelOption(option => option.setName('channel').setDescription('Channel (defaults to current)').setRequired(false))
  )
  // Dedicated 🔧 Tool-trace card (ported from gpt-bot's /gpt trace). Its OWN
  // subcommand — NOT merged with /gemini thinking (which is a separate
  // always|auto|collapse|never reasoning-block toggle). off = no card (default,
  // opt-in); on = keep the card; collapse = show live, strip after the linger.
  .addSubcommand(subcommand =>
    subcommand
      .setName('trace')
      .setDescription('Tool-trace card for this channel: off | on | collapse.')
      .addStringOption(option => option
        .setName('value')
        .setDescription('off | on (keep the card) | collapse (show then strip after the linger)')
        .setRequired(true)
        .addChoices(
          { name: 'off — no tool-trace card (default)', value: 'off' },
          { name: 'on — keep the 🔧 Tool-trace card', value: 'on' },
          { name: 'collapse — show it, then strip after the linger', value: 'collapse' },
        )
      )
      .addChannelOption(option => option.setName('channel').setDescription('Channel (defaults to current)').setRequired(false))
  )
  // Per-channel chat engine. agy = Antigravity CLI (flat Google sub; trajectory
  // trace/thinking restored when available); api = the metered Gemini API.
  // `default` clears the per-channel pick so the GEMMA_AGY_CHAT env default
  // applies. Media turns always use the API regardless (agy -p is text-only).
  .addSubcommand(subcommand =>
    subcommand
      .setName('engine')
      .setDescription('Set this channel chat engine: agy (flat sub) | api (metered) | default (env).')
      .addStringOption(option => option
        .setName('value')
        .setDescription('omit to show current engine; else agy | api | default')
        .setRequired(false)
        .addChoices(
          { name: 'agy — Antigravity CLI / flat Google sub', value: 'agy' },
          { name: 'api — metered Gemini API (full tools + grounding + trace)', value: 'api' },
          { name: 'default — clear pick, use the GEMMA_AGY_CHAT env default', value: 'default' },
        )
      )
      .addChannelOption(option => option.setName('channel').setDescription('Channel (defaults to current)').setRequired(false))
  )
  // Footer counter — split out of the old `verbose` flag (2026-06-28). `verbose`
  // used to gate BOTH the usage/timing footer AND the 🧠 native-reasoning block;
  // the footer is now this dedicated subcommand and the reasoning block rides the
  // /gemini thinking mode. Mirrors gpt-bot's /gpt counter. off | token | both —
  // on the agy engine there are no token counts so token/both gracefully show
  // elapsed time only (the footer code already handles "no usage data").
  .addSubcommand(subcommand =>
    subcommand
      .setName('counter')
      .setDescription('Footer counter for this channel: off | token | both.')
      .addStringOption(option => option
        .setName('value')
        .setDescription('off | token | both')
        .setRequired(true)
        .addChoices(
          { name: 'off — no footer', value: 'off' },
          { name: 'token — tokens + time (time-only on the agy engine)', value: 'token' },
          { name: 'both — tokens + cached-prefix detail (API path; time-only on agy)', value: 'both' },
        )
      )
      .addChannelOption(option => option.setName('channel').setDescription('Channel (defaults to current)').setRequired(false))
  )
  .addSubcommandGroup(group =>
    group
      .setName('cache')
      .setDescription('Server-side context caching for the stable system prompt')
      .addSubcommand(s => s
        .setName('on')
        .setDescription('Enable context caching for a channel (defaults to current)')
        .addChannelOption(o => o.setName('channel').setDescription('Channel (defaults to current)').setRequired(false))
      )
      .addSubcommand(s => s
        .setName('off')
        .setDescription('Disable context caching for a channel (defaults to current)')
        .addChannelOption(o => o.setName('channel').setDescription('Channel (defaults to current)').setRequired(false))
      )
      .addSubcommand(s => s
        .setName('info')
        .setDescription('Show live cache details (size, age, TTL remaining, hits)')
      )
      .addSubcommand(s => s
        .setName('ttl')
        .setDescription('Override cache TTL for a channel in seconds (60–86400). Pass 0 to reset to default.')
        .addIntegerOption(o => o.setName('seconds').setDescription('TTL seconds, or 0 to reset').setMinValue(0).setMaxValue(86400).setRequired(true))
        .addChannelOption(o => o.setName('channel').setDescription('Channel (defaults to current)').setRequired(false))
      )
      .addSubcommand(s => s
        .setName('flush')
        .setDescription('Drop all in-process cache references — next turn rebuilds')
      )
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('clear')
      .setDescription('Reset Gem\'s context for this channel — next turn starts fresh')
      .addChannelOption(option => option.setName('channel').setDescription('Channel (defaults to current)').setRequired(false))
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('compact')
      .setDescription('Force a context-summary rollup now, regardless of message threshold')
      .addChannelOption(option => option.setName('channel').setDescription('Channel (defaults to current)').setRequired(false))
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('settings')
      .setDescription('Show every resolved setting for this channel (read-only)')
      .addChannelOption(option => option.setName('channel').setDescription('Channel (defaults to current)').setRequired(false))
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('mention')
      .setDescription('Require an @-mention before responding in this channel: on | off.')
      .addStringOption(option => option
        .setName('value').setDescription('on | off').setRequired(true)
        .addChoices(
          { name: 'on — only respond when @-mentioned', value: 'on' },
          { name: 'off — respond to all messages', value: 'off' },
        )
      )
      .addChannelOption(option => option.setName('channel').setDescription('Channel (defaults to current)').setRequired(false))
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('stop')
      .setDescription('Abort the in-flight turn for this channel (kills agy/API generation mid-stream)')
  )

// Compact "Xs / Xm Ys / Xh Ym" rendering for the cache info card. Avoids
// pulling in a date-fns dependency for one display surface.
function formatRelative(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`
  const h = Math.floor(m / 60)
  const remM = m % 60
  return remM > 0 ? `${h}h ${remM}m` : `${h}h`
}

interface ExtraDeps {
  summaryStore: { upsert(channelId: string, summary: string, lastMessageId: string): void }
  summarizer: { runForChannel(channelId: string): Promise<{ messageCount: number } | null> }
}

  export async function executeGeminiCommand(interaction: ChatInputCommandInteraction, access: AccessManager, persona: PersonaLoader, gemini: GeminiClient, adminUserId: string | undefined, deps: ExtraDeps) {
  // Extra layer of security: only specific user ID from .env can use this, 
  // or anyone with Server Admin if no specific ID is set.
  if (adminUserId && interaction.user.id !== adminUserId) {
    return interaction.reply({ content: 'Unauthorized. You are not the designated bot admin.', ephemeral: true })
  }

  const subcommand = interaction.options.getSubcommand()

  try {
    if (subcommand === 'allow') {
      const targetUser = interaction.options.getUser('user', true)
      await access.allowUser(targetUser.id)
      return interaction.reply({ content: `✅ Access granted to ${targetUser.tag}.`, ephemeral: true })
    }

    if (subcommand === 'revoke') {
      const targetUser = interaction.options.getUser('user', true)
      await access.revokeUser(targetUser.id)
      return interaction.reply({ content: `✅ Access revoked for ${targetUser.tag}.`, ephemeral: true })
    }

    // /gemini channel only sets the two essentials (enabled + require_mention).
    // Other flags (thinking/showcode/counter/cache) have dedicated
    // subcommands that toggle them independently — having them here too was
    // redundant and made the command form unwieldy. setChannel preserves
    // existing flag values when called on an already-configured channel.
    if (subcommand === 'channel') {
      const channel = interaction.options.getChannel('channel', true)
      const enabled = interaction.options.getBoolean('enabled', true)
      const requireMention = interaction.options.getBoolean('require_mention', true)
      await access.setChannel(channel.id, enabled, requireMention)
      const flags = access.channelFlags(channel.id)
      return interaction.reply({
        content: `✅ <#${channel.id}> configured. enabled=${enabled}, requireMention=${requireMention}. other flags (thinking=${flags.thinking}, trace=${flags.trace}, counter=${flags.counter}, cache=${flags.cache}) — change via \`/gemini thinking\`, \`/gemini trace\`, \`/gemini counter\`, \`/gemini cache\` or \`/gemini mention\`. See all with \`/gemini settings\`.`,
        ephemeral: true
      })
    }

    if (subcommand === 'persona') {
      const filename = interaction.options.getString('filename', true)
      await persona.load(filename)
      return interaction.reply({ content: `✅ Persona swapped to \`${filename}\`.`, ephemeral: true })
    }

    // /gemini model api|agy — subcommandGroup means getSubcommandGroup()
    // returns 'model' and getSubcommand() returns which engine's model.
    // Each verb only ever touches its own env var; the other engine's model
    // is never read or written here.
    if (interaction.options.getSubcommandGroup(false) === 'model') {
      const targetEngine = subcommand as ChatEngine // 'api' | 'agy', enforced by the two subcommand names
      const envKey = targetEngine === 'agy' ? 'GEMMA_AGY_MODEL' : 'GEMINI_MODEL'
      const newModel = targetEngine === 'agy'
        ? interaction.options.getString('agy_model')
        : interaction.options.getString('id')

      if (!newModel) {
        // No value -> show this engine's current model. Doesn't touch or
        // mention the other engine's model at all.
        const cur = targetEngine === 'agy'
          ? (process.env.GEMMA_AGY_MODEL || '(default \u2014 GEMMA_AGY_MODEL not set; falls back to Gemini 3.5 Flash (Medium))')
          : (process.env.GEMINI_MODEL || '(default \u2014 GEMINI_MODEL not set; falls back to gemini-3-flash-preview)')
        const valOpt = targetEngine === 'agy' ? 'agy_model' : 'id'
        return interaction.reply({
          content: `\ud83e\udd16 Current **${targetEngine}** model (${envKey}): \`${cur}\`\nPass \`${valOpt}\` to change it.`,
          ephemeral: true,
        })
      }

      // Guard: never let an API-style id land in the agy slot. The agy --model
      // value must be a real `agy models` display string; the choice list already
      // constrains the UI, but re-validate in case the option is filled raw.
      if (targetEngine === 'agy' && !VALID_AGY_MODELS.includes(newModel)) {
        return interaction.reply({
          content: `\u274c \`${newModel}\` is not a valid agy model. Use a display string from \`agy models\` (e.g. \`Gemini 3.5 Flash (Medium)\`), not an API id.`,
          ephemeral: true,
        })
      }

      const stateDir = process.env.DISCORD_STATE_DIR || path.join(os.homedir(), '.gemini', 'channels', 'discord')
      const envPath = path.join(stateDir, '.env')
      try {
        await rewriteEnvVar(envPath, envKey, newModel)
      } catch (e: any) {
        return interaction.reply({
          content: `❌ Could not write \`${envPath}\`: ${e?.message ?? e}`,
          ephemeral: true,
        })
      }
      // Reply BEFORE scheduling the restart so Discord acks while the process
      // is still alive. The detached `bash -c 'sleep ... && systemctl restart'`
      // outlives this process; systemd brings us back up reading the new env.
      await interaction.reply({
        content: `🔁 **${targetEngine}** model set to \`${newModel}\` (${envKey}). Restarting in ~1.5s — back in a few seconds with the new model loaded.`,
        ephemeral: true,
      })
      scheduleSelfRestart('gemma', 1500)
      return
    }

    // /gemini thinking off|on|collapse — gates the 💭 thinking block
    // AND the 🧠 native-reasoning block (both reasoning-trace renders). The
    // footer moved to /gemini counter (2026-06-28). optInReply was dropped
    // 2026-05-02. Cache toggle stays under the cache subcommand group below.
    if (subcommand === 'thinking') {
      const mode = interaction.options.getString('mode', true).trim().toLowerCase()
      const channel = interaction.options.getChannel('channel') ?? interaction.channel
      if (!channel) {
        return interaction.reply({ content: '❌ No channel resolved (run from inside a channel or pass the channel arg).', ephemeral: true })
      }
      if (!['off', 'on', 'collapse'].includes(mode)) {
        return interaction.reply({ content: `❌ \`thinking\` must be one of: off, on, collapse (got \`${mode}\`)`, ephemeral: true })
      }
      const updated = await access.setChannelFlags(channel.id, { thinking: mode as ThinkingMode })
      const note = mode === 'collapse' ? ' — shown live, stripped after the linger' : ''
      return interaction.reply({ content: `✅ <#${channel.id}> thinking = \`${updated.thinking}\`${note}.`, ephemeral: true })
    }

    // /gemini trace off|on|collapse — the dedicated 🔧 Tool-trace card toggle,
    // ported from gpt-bot's /gpt trace. Its OWN subcommand (NOT merged with
    // /gemini thinking). off = no card (default); on = keep it; collapse = show
    // live then strip after the linger. Renders on BOTH engines (native + agy).
    if (subcommand === 'trace') {
      const value = interaction.options.getString('value', true).trim().toLowerCase()
      const channel = interaction.options.getChannel('channel') ?? interaction.channel
      if (!channel) {
        return interaction.reply({ content: '❌ No channel resolved (run from inside a channel or pass the channel arg).', ephemeral: true })
      }
      if (!['off', 'on', 'collapse'].includes(value)) {
        return interaction.reply({ content: `❌ \`trace\` must be one of: off, on, collapse (got \`${value}\`)`, ephemeral: true })
      }
      try {
        const updated = await access.setChannelFlags(channel.id, { trace: value as TraceMode })
        const note = value === 'collapse'
          ? ' — shown live, stripped after the linger'
          : value === 'on'
            ? ' — 🔧 Tool-trace card above each reply that ran tools'
            : ' — no tool-trace card'
        return interaction.reply({ content: `✅ <#${channel.id}> trace = \`${updated.trace}\`${note}.`, ephemeral: true })
      } catch (e: any) {
        return interaction.reply({ content: `❌ ${e.message}`, ephemeral: true })
      }
    }

    // /gemini engine agy|api|default — per-channel chat engine pick. 'default'
    // is the null sentinel: it clears the per-channel override so the
    // GEMMA_AGY_CHAT env default takes over. Mirrors gpt-bot's /gpt engine.
    if (subcommand === 'engine') {
      const value = interaction.options.getString('value')?.trim().toLowerCase()
      const channel = interaction.options.getChannel('channel') ?? interaction.channel
      if (!channel) {
        return interaction.reply({ content: '❌ No channel resolved (run from inside a channel or pass the channel arg).', ephemeral: true })
      }
      // No value → show the channel's CURRENT effective engine: the per-channel
      // pick if set, else the GEMMA_AGY_CHAT env default, labeled "(env default)".
      // Mirrors the /gemini model no-arg display path above.
      if (!value) {
        const envDefault = process.env.GEMMA_AGY_CHAT === '1' ? 'agy' : 'api'
        const pick = access.channelFlags(channel.id).engine
        const effective = pick ?? `${envDefault} (env default)`
        return interaction.reply({ content: `🔌 <#${channel.id}> chat engine: \`${effective}\``, ephemeral: true })
      }
      if (!['agy', 'api', 'default'].includes(value)) {
        return interaction.reply({ content: `❌ \`engine\` must be one of: agy, api, default (got \`${value}\`)`, ephemeral: true })
      }
      try {
        // 'default' → null sentinel clears the per-channel pick.
        const patchEngine = value === 'default' ? null : (value as ChatEngine)
        const updated = await access.setChannelFlags(channel.id, { engine: patchEngine })
        const envDefault = process.env.GEMMA_AGY_CHAT === '1' ? 'agy' : 'api'
        const effective = updated.engine ?? `${envDefault} (env default)`
        const note = value === 'agy'
          ? 'agy (flat sub) — falls back to the API on error/media turns'
          : value === 'api'
            ? 'api (metered Gemini) — bypasses agy entirely'
            : `cleared — using the GEMMA_AGY_CHAT env default (${envDefault})`
        return interaction.reply({ content: `✅ <#${channel.id}> chat engine = \`${effective}\` — ${note}.`, ephemeral: true })
      } catch (e: any) {
        return interaction.reply({ content: `❌ ${e.message}`, ephemeral: true })
      }
    }

    // /gemini counter off|token|both — per-channel footer mode. Split out of the
    // old verbose flag; gates ONLY the usage/timing footer in gemma.ts (the 🧠
    // native-reasoning block now rides the thinking mode). Mirrors /gpt counter.
    if (subcommand === 'counter') {
      const value = interaction.options.getString('value', true).trim().toLowerCase()
      const channel = interaction.options.getChannel('channel') ?? interaction.channel
      if (!channel) {
        return interaction.reply({ content: '❌ No channel resolved (run from inside a channel or pass the channel arg).', ephemeral: true })
      }
      if (value !== 'off' && value !== 'token' && value !== 'both') {
        return interaction.reply({ content: `❌ \`counter\` must be one of: off, token, both (got \`${value}\`)`, ephemeral: true })
      }
      try {
        const updated = await access.setChannelFlags(channel.id, { counter: value as CounterMode })
        const note = value === 'off'
          ? 'no footer'
          : value === 'token'
            ? 'tokens + time (time-only on the agy engine)'
            : 'tokens + time + cached-prefix detail (API path; time-only on agy)'
        return interaction.reply({ content: `✅ <#${channel.id}> footer counter = \`${updated.counter}\` — ${note}.`, ephemeral: true })
      } catch (e: any) {
        return interaction.reply({ content: `❌ ${e.message}`, ephemeral: true })
      }
    }

    // /gemini cache <on|off|info|ttl|flush>. SubcommandGroup means
    // getSubcommandGroup() returns 'cache' and getSubcommand() returns the
    // inner verb.
    if (interaction.options.getSubcommandGroup(false) === 'cache') {
      const verb = subcommand
      if (verb === 'on' || verb === 'off') {
        const enabled = verb === 'on'
        const channel = interaction.options.getChannel('channel') ?? interaction.channel
        if (!channel) {
          return interaction.reply({ content: '❌ No channel resolved (run from inside a channel or pass the channel arg).', ephemeral: true })
        }
        try {
          const updated = await access.setChannelFlags(channel.id, { cache: enabled })
          const ttlNote = updated.cacheTtlSec != null
            ? `${updated.cacheTtlSec}s override`
            : `${GeminiCacheManager.defaultTtlSec()}s default`
          return interaction.reply({
            content: `✅ <#${channel.id}> cache → \`${enabled}\` — ${enabled ? `prefix cached server-side (~10% billing on cached portion). TTL: ${ttlNote}.` : 'caching off'}`,
            ephemeral: true
          })
        } catch (e: any) {
          return interaction.reply({ content: `❌ ${e.message}`, ephemeral: true })
        }
      }

      if (verb === 'ttl') {
        const seconds = interaction.options.getInteger('seconds', true)
        const channel = interaction.options.getChannel('channel') ?? interaction.channel
        if (!channel) {
          return interaction.reply({ content: '❌ No channel resolved (run from inside a channel or pass the channel arg).', ephemeral: true })
        }
        // 0 = clear override; positive = set. We bypass setChannelFlags's
        // null-vs-undefined sentinel by routing through it twice if needed,
        // but the field-clear path (cacheTtlSec: null) handles the 0 case
        // directly.
        try {
          const patch = seconds === 0 ? { cacheTtlSec: null } : { cacheTtlSec: seconds }
          const updated = await access.setChannelFlags(channel.id, patch as any)
          const desc = seconds === 0
            ? `cleared — falls back to default ${GeminiCacheManager.defaultTtlSec()}s`
            : `${seconds}s override`
          return interaction.reply({
            content: `✅ <#${channel.id}> cache TTL → ${desc}. (cache=${updated.cache})`,
            ephemeral: true
          })
        } catch (e: any) {
          return interaction.reply({ content: `❌ ${e.message}`, ephemeral: true })
        }
      }

      if (verb === 'flush') {
        gemini.clearCache?.()
        return interaction.reply({
          content: `🧹 in-process cache references dropped. Next turn rebuilds caches from scratch (server-side caches age out via TTL on Google's side).`,
          ephemeral: true
        })
      }

      if (verb === 'info') {
        const caches = gemini.listCaches?.() ?? []
        if (caches.length === 0) {
          return interaction.reply({
            content: `📦 no live caches in process. either no channel has \`cache=true\`, or the prefix is below the model's minimum (1024 Flash / 4096 Pro tokens).\n\ndefault TTL: ${GeminiCacheManager.defaultTtlSec()}s.`,
            ephemeral: true
          })
        }
        const now = Date.now()
        const lines: string[] = [`📦 **gemma cache** — ${caches.length} live entr${caches.length === 1 ? 'y' : 'ies'}`, '']
        for (const c of caches) {
          const ageSec = Math.floor((now - c.createdAt) / 1000)
          const idleSec = Math.floor((now - c.lastUsedAt) / 1000)
          const remainingSec = Math.max(0, c.ttlSec - ageSec)
          const cachedSize = c.cachedTokens != null
            ? `${c.cachedTokens.toLocaleString('en-US')} tok billed`
            : `~${c.systemTokens.toLocaleString('en-US')} tok est. (no hit yet)`
          lines.push(
            `• \`${c.systemHash}\` (${c.model})`,
            `   ↳ size: ${cachedSize}`,
            `   ↳ hits: ${c.hitCount} · last used: ${formatRelative(idleSec)} ago`,
            `   ↳ age: ${formatRelative(ageSec)} · TTL: ${c.ttlSec}s · remaining: ${formatRelative(remainingSec)}`,
            ''
          )
        }
        lines.push(`default TTL: ${GeminiCacheManager.defaultTtlSec()}s. set per-channel with \`/gemini cache ttl\`.`)
        return interaction.reply({ content: lines.join('\n'), ephemeral: true })
      }

      // unrecognized verb under the group
      return interaction.reply({ content: `❌ unknown cache subcommand \`${verb}\``, ephemeral: true })
    }

    if (subcommand === 'clear') {
      const channel = interaction.options.getChannel('channel') ?? interaction.channel
      if (!channel) {
        return interaction.reply({ content: '❌ No channel resolved (run from inside a channel or pass the channel arg).', ephemeral: true })
      }
      // Bump the watermark to the current interaction message id and blank
      // the summary text. buildContextHistory uses lastSummarizedMessageId
      // as a snowflake-ID lower bound, so anything older drops out of the
      // history fetch on the next turn. Existing chat history is untouched
      // on Discord's side — Gemma just stops feeding it back into the model.
      const watermarkId = interaction.id
      deps.summaryStore.upsert(channel.id, '', watermarkId)
      // Cache isn't channel-specific, but clearing here forces the next turn
      // to recreate the cache fresh — useful when /clear is being used to
      // recover from a confused state, not just to drop history.
      gemini.clearCache?.()
      return interaction.reply({
        content: `🧹 cleared context for <#${channel.id}>. Gem will start fresh from messages newer than the slash command.`,
        ephemeral: true,
      })
    }

    if (subcommand === 'compact') {
      const channel = interaction.options.getChannel('channel') ?? interaction.channel
      if (!channel) {
        return interaction.reply({ content: '❌ No channel resolved (run from inside a channel or pass the channel arg).', ephemeral: true })
      }
      // Defer because summarization can take a few seconds (LLM call).
      await interaction.deferReply({ ephemeral: true })
      try {
        const result = await deps.summarizer.runForChannel(channel.id)
        if (!result) {
          return interaction.editReply({
            content: `📝 nothing to compact in <#${channel.id}> — no new messages since the last rollup.`,
          })
        }
        return interaction.editReply({
          content: `📝 compacted <#${channel.id}>: rolled up ${result.messageCount} message${result.messageCount === 1 ? '' : 's'} into the channel summary.`,
        })
      } catch (e: any) {
        return interaction.editReply({ content: `❌ compact failed: ${e?.message ?? e}` })
      }
    }

    // /gemini settings — read-only dump of every RESOLVED setting for a channel.
    // Unified across the three squad bots (gpt/llm have the same layout): one
    // fenced block, `key : value (default X)`. Shows the effective value (per-
    // channel pick if set, else the env/code default) so there's no guessing.
    if (subcommand === 'settings') {
      const channel = interaction.options.getChannel('channel') ?? interaction.channel
      if (!channel) {
        return interaction.reply({ content: '❌ No channel resolved (run from inside a channel or pass the channel arg).', ephemeral: true })
      }
      const f = access.channelFlags(channel.id)
      // Engine: per-channel pick, else the GEMMA_AGY_CHAT env default.
      const envEngine = process.env.GEMMA_AGY_CHAT === '1' ? 'agy' : 'api'
      const engine = f.engine ?? `${envEngine} (env default)`
      // Models are env-level (not per-channel): show the one for the active engine.
      const apiModel = process.env.GEMINI_MODEL || 'gemini-3-flash-preview'
      const agyModel = process.env.GEMMA_AGY_MODEL || 'Gemini 3.5 Flash (Medium)'
      const lingerMs = Number(process.env.GEMINI_THOUGHT_LINGER_MS) || 60_000
      const failsafeMs = Math.max(60_000, Number(process.env.GEMINI_COLLAPSE_FAILSAFE_MS ?? '600000'))
      const rows: Array<[string, string]> = [
        ['engine', String(engine)],
        ['api model', apiModel],
        ['agy model', agyModel],
        ['thinking', `${f.thinking} (default off)`],
        ['trace', `${f.trace} (default off)`],
        ['counter', `${f.counter} (default both)`],
        ['cache', `${f.cache} (default true)`],
        ['cache ttl', f.cacheTtlSec != null ? `${f.cacheTtlSec}s` : 'default'],
        ['require @', f.requireMention ? 'yes' : 'no'],
        ['collapse linger', `${Math.round(lingerMs / 1000)}s`],
        ['collapse failsafe', `${Math.round(failsafeMs / 1000)}s`],
      ]
      const pad = Math.max(...rows.map(([k]) => k.length))
      const body = rows.map(([k, v]) => `${k.padEnd(pad)} : ${v}`).join('\n')
      const card = `⚙️ **gemini settings** — <#${channel.id}>\n\`\`\`\n${body}\n\`\`\``
      return interaction.reply({ content: card, ephemeral: true })
    }

    // /gemini mention on|off — dedicated require-@ setter, unified with /gpt and
    // /llm (replaces the old `/gemini set flag:require_mention` path, which stays
    // for back-compat but is no longer the documented way).
    if (subcommand === 'mention') {
      const value = interaction.options.getString('value', true).trim().toLowerCase()
      const channel = interaction.options.getChannel('channel') ?? interaction.channel
      if (!channel) {
        return interaction.reply({ content: '❌ No channel resolved (run from inside a channel or pass the channel arg).', ephemeral: true })
      }
      if (!['on', 'off'].includes(value)) {
        return interaction.reply({ content: `❌ \`mention\` must be on | off (got \`${value}\`)`, ephemeral: true })
      }
      try {
        const updated = await access.setChannelFlags(channel.id, { requireMention: value === 'on' })
        return interaction.reply({ content: `✅ <#${channel.id}> require-mention = \`${value}\` (${updated.requireMention}).`, ephemeral: true })
      } catch (e: any) {
        return interaction.reply({ content: `❌ ${e.message}`, ephemeral: true })
      }
    }

    if (subcommand === 'backfill') {
      const channel = interaction.options.getChannel('channel', true) as TextChannel
      const limit = interaction.options.getInteger('limit') ?? 100

      // Throttle between embed calls so a 500-message backfill doesn't fire
      // 500 sequential API hits in <1s. 100ms is well below Gemini's
      // documented rate limits but enough to keep this from looking like an
      // attack pattern. Override via GEMINI_BACKFILL_DELAY_MS.
      const interDelayMs = parseInt(process.env.GEMINI_BACKFILL_DELAY_MS ?? '100', 10)

      await interaction.reply({ content: `⏳ Beginning backfill for <#${channel.id}> (max ${limit} messages). This might take a while...`, ephemeral: true })

      try {
        const messages = await channel.messages.fetch({ limit })
        let count = 0
        for (const msg of messages.values()) {
          if (!msg.content || msg.content.trim().length === 0) continue
          try {
            const emb = await gemini.embed(msg.content)
            insertMessage(msg.id, msg.channelId, msg.author.username, msg.content, msg.createdAt.toISOString(), emb)
            count++
            if (interDelayMs > 0) {
              await new Promise(resolve => setTimeout(resolve, interDelayMs))
            }
          } catch (e) {
             console.error(`Failed to embed msg ${msg.id}:`, e)
          }
        }
        return interaction.followUp({ content: `✅ Backfill complete. Embedded ${count} messages into semantic memory.`, ephemeral: true })
      } catch (e: any) {
        return interaction.followUp({ content: `❌ Backfill failed: ${e.message}`, ephemeral: true })
      }
    }

    if (subcommand === 'stop') {
      const killed = activeTurns.stop(interaction.channelId)
      return interaction.reply({
        content: killed ? '🛑 Turn aborted.' : '✅ No turn in progress.',
        ephemeral: true,
      })
    }
  } catch (error: any) {
    console.error('/gemini command error:', error)
    if (!interaction.replied) {
      return interaction.reply({ content: `❌ Error executing command: ${error.message}`, ephemeral: true })
    } else {
      return interaction.followUp({ content: `❌ Error executing command: ${error.message}`, ephemeral: true })
    }
  }
}
