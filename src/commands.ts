import { SlashCommandBuilder, PermissionFlagsBits, ChatInputCommandInteraction } from 'discord.js'
import { AccessManager } from './access.ts'
import { PersonaLoader } from './persona.ts'

export const geminiCommand = new SlashCommandBuilder()
  .setName('gemini')
  .setDescription('Admin controls for the Gemma bot')
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
      .setDescription('Configure bot access for a channel')
      .addChannelOption(option => option.setName('channel').setDescription('The channel to configure').setRequired(true))
      .addBooleanOption(option => option.setName('enabled').setDescription('Enable bot in this channel').setRequired(true))
      .addBooleanOption(option => option.setName('require_mention').setDescription('Require explicit mention').setRequired(true))
      .addStringOption(option => option
        .setName('thinking')
        .setDescription('When to render the 💭 thinking block (default: auto)')
        .setRequired(false)
        .addChoices(
          { name: 'always — force CoT block on every reply', value: 'always' },
          { name: 'auto — Gemma decides per message', value: 'auto' },
          { name: 'never — suppress CoT block entirely', value: 'never' }
        )
      )
      .addBooleanOption(option => option
        .setName('show_code')
        .setDescription('Render code-execution artifacts (default: false)')
        .setRequired(false)
      )
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
  .addSubcommand(subcommand =>
    subcommand
      .setName('thinking')
      .setDescription('Quick toggle: set thinking mode for a channel (defaults to current channel)')
      .addStringOption(option => option
        .setName('mode')
        .setDescription('When to render the 💭 thinking block')
        .setRequired(true)
        .addChoices(
          { name: 'always — force CoT block on every reply', value: 'always' },
          { name: 'auto — Gemma decides per message', value: 'auto' },
          { name: 'never — suppress CoT block entirely', value: 'never' }
        )
      )
      .addChannelOption(option => option.setName('channel').setDescription('Channel (defaults to current)').setRequired(false))
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('showcode')
      .setDescription('Quick toggle: render code-execution artifacts (defaults to current channel)')
      .addBooleanOption(option => option.setName('enabled').setDescription('Show code artifacts').setRequired(true))
      .addChannelOption(option => option.setName('channel').setDescription('Channel (defaults to current)').setRequired(false))
  )

  export async function executeGeminiCommand(interaction: ChatInputCommandInteraction, access: AccessManager, persona: PersonaLoader, gemini: GeminiClient, adminUserId?: string) {
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

    if (subcommand === 'channel') {
      const channel = interaction.options.getChannel('channel', true)
      const enabled = interaction.options.getBoolean('enabled', true)
      const requireMention = interaction.options.getBoolean('require_mention', true)
      const thinking = (interaction.options.getString('thinking') ?? 'auto') as 'always' | 'auto' | 'never'
      const showCode = interaction.options.getBoolean('show_code') ?? false
      await access.setChannel(channel.id, enabled, requireMention, { thinking, showCode })
      return interaction.reply({
        content: `✅ Channel <#${channel.id}> configured. Enabled: ${enabled}, Require Mention: ${requireMention}, Thinking: ${thinking}, Show Code: ${showCode}.`,
        ephemeral: true
      })
    }

    if (subcommand === 'persona') {
      const filename = interaction.options.getString('filename', true)
      await persona.load(filename)
      return interaction.reply({ content: `✅ Persona swapped to \`${filename}\`.`, ephemeral: true })
    }

    if (subcommand === 'thinking') {
      const mode = interaction.options.getString('mode', true) as 'always' | 'auto' | 'never'
      const channel = interaction.options.getChannel('channel') ?? interaction.channel
      if (!channel) {
        return interaction.reply({ content: '❌ No channel resolved (run from inside a channel or pass the channel arg).', ephemeral: true })
      }
      try {
        const updated = await access.setChannelFlags(channel.id, { thinking: mode })
        return interaction.reply({
          content: `✅ <#${channel.id}> thinking → \`${mode}\` (showCode=${updated.showCode}, requireMention=${updated.requireMention})`,
          ephemeral: true
        })
      } catch (e: any) {
        return interaction.reply({ content: `❌ ${e.message}`, ephemeral: true })
      }
    }

    if (subcommand === 'showcode') {
      const enabled = interaction.options.getBoolean('enabled', true)
      const channel = interaction.options.getChannel('channel') ?? interaction.channel
      if (!channel) {
        return interaction.reply({ content: '❌ No channel resolved (run from inside a channel or pass the channel arg).', ephemeral: true })
      }
      try {
        const updated = await access.setChannelFlags(channel.id, { showCode: enabled })
        return interaction.reply({
          content: `✅ <#${channel.id}> showCode → \`${enabled}\` (thinking=${updated.thinking}, requireMention=${updated.requireMention})`,
          ephemeral: true
        })
      } catch (e: any) {
        return interaction.reply({ content: `❌ ${e.message}`, ephemeral: true })
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
