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
    s.setName('call').setDescription('Live mic↔voice conversation in your current vc')
  )
  .addSubcommand(s =>
    s.setName('speak').setDescription('Join your vc; type here and Gem reads her replies aloud')
  )
  .addSubcommand(s =>
    s.setName('leave').setDescription('Disconnect from the voice channel')
  )

export async function executeVoiceCommand(
  interaction: ChatInputCommandInteraction,
  voiceManager: VoiceManager,
  persona: PersonaLoader,
  isAllowed: (userId: string) => boolean,
  tools?: import('./tools/index.ts').ToolRegistry,
  gemini?: import('./gemini.ts').GeminiClient,
): Promise<void> {
  // Access control: anyone on Gemma's allowlist can summon voice — the same
  // gate as text (access.json users). "Who can voice" tracks "who can text"
  // automatically, so adding/removing a user via /gemini flows through to
  // voice too. (Was owner-only in v0.1; opened to the text allowlist 2026-06-17
  // so 蛋宝 can talk to Gem in voice.) The summoner becomes the gem-voice
  // session owner, so audio routing follows whoever passed this gate.
  if (!isAllowed(interaction.user.id)) {
    await interaction.reply({
      content: '🔒 you need to be on Gem\'s allowlist to use voice.',
      ephemeral: true,
    })
    return
  }

  const sub = interaction.options.getSubcommand()

  if (sub === 'call') {
    await handleJoin(interaction, voiceManager, persona, tools, gemini)
    return
  }
  if (sub === 'speak') {
    await handleSpeak(interaction, voiceManager)
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
  tools?: import('./tools/index.ts').ToolRegistry,
  gemini?: import('./gemini.ts').GeminiClient,
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
      content: "❌ you're not in a voice channel — join one first, then run /voice call.",
      ephemeral: true,
    })
    return
  }

  await interaction.deferReply({ ephemeral: true })

  // Compose persona system prompt from the same loader gemma uses for text.
  // Use the channel + guild context so guild-specific personas apply.
  let systemPrompt = persona.buildSystemPrompt(interaction.channelId, interaction.guildId)

  // Voice Gemma should walk in knowing what was just said, not only the
  // long-term summary — append the live tail of the channel the command
  // came from. Best-effort: a fetch failure must never block the join.
  try {
    const channel = interaction.channel
    if (channel && 'messages' in channel) {
      const recent = await channel.messages.fetch({ limit: 20 })
      const tail = [...recent.values()]
        .reverse()
        .map(m => `${m.author.username}: ${m.cleanContent}`.slice(0, 300))
        .join('\n')
      if (tail) {
        systemPrompt += `\n\n---\n\n## Recent conversation in this channel (newest last)\n\n${tail}`
      }
    }
  } catch (e: any) {
    console.warn('[voice] recent-history fetch failed:', e?.message)
  }

  const result = await voiceManager.start({
    channel: vc,
    summonerUserId: interaction.user.id,
    ownerUserId: interaction.user.id,
    persona: {
      name: 'Gem',
      system_prompt: systemPrompt,
      // One squad-store recall at session start (daemon no-ops if the
      // store URL isn't configured).
      memory_query: 'voice call context: portfolio, squad, ongoing projects',
    },
    // Same tool belt text Gemma carries — declarations ride the join
    // payload, executions come back through the IPC bridge.
    tools,
    toolContext: gemini
      ? { channelId: interaction.channelId, userId: interaction.user.id, gemini }
      : undefined,
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

// Speak mode: join the vc for OUTPUT only (no Live session, no mic). Gem still
// replies in text + thinking trace in THIS channel like normal, and additionally
// reads each reply aloud via gem-voice's `say` TTS. No persona/tools needed —
// the text reply is built by the normal message handler; speak only voices it.
async function handleSpeak(
  interaction: ChatInputCommandInteraction,
  voiceManager: VoiceManager,
): Promise<void> {
  if (!interaction.guildId || !interaction.guild) {
    await interaction.reply({ content: '❌ /voice can only be used in a guild.', ephemeral: true })
    return
  }
  // Speak mode is text-driven and reads Gem's replies aloud while she also posts
  // them in the launch channel — so confine it to one dedicated channel, else
  // she talks over the other bots in shared channels. Channel id is env-configured
  // (never hardcoded). Unset = allowed anywhere (back-compat).
  const allowedChannel = process.env.VOICE_SPEAK_CHANNEL_ID
  if (allowedChannel && interaction.channelId !== allowedChannel) {
    await interaction.reply({
      content: `🔒 /voice speak only works in <#${allowedChannel}>.`,
      ephemeral: true,
    })
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
      content: "❌ you're not in a voice channel — join one first, then run /voice speak.",
      ephemeral: true,
    })
    return
  }

  await interaction.deferReply({ ephemeral: true })
  const result = await voiceManager.start({
    channel: vc,
    summonerUserId: interaction.user.id,
    ownerUserId: interaction.user.id,
    persona: { name: 'Gem', system_prompt: '' }, // unused in speak (no Live session)
    mode: 'speak',
    speakChannelId: interaction.channelId,
  })
  if (!result.ok) {
    await interaction.editReply({ content: `❌ voice speak failed: ${result.error}` })
    return
  }
  await interaction.editReply({
    content: `🗣️ joined <#${vc.id}> in speak mode. Type here — I'll reply in text *and* read it aloud (images/attachments work too).`,
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
