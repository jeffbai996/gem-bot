/**
 * /voice slash commands — minimal v1 surface for gem-voice integration.
 *
 * Just two subcommands: join (bot follows you into your current vc),
 * leave (bot disconnects).
 */
import { SlashCommandBuilder, ChatInputCommandInteraction, GuildMember } from 'discord.js'
import type { VoiceManager } from './voice.ts'
import type { PersonaLoader } from './persona.ts'

export const voiceCommand = new SlashCommandBuilder()
  .setName('voice')
  .setDescription('Bring Gem into a voice channel for a live conversation')
  .addSubcommand(s =>
    s.setName('join').setDescription("Join the voice channel you're currently in")
  )
  .addSubcommand(s =>
    s.setName('leave').setDescription('Disconnect from the voice channel')
  )

export async function executeVoiceCommand(
  interaction: ChatInputCommandInteraction,
  voiceManager: VoiceManager,
  persona: PersonaLoader,
  ownerUserId: string | undefined,
): Promise<void> {
  // Access control: only the configured owner can summon. Mirrors the
  // gem-voice v0.1 design (owner-only). Falls through to "no one" if env unset.
  if (!ownerUserId || interaction.user.id !== ownerUserId) {
    await interaction.reply({
      content: '🔒 voice is owner-only in v0.1.',
      ephemeral: true,
    })
    return
  }

  const sub = interaction.options.getSubcommand()

  if (sub === 'join') {
    await handleJoin(interaction, voiceManager, persona)
    return
  }
  if (sub === 'leave') {
    await handleLeave(interaction, voiceManager)
    return
  }
}

async function handleJoin(
  interaction: ChatInputCommandInteraction,
  voiceManager: VoiceManager,
  persona: PersonaLoader,
): Promise<void> {
  if (!interaction.guildId || !interaction.guild) {
    await interaction.reply({ content: '❌ /voice can only be used in a guild.', ephemeral: true })
    return
  }

  const member = interaction.member
  if (!(member instanceof GuildMember)) {
    await interaction.reply({ content: '❌ could not resolve your member info.', ephemeral: true })
    return
  }

  const vc = member.voice?.channel
  if (!vc) {
    await interaction.reply({
      content: "❌ you're not in a voice channel — join one first, then run /voice join.",
      ephemeral: true,
    })
    return
  }

  await interaction.deferReply({ ephemeral: true })

  // Compose persona system prompt from the same loader gemma uses for text.
  // Use the channel + guild context so guild-specific personas apply.
  const systemPrompt = persona.buildSystemPrompt(interaction.channelId, interaction.guildId)

  const result = await voiceManager.start({
    guildId: interaction.guildId,
    channelId: vc.id,
    ownerUserId: interaction.user.id,
    persona: {
      name: 'Gem',
      system_prompt: systemPrompt,
    },
  })

  if (!result.ok) {
    await interaction.editReply({
      content: `❌ voice join failed: ${result.error}`,
    })
    return
  }

  await interaction.editReply({
    content: `🎙️ joined <#${vc.id}>. say something.`,
  })
}

async function handleLeave(
  interaction: ChatInputCommandInteraction,
  voiceManager: VoiceManager,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true })

  const result = await voiceManager.stop()
  if (!result.ok) {
    await interaction.editReply({ content: `❌ leave failed: ${result.error}` })
    return
  }

  await interaction.editReply({
    content: result.wasActive ? '👋 left the voice channel.' : '🤷 no active voice session.',
  })
}
