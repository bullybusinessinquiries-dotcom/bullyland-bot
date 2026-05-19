// radio/engine.js — core audio engine: voice connection, playback loop, reconnect
//
// Architecture:
//   AudioPlayer  →  subscribed to by VoiceConnection
//   AudioPlayer emits Idle when a track ends  →  _advance() picks the next file
//   VoiceConnection emits Disconnected        →  reconnect loop kicks in
//   All error paths call _advance() after a brief delay so the stream never dies

const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  StreamType,
} = require('@discordjs/voice');
const path   = require('path');
const config = require('./config');

// Tell prism-media (used internally by @discordjs/voice) where FFmpeg is.
// On Railway, nixpacks.toml installs FFmpeg system-wide so it's in PATH automatically.
// Locally, ffmpeg-static provides a bundled binary as a fallback.
try {
  const ffmpegPath = require('ffmpeg-static');
  if (ffmpegPath) {
    process.env.FFMPEG_PATH = ffmpegPath; // prism-media reads this env var directly
    console.log('[Radio] FFmpeg (ffmpeg-static):', ffmpegPath);
  }
} catch (_) {
  console.log('[Radio] ffmpeg-static not found — using system FFmpeg from PATH');
}

class RadioEngine {
  constructor({ queue, intermissions, nowPlaying }) {
    this.queue        = queue;
    this.intermissions = intermissions;
    this.nowPlaying   = nowPlaying;

    this._client      = null;
    this._connection  = null;
    this._player      = createAudioPlayer();
    this._paused      = false;
    this._currentTrack = null;  // { path, isIntermission }
    this._reconnecting = false;

    // When a track finishes naturally, advance to the next
    this._player.on(AudioPlayerStatus.Idle, () => {
      if (!this._paused) this._advance();
    });

    // AutoPaused means Discord wasn't ready when playback started — resume it
    this._player.on(AudioPlayerStatus.AutoPaused, () => {
      console.warn('[Radio] AudioPlayer AutoPaused — connection not ready yet, will retry...');
      setTimeout(() => {
        if (this._player.state.status === AudioPlayerStatus.AutoPaused) {
          this._player.unpause();
        }
      }, 2_000);
    });

    // Broken stream — skip to next after a brief pause
    this._player.on('error', err => {
      console.error('[Radio] Playback error:', err.message, '— skipping track');
      setTimeout(() => this._advance(), 1_500);
    });
  }

  init(client) {
    this._client = client;
  }

  // ── Join the configured voice channel and start the reconnect watcher ──────
  async connect() {
    if (!config.VOICE_CHANNEL_ID) {
      console.error('[Radio] RADIO_VOICE_CHANNEL_ID is not set in .env — radio disabled.');
      return;
    }

    const guild = await this._client.guilds.fetch(config.GUILD_ID);

    this._connection = joinVoiceChannel({
      channelId:      config.VOICE_CHANNEL_ID,
      guildId:        config.GUILD_ID,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf:       true,  // radio doesn't need to hear users
    });

    this._connection.subscribe(this._player);
    this._watchConnection();

    // Wait for the connection to be fully ready before returning.
    // Without this, playback starts before Discord handshake completes,
    // putting the AudioPlayer into AutoPaused where it silently does nothing.
    try {
      await entersState(this._connection, VoiceConnectionStatus.Ready, 60_000);
      console.log('[Radio] Joined voice channel and connection is ready.');
    } catch {
      // Timed out waiting for Ready — proceed anyway and let the reconnect
      // watcher handle any instability
      console.warn('[Radio] Voice connection slow to ready — proceeding anyway.');
    }
  }

  // ── Monitor the voice connection and reconnect if it drops ────────────────
  _watchConnection() {
    this._connection.on(VoiceConnectionStatus.Disconnected, async () => {
      if (this._reconnecting) return;
      this._reconnecting = true;
      console.log('[Radio] Disconnected from voice — attempting to reconnect...');

      try {
        // Discord sometimes re-establishes the connection automatically
        await Promise.race([
          entersState(this._connection, VoiceConnectionStatus.Signalling,  5_000),
          entersState(this._connection, VoiceConnectionStatus.Connecting,  5_000),
        ]);
        // If we reach here, connection is coming back on its own
        this._reconnecting = false;
      } catch {
        // Connection didn't recover — destroy it and rejoin from scratch
        try { this._connection.destroy(); } catch (_) {}
        this._reconnecting = false;

        setTimeout(async () => {
          console.log('[Radio] Rejoining voice channel...');
          try {
            await this.connect();
            if (!this._paused) this._advance();
          } catch (err) {
            console.error('[Radio] Reconnect failed:', err.message, '— will retry in 30s');
            setTimeout(() => this._watchConnection(), 30_000);
          }
        }, config.RECONNECT_DELAY_MS);
      }
    });

    // Log when fully connected for diagnostics
    this._connection.on(VoiceConnectionStatus.Ready, () => {
      this._reconnecting = false;
      console.log('[Radio] Voice connection ready.');
    });
  }

  // ── Advance to the next item in the broadcast ─────────────────────────────
  // Called after a track ends, after a skip, or after a playback error.
  // Checks the intermission system before pulling from the music queue.
  _advance() {
    // Roll for intermission between songs
    const intermissionPath = this.intermissions.roll();
    if (intermissionPath) {
      this._play(intermissionPath, true);
      return;
    }

    // Pull next track from the shuffled queue
    const trackPath = this.queue.next();
    if (!trackPath) {
      console.log('[Radio] Music folder is empty — retrying in 15s...');
      setTimeout(() => this._advance(), config.EMPTY_QUEUE_RETRY_MS);
      return;
    }

    this._play(trackPath, false);
  }

  // ── Play a single file ────────────────────────────────────────────────────
  _play(filePath, isIntermission) {
    this._currentTrack = { path: filePath, isIntermission };

    try {
      const resource = createAudioResource(filePath, {
        inputType:    StreamType.Arbitrary, // let FFmpeg handle any format
        inlineVolume: true,                 // enables runtime volume control
      });

      // Intermissions play quieter — subtle, not jarring
      resource.volume.setVolume(
        isIntermission ? config.INTERMISSION_VOLUME : config.MUSIC_VOLUME,
      );

      this._player.play(resource);

      // Update the now-playing embed (non-blocking)
      this.nowPlaying.update(filePath, isIntermission).catch(() => {});

      console.log(`[Radio] ${isIntermission ? '[clip ]' : '[track]'} ${path.basename(filePath)}`);
    } catch (err) {
      console.error('[Radio] Failed to create audio resource:', err.message);
      setTimeout(() => this._advance(), 1_500);
    }
  }

  // ── Admin controls ────────────────────────────────────────────────────────

  skip() {
    // Unset pause flag so the Idle event handler will call _advance()
    this._paused = false;
    this._player.stop();
  }

  pause() {
    this._paused = true;
    this._player.pause(true); // true = interpolate for smoother audio pause
  }

  resume() {
    this._paused = false;
    this._player.unpause();
  }

  // ── Expose state for commands ─────────────────────────────────────────────
  get currentTrack() { return this._currentTrack; }
  get isPaused()     { return this._paused; }
  get isConnected()  { return this._connection?.state?.status === VoiceConnectionStatus.Ready; }
}

module.exports = { RadioEngine };
