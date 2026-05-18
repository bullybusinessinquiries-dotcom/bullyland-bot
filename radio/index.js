// radio/index.js — Bully Radio entry point
//
// Usage in bot.js (inside the client 'ready' handler):
//   require('./radio')(client);
//
// This module wires all subsystems together and is completely self-contained.
// It adds its own interactionCreate listener so it doesn't touch any existing
// bot.js interaction handlers.

const config          = require('./config');
const { Queue }           = require('./queue');
const { IntermissionSystem } = require('./intermissions');
const { RadioEngine }     = require('./engine');
const { NowPlayingManager } = require('./nowplaying');
const { PresenceManager }   = require('./presence');
const { registerCommands, handleInteraction } = require('./commands');

async function initRadio(client) {
  console.log('[Radio] Initialising Bully Radio...');

  // ── Validate required env vars ───────────────────────────────────────────
  if (!config.VOICE_CHANNEL_ID) {
    console.error('[Radio] ⚠  RADIO_VOICE_CHANNEL_ID is not set — radio will not start.');
    console.error('[Radio]    Add it to your .env file and restart.');
    return;
  }

  // ── Instantiate subsystems ───────────────────────────────────────────────
  const queue        = new Queue();
  const intermissions = new IntermissionSystem();
  const nowPlaying   = new NowPlayingManager();
  const presence     = new PresenceManager();

  // ── Initial file scans ───────────────────────────────────────────────────
  queue.scan();
  intermissions.scan();

  // ── Now-playing message channel ──────────────────────────────────────────
  if (config.TEXT_CHANNEL_ID) {
    nowPlaying.init(client, config.TEXT_CHANNEL_ID);
  } else {
    console.log('[Radio] RADIO_TEXT_CHANNEL_ID not set — now-playing messages disabled.');
  }

  // ── Audio engine ─────────────────────────────────────────────────────────
  const engine = new RadioEngine({ queue, intermissions, nowPlaying });
  engine.init(client);

  try {
    await engine.connect();
    engine._advance(); // kick off the first track
  } catch (err) {
    console.error('[Radio] Could not connect to voice channel:', err.message);
    console.error('[Radio]    Check RADIO_VOICE_CHANNEL_ID and that the bot has Connect + Speak permissions.');
    // Retry after 30 seconds in case of a transient startup issue
    setTimeout(async () => {
      try {
        await engine.connect();
        engine._advance();
      } catch (retryErr) {
        console.error('[Radio] Retry failed:', retryErr.message);
      }
    }, 30_000);
  }

  // ── Periodic rescan — new files enter rotation without restart ───────────
  setInterval(() => {
    queue.scan();
    intermissions.scan();
  }, config.RESCAN_INTERVAL_MS);

  // ── Rotate bot presence ──────────────────────────────────────────────────
  presence.start(client, config.PRESENCE_ROTATE_MS);

  // ── Register slash commands ──────────────────────────────────────────────
  await registerCommands(client.user.id, process.env.DISCORD_TOKEN, config.GUILD_ID);

  // ── Slash command interaction listener ───────────────────────────────────
  // Only handles radio-* commands — all other interactions pass through untouched.
  client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    if (!interaction.commandName.startsWith('radio-')) return;
    try {
      await handleInteraction(interaction, engine, queue, intermissions);
    } catch (err) {
      console.error('[Radio] Command error:', err.message);
      interaction.reply({ content: 'Something went wrong.', ephemeral: true }).catch(() => {});
    }
  });

  console.log('[Radio] 📻 Bully Radio is live.');
  return engine; // expose for any future integrations
}

module.exports = initRadio;
