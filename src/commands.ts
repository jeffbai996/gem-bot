import { SlashCommandBuilder, PermissionFlagsBits, ChatInputCommandInteraction, TextChannel } from 'discord.js'
import { AccessManager, type ThinkingMode } from './access.ts'
import { PersonaLoader } from './persona.ts'
import { GeminiClient } from './gemini.ts'
import { GeminiCacheManager } from './cache.ts'
import { insertMessage } from './db.ts'

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
  .addSubcommand(subcommand =>
    subcommand
      .setName('backfill')
      .setDescription('Backfill historical messages into semantic memory')
      .addChannelOption(option => option.setName('channel').setDescription('Channel to scrape').setRequired(true))
      .addIntegerOption(option => option.setName('limit').setDescription('Max messages to embed').setMinValue(1).setMaxValue(500).setRequired(false))
  )
  // Unified per-flag setter. Replaces individual /gemini thinking|showcode|
  // verbose subcommands. `value` is a string because values vary per flag
  // (thinking: always|auto|never; others: true|false). The handler validates.
  // `cache on/off` lives under the cache subcommand group below since it
  // shares semantics with cache info|ttl|flush.
  .addSubcommand(subcommand =>
    subcommand
      .setName('set')
      .setDescription('Set a per-channel flag (thinking, show_code, verbose). Defaults to current channel.')
      .addStringOption(option => option
        .setName('flag')
        .setDescription('Which flag to set')
        .setRequired(true)
        .addChoices(
          { name: 'thinking — when to render the 💭 thinking block', value: 'thinking' },
          { name: 'show_code — render code/tool artifacts + 🔍 web-search', value: 'show_code' },
          { name: 'verbose — usage/timing footer + 🧠 reasoning block', value: 'verbose' },
        )
      )
      .addStringOption(option => option
        .setName('value')
        .setDescription('thinking: always|auto|never. show_code/verbose: true|false.')
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
    // Other flags (thinking/showcode/verbose/optinreply/cache) have dedicated
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
        content: `✅ <#${channel.id}> configured. enabled=${enabled}, requireMention=${requireMention}. other flags (thinking=${flags.thinking}, showCode=${flags.showCode}, verbose=${flags.verbose}, cache=${flags.cache}) — change via \`/gemini set\` or \`/gemini cache\`.`,
        ephemeral: true
      })
    }

    if (subcommand === 'persona') {
      const filename = interaction.options.getString('filename', true)
      await persona.load(filename)
      return interaction.reply({ content: `✅ Persona swapped to \`${filename}\`.`, ephemeral: true })
    }

    // Unified per-flag setter — replaces /gemini thinking|showcode|verbose.
    // optInReply was dropped 2026-05-02 (gate behavior was confusing in
    // practice). Cache toggle stays under the cache subcommand group below.
    if (subcommand === 'set') {
      const flag = interaction.options.getString('flag', true)
      const rawValue = interaction.options.getString('value', true).trim().toLowerCase()
      const channel = interaction.options.getChannel('channel') ?? interaction.channel
      if (!channel) {
        return interaction.reply({ content: '❌ No channel resolved (run from inside a channel or pass the channel arg).', ephemeral: true })
      }

      try {
        let updated
        if (flag === 'thinking') {
          if (!['always', 'auto', 'never'].includes(rawValue)) {
            return interaction.reply({
              content: `❌ \`thinking\` value must be one of: always, auto, never (got \`${rawValue}\`)`,
              ephemeral: true
            })
          }
          updated = await access.setChannelFlags(channel.id, { thinking: rawValue as ThinkingMode })
        } else if (flag === 'show_code' || flag === 'verbose') {
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
          const fieldKey = flag === 'show_code' ? 'showCode' : 'verbose'
          updated = await access.setChannelFlags(channel.id, { [fieldKey]: parsed })
        } else {
          return interaction.reply({
            content: `❌ unknown flag \`${flag}\`. Choices: thinking, show_code, verbose. (cache toggles via \`/gemini cache on|off\`.)`,
            ephemeral: true
          })
        }

        const summary = `thinking=${updated.thinking}, showCode=${updated.showCode}, verbose=${updated.verbose}, cache=${updated.cache}`
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

    if (subcommand === 'backfill') {
      const channel = interaction.options.getChannel('channel', true) as TextChannel
      const limit = interaction.options.getInteger('limit') ?? 100
      
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
