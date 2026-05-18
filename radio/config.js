// radio/config.js — all tunable constants for Bully Radio
const path = require('path');

module.exports = {
  // Discord IDs — set in .env
  GUILD_ID:         process.env.GUILD_ID,
  VOICE_CHANNEL_ID: process.env.RADIO_VOICE_CHANNEL_ID,
  TEXT_CHANNEL_ID:  process.env.RADIO_TEXT_CHANNEL_ID,

  // Local folders (relative to project root, not this file)
  MUSIC_DIR:         path.join(__dirname, '..', 'music'),
  INTERMISSIONS_DIR: path.join(__dirname, '..', 'intermissions'),

  // Supported audio formats
  AUDIO_EXTENSIONS: ['.mp3', '.wav', '.m4a', '.flac'],

  // How often to rescan /music and /intermissions for new files (ms)
  // New tracks appear in rotation without a bot restart
  RESCAN_INTERVAL_MS: 5 * 60 * 1000, // 5 minutes

  // ── Intermission probability engine ──────────────────────────────────────
  // Base chance (fraction) that an intermission plays after any given song.
  // Each song that passes WITHOUT an intermission adds a random increment
  // from [MIN, MAX], creating an unpredictable, non-linear feel.
  // After an intermission plays, chance resets to RESET value.
  INTERMISSION_BASE_CHANCE:      0.06,         // 6% starting chance
  INTERMISSION_CHANCE_INCREMENT: [0.02, 0.09], // random increment per song
  INTERMISSION_CHANCE_MAX:       0.38,         // hard ceiling (~2.6 songs/hour max)
  INTERMISSION_RESET_CHANCE:     0.04,         // resets here after one plays

  // ── Volume levels (0.0 – 1.5, inline FFmpeg volume) ──────────────────────
  MUSIC_VOLUME:        1.0,   // songs play at 100%
  INTERMISSION_VOLUME: 0.72,  // clips play quieter — softer, more subtle

  // How often to rotate bot presence/status (ms)
  PRESENCE_ROTATE_MS: 11 * 60 * 1000, // every 11 minutes (not too often)

  // Delay before reconnect attempt after being kicked from voice (ms)
  RECONNECT_DELAY_MS: 5_000,

  // Delay between retries when music folder is empty (ms)
  EMPTY_QUEUE_RETRY_MS: 15_000,
};
