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

export async function executeGeminiCommand(interaction: ChatInputCommandInteraction, access: AccessManager, persona: PersonaLoader, adminUserId?: string) {
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
  } catch (error: any) {
    console.error('/gemini command error:', error)
    return interaction.reply({ content: `❌ Error executing command: ${error.message}`, ephemeral: true })
  }
}
