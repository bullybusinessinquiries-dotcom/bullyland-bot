// radio/nowplaying.js — single persistent Now Playing embed, edited each song
//
// Strategy: send one message on first play, then edit it every track.
// If the message was deleted (manually or by Discord), it creates a new one.
// Intermissions get a minimal, atmospheric embed so they don't look like songs.
//
// On every song change, all other messages in the channel are deleted
// EXCEPT the pinned branding banner (RADIO_BANNER_ID).

const { EmbedBuilder } = require('discord.js');
const path = require('path');

// The branding banner at the top of the radio channel — never deleted
const RADIO_BANNER_ID = '1506875960233037895';

// ── Title cleaner ──────────────────────────────────────────────────────────
// "bully_song_demo_v2.mp3"  →  "Bully Song Demo V2"
// "late night - unreleased" →  "Late Night   Unreleased"
function cleanTitle(filePath) {
  const base = path.basename(filePath, path.extname(filePath));
  return base
    .replace(/[_\-\.]+/g, ' ')   // separators → spaces
    .replace(/\s+/g, ' ')        // collapse multiple spaces
    .trim()
    .replace(/\b\w/g, c => c.toUpperCase()); // title case
}

class NowPlayingManager {
  constructor() {
    this._client    = null;
    this._channelId = null;
    this._messageId = null; // ID of the persistent embed message
  }

  init(client, channelId) {
    this._client    = client;
    this._channelId = channelId;
  }

  // ── Update (or create) the now-playing embed ───────────────────────────────
  async update(filePath, isIntermission = false) {
    if (!this._client || !this._channelId) return;

    const embed = isIntermission
      ? this._buildIntermissionEmbed(filePath)
      : this._buildTrackEmbed(filePath);

    try {
      const channel = await this._client.channels.fetch(this._channelId).catch(() => null);
      if (!channel?.isTextBased()) return;

      if (this._messageId) {
        // Edit the existing message — don't create clutter
        const msg = await channel.messages.fetch(this._messageId).catch(() => null);
        if (msg) {
          await msg.edit({ embeds: [embed] });
          // Sweep any stray messages (keep banner + now-playing only)
          await this._sweepChannel(channel);
          return;
        }
        // Message was deleted — fall through and send a new one
        this._messageId = null;
      }

      const sent = await channel.send({ embeds: [embed] });
      this._messageId = sent.id;
      // Sweep any stray messages (keep banner + now-playing only)
      await this._sweepChannel(channel);
    } catch (err) {
      console.error('[Radio] Could not update now-playing message:', err.message);
    }
  }

  // ── Delete everything in the radio channel except the banner and the embed ──
  async _sweepChannel(channel) {
    try {
      const messages = await channel.messages.fetch({ limit: 100 });
      const toDelete = messages.filter(m =>
        m.id !== RADIO_BANNER_ID &&
        m.id !== this._messageId
      );
      if (toDelete.size === 0) return;
      // bulkDelete only works for messages < 14 days old; fall back one-by-one
      await channel.bulkDelete(toDelete).catch(async () => {
        for (const [, m] of toDelete) await m.delete().catch(() => {});
      });
    } catch (_) {
      // Non-fatal — sweep will retry next song
    }
  }

  // ── Embeds ─────────────────────────────────────────────────────────────────

  _buildTrackEmbed(filePath) {
    const title = cleanTitle(filePath);
    return new EmbedBuilder()
      .setColor('#0d1117')           // near-black — cinematic, not loud
      .setAuthor({ name: '📻  Bully Radio' })
      .setTitle(title)
      .setFooter({ text: 'BULLY Music  ·  always broadcasting' })
      .setTimestamp();
  }

  _buildIntermissionEmbed(filePath) {
    const title = cleanTitle(filePath);
    return new EmbedBuilder()
      .setColor('#0d1117')
      .setDescription(`*— ${title} —*`)
      .setFooter({ text: 'Bully Radio' });
    // No timestamp on intermission — they're subtle, not events
  }

  // Expose title cleaner so commands.js can reuse it
  static cleanTitle = cleanTitle;
}

module.exports = { NowPlayingManager, cleanTitle };
