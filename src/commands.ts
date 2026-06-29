import { SlashCommandBuilder, PermissionFlagsBits, ChatInputCommandInteraction, TextChannel } from 'discord.js'
import path from 'node:path'
import os from 'node:os'
import { AccessManager, type ThinkingMode, type ChatEngine, type CounterMode, type TraceMode } from './access.ts'
import { PersonaLoader } from './persona.ts'
import { GeminiClient } from './gemini.ts'
import { GeminiCacheManager } from './cache.ts'
import { insertMessage } from './db.ts'
import { rewriteEnvVar, scheduleSelfRestart } from './restart.ts'

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
      .addStringOption(option => option.setName('filename').setDescription('The persona filename (e.g. persona.md)').setRequired(true))
  )
  // Switch the GEMINI_MODEL env var and auto-restart so the new model takes
  // effect. Choices are pinned to known-good IDs — Gemini's model namespace
  // mutates often (deprecations, alias renames) so we don't accept arbitrary
  // strings. Add new entries here when a new model is qualified.
  .addSubcommand(subcommand =>
    subcommand
      .setName('model')
      .setDescription('Switch the api OR agy model (auto-restarts gemma)')
      // Which engine's model to rewrite. api → GEMINI_MODEL (native API engine);
      // agy → GEMMA_AGY_MODEL (Antigravity CLI engine). Omit and it defaults to
      // the current channel's engine pick (or api when ambiguous). No-arg /gemini
      // model (no engine, no value) shows BOTH current models.
      .addStringOption(option => option
        .setName('engine')
        .setDescription('which engine model to set: api (GEMINI_MODEL) | agy (GEMMA_AGY_MODEL). Default: channel engine.')
        .setRequired(false)
        .addChoices(
          { name: 'api — the metered Gemini API model (GEMINI_MODEL)', value: 'api' },
          { name: 'agy — the Antigravity CLI flat-sub model (GEMMA_AGY_MODEL)', value: 'agy' },
        )
      )
      // The API model id (engine=api). Pinned to known-good Gemini ids — the
      // namespace mutates (deprecations, alias renames), so we don't accept
      // arbitrary strings. Add entries here as new models qualify.
      .addStringOption(option => option
        .setName('id')
        .setDescription('omit to show current; the API model id to switch to (engine=api)')
        .setRequired(false)
        .addChoices(
          { name: 'gemini-3-pro-preview — strongest reasoning, ~10x cost', value: 'gemini-3-pro-preview' },
          { name: 'gemini-3.5-flash — newer, repriced ~5x ($1.50/$9.00 per 1M)', value: 'gemini-3.5-flash' },
          { name: 'gemini-3-flash-preview — balanced default', value: 'gemini-3-flash-preview' },
          { name: 'gemini-3.1-flash-lite-preview — cheapest, low-latency', value: 'gemini-3.1-flash-lite-preview' },
        )
      )
      // The agy model (engine=agy). MUST be a full agy display string from
      // `agy models`, NOT an API id — agy's --model expects exactly these. The
      // choice list is what blocks a user from setting an API-style id as the
      // agy model (the handler also re-validates against this set).
      .addStringOption(option => option
        .setName('agy_model')
        .setDescription('omit to show current; the agy display model to switch to (engine=agy)')
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
  // Per-channel chat engine. agy = Antigravity CLI (flat Google sub, no visible
  // tool-trace); api = the metered Gemini API (full tools + grounding + trace).
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
          { name: 'agy — Antigravity CLI / flat Google sub (no tool-trace)', value: 'agy' },
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
  .addSubcommand(subcommand =>
    subcommand
      .setName('set')
      .setDescription('Set a per-channel flag: show_code | require_mention. (thinking + footer have own subcommands.)')
      .addStringOption(option => option
        .setName('flag')
        .setDescription('Which flag to set')
        .setRequired(true)
        .addChoices(
          { name: 'show_code — render code/tool artifacts + 🔍 web-search', value: 'show_code' },
          { name: 'require_mention — only respond when @-mentioned', value: 'require_mention' },
        )
      )
      .addStringOption(option => option
        .setName('value')
        .setDescription('show_code / require_mention: true|false.')
        .setRequired(true)
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
        content: `✅ <#${channel.id}> configured. enabled=${enabled}, requireMention=${requireMention}. other flags (thinking=${flags.thinking}, showCode=${flags.showCode}, trace=${flags.trace}, counter=${flags.counter}, cache=${flags.cache}) — change via \`/gemini set\`, \`/gemini trace\`, \`/gemini counter\` or \`/gemini cache\`.`,
        ephemeral: true
      })
    }

    if (subcommand === 'persona') {
      const filename = interaction.options.getString('filename', true)
      await persona.load(filename)
      return interaction.reply({ content: `✅ Persona swapped to \`${filename}\`.`, ephemeral: true })
    }

    // /gemini model — switch EITHER engine's model. api -> rewrite GEMINI_MODEL
    // (native API engine), agy -> rewrite GEMMA_AGY_MODEL (Antigravity CLI). Both
    // take effect the same way: write the .env var, ack, then detach a delayed
    // `systemctl --user restart gemma` so the new value is read on next boot.
    // Per-channel agy model isn't threaded (it would mirror the engine pick); the
    // env-var + restart path matches how the API model already works, so the two
    // engines stay consistent. Choices in the builder pin valid values per engine.
    if (subcommand === 'model') {
      const engineArg = interaction.options.getString('engine')?.trim().toLowerCase()
      const apiModel = interaction.options.getString('id')
      const agyModel = interaction.options.getString('agy_model')

      // No engine + no value at all -> show BOTH current models.
      if (!engineArg && !apiModel && !agyModel) {
        const curApi = process.env.GEMINI_MODEL || '(default \u2014 GEMINI_MODEL not set; falls back to gemini-3-flash-preview)'
        const curAgy = process.env.GEMMA_AGY_MODEL || '(default \u2014 GEMMA_AGY_MODEL not set; falls back to Gemini 3.5 Flash (Medium))'
        return interaction.reply({
          content: `\ud83e\udd16 Current models:\n\u2022 **api** (GEMINI_MODEL): \`${curApi}\`\n\u2022 **agy** (GEMMA_AGY_MODEL): \`${curAgy}\``,
          ephemeral: true,
        })
      }

      // Resolve which engine we're setting. Explicit `engine` arg wins; else
      // infer from the value option the user filled; else default to the current
      // channel's engine pick (or api when ambiguous / no per-channel pick).
      let targetEngine: ChatEngine
      if (engineArg === 'api' || engineArg === 'agy') {
        targetEngine = engineArg
      } else if (apiModel && !agyModel) {
        targetEngine = 'api'
      } else if (agyModel && !apiModel) {
        targetEngine = 'agy'
      } else if (apiModel && agyModel) {
        return interaction.reply({
          content: '\u274c Pass either `id` (api model) or `agy_model` (agy model), not both \u2014 or set `engine` to disambiguate.',
          ephemeral: true,
        })
      } else {
        // engine given without a value: default to the current channel's engine,
        // falling back to the GEMMA_AGY_CHAT env default, then api.
        const chId = interaction.channel?.id
        targetEngine = (chId ? access.channelFlags(chId).engine : null)
          ?? (process.env.GEMMA_AGY_CHAT === '1' ? 'agy' : 'api')
      }

      // Pick the value + env key for the resolved engine.
      const envKey = targetEngine === 'agy' ? 'GEMMA_AGY_MODEL' : 'GEMINI_MODEL'
      const newModel = targetEngine === 'agy' ? agyModel : apiModel

      if (!newModel) {
        // engine chosen but no matching value -> show that engine's current model.
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

    // /gemini thinking always|auto|collapse|never — gates the 💭 thinking block
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

    if (subcommand === 'set') {
      const flag = interaction.options.getString('flag', true)
      const rawValue = interaction.options.getString('value', true).trim().toLowerCase()
      const channel = interaction.options.getChannel('channel') ?? interaction.channel
      if (!channel) {
        return interaction.reply({ content: '❌ No channel resolved (run from inside a channel or pass the channel arg).', ephemeral: true })
      }

      try {
        let updated
        if (flag === 'show_code' || flag === 'require_mention') {
          // Accept canonical bool tokens. Reject anything ambiguous so the
          // user knows they typed something wrong vs. silently being parsed
          // as false.
          const truthy = ['true', 't', 'yes', 'y', 'on', '1']
          const falsy = ['false', 'f', 'no', 'n', 'off', '0']
          let parsed: boolean
          if (truthy.includes(rawValue)) parsed = true
          else if (falsy.includes(rawValue)) parsed = false
          else {
            return interaction.reply({
              content: `❌ \`${flag}\` value must be true or false (got \`${rawValue}\`)`,
              ephemeral: true
            })
          }
          const fieldKey = flag === 'show_code' ? 'showCode' : 'requireMention'
          updated = await access.setChannelFlags(channel.id, { [fieldKey]: parsed })
        } else {
          return interaction.reply({
            content: `❌ unknown flag \`${flag}\`. Choices: show_code, require_mention. (thinking via \`/gemini thinking\`, footer via \`/gemini counter\`, cache via \`/gemini cache on|off\`.)`,
            ephemeral: true
          })
        }

        const summary = `thinking=${updated.thinking}, showCode=${updated.showCode}, counter=${updated.counter}, cache=${updated.cache}, requireMention=${updated.requireMention}`
        return interaction.reply({
          content: `✅ <#${channel.id}> \`${flag}\` set. ${summary}`,
          ephemeral: true
        })
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
      const rows: Array<[string, string]> = [
        ['engine', String(engine)],
        ['api model', apiModel],
        ['agy model', agyModel],
        ['thinking', `${f.thinking} (default off)`],
        ['trace', `${f.trace} (default off)`],
        ['counter', `${f.counter} (default both)`],
        ['show code', `${f.showCode} (default true)`],
        ['cache', `${f.cache} (default true)`],
        ['cache ttl', f.cacheTtlSec != null ? `${f.cacheTtlSec}s` : 'default'],
        ['require @', f.requireMention ? 'yes' : 'no'],
        ['collapse linger', `${Math.round(lingerMs / 1000)}s`],
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
  } catch (error: any) {
    console.error('/gemini command error:', error)
    if (!interaction.replied) {
      return interaction.reply({ content: `❌ Error executing command: ${error.message}`, ephemeral: true })
    } else {
      return interaction.followUp({ content: `❌ Error executing command: ${error.message}`, ephemeral: true })
    }
  }
}
