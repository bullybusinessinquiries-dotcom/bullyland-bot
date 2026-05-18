// radio/commands.js — slash command definitions, registration, and handler
//
// Commands are guild-scoped (instant update, no 1-hour global propagation delay).
// Only admins can use the control commands; /radio-nowplaying is open to all.

const {
  SlashCommandBuilder,
  REST,
  Routes,
  PermissionFlagsBits,
  EmbedBuilder,
} = require('discord.js');
const { cleanTitle } = require('./nowplaying');

// ── Command definitions ────────────────────────────────────────────────────
const COMMAND_DEFS = [
  new SlashCommandBuilder()
    .setName('radio-skip')
    .setDescription('Skip the current track')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('radio-nowplaying')
    .setDescription('Show what is currently on air'),

  new SlashCommandBuilder()
    .setName('radio-reload')
    .setDescription('Rescan music and intermission folders — live, no restart needed')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('radio-pause')
    .setDescription('Pause the broadcast')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('radio-resume')
    .setDescription('Resume the broadcast')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
].map(c => c.toJSON());

// ── Register with Discord (guild-scoped for instant availability) ──────────
async function registerCommands(clientId, token, guildId) {
  if (!guildId) {
    console.warn('[Radio] GUILD_ID not set — skipping slash command registration.');
    return;
  }
  try {
    const rest = new REST({ version: '10' }).setToken(token);
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: COMMAND_DEFS });
    console.log('[Radio] Slash commands registered (/radio-skip, /radio-nowplaying, /radio-reload, /radio-pause, /radio-resume)');
  } catch (err) {
    console.error('[Radio] Failed to register slash commands:', err.message);
  }
}

// ── Interaction handler (attached to interactionCreate by index.js) ────────
async function handleInteraction(interaction, engine, queue, intermissions) {
  if (!interaction.isChatInputCommand()) return;
  const { commandName } = interaction;
  if (!commandName.startsWith('radio-')) return;

  // Admin guard (belt-and-suspenders on top of Discord's defaultMemberPermissions)
  const isAdmin = interaction.member?.permissions?.has(PermissionFlagsBits.Administrator)
    || interaction.user.id === process.env.OWNER_ID;

  const adminCommands = ['radio-skip', 'radio-reload', 'radio-pause', 'radio-resume'];
  if (adminCommands.includes(commandName) && !isAdmin) {
    return interaction.reply({ content: 'This command is admin-only.', ephemeral: true });
  }

  // ── /radio-skip ─────────────────────────────────────────────────────────
  if (commandName === 'radio-skip') {
    engine.skip();
    return interaction.reply({ content: '⏭  Skipped.', ephemeral: true });
  }

  // ── /radio-nowplaying ────────────────────────────────────────────────────
  if (commandName === 'radio-nowplaying') {
    const track = engine.currentTrack;

    if (!track) {
      return interaction.reply({
        content: 'Nothing is playing right now.',
        ephemeral: true,
      });
    }

    const title = cleanTitle(track.path);
    const embed = new EmbedBuilder()
      .setColor('#0d1117')
      .setAuthor({ name: '📻  Bully Radio — on air now' })
      .setTitle(title)
      .addFields(
        { name: 'Status',       value: engine.isPaused ? '⏸  Paused' : '▶️  Playing', inline: true },
        { name: 'In rotation',  value: `${queue.count} tracks`,                         inline: true },
        { name: 'Clips loaded', value: `${intermissions.count}`,                         inline: true },
      )
      .setFooter({ text: 'BULLY Music' });

    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  // ── /radio-reload ────────────────────────────────────────────────────────
  if (commandName === 'radio-reload') {
    queue.scan();
    intermissions.scan();
    return interaction.reply({
      content: `🔄  Reloaded — **${queue.count}** tracks · **${intermissions.count}** intermission clips.`,
      ephemeral: true,
    });
  }

  // ── /radio-pause ─────────────────────────────────────────────────────────
  if (commandName === 'radio-pause') {
    if (engine.isPaused) {
      return interaction.reply({ content: 'Radio is already paused.', ephemeral: true });
    }
    engine.pause();
    return interaction.reply({ content: '⏸  Broadcast paused.', ephemeral: true });
  }

  // ── /radio-resume ────────────────────────────────────────────────────────
  if (commandName === 'radio-resume') {
    if (!engine.isPaused) {
      return interaction.reply({ content: 'Radio is already playing.', ephemeral: true });
    }
    engine.resume();
    return interaction.reply({ content: '▶️  Broadcast resumed.', ephemeral: true });
  }
}

module.exports = { registerCommands, handleInteraction };
