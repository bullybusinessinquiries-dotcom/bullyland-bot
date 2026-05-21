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

    // AutoPaused means the voice connection isn't ready yet.
    // Keep retrying unpause every 2 seconds — the player will resume
    // automatically once the connection reaches Ready state.
    this._player.on(AudioPlayerStatus.AutoPaused, () => {
      console.warn('[Radio] AudioPlayer AutoPaused — will keep retrying until connection is ready...');
      this._startAutoPausedRetry();
    });

    // Broken stream — skip to next after a brief pause
    this._player.on('error', err => {
      console.error('[Radio] Playback error:', err.message, '— skipping track');
      setTimeout(() => this._advance(), 1_500);
    });
  }

  init(client) {
    this._client        = client;
    this._started       = false;
    this._autoPauseTimer = null;
  }

  // ── Keep retrying unpause while AutoPaused ────────────────────────────────
  // @discordjs/voice will transition the player from AutoPaused → Playing
  // automatically when the voice connection reaches Ready. This just prods
  // it every 2 seconds in case that automatic transition doesn't fire.
  _startAutoPausedRetry() {
    if (this._autoPauseTimer) return; // already retrying
    this._autoPauseTimer = setInterval(() => {
      const status = this._player.state.status;
      if (status !== AudioPlayerStatus.AutoPaused) {
        clearInterval(this._autoPauseTimer);
        this._autoPauseTimer = null;
        console.log('[Radio] AutoPaused resolved — broadcast resuming.');
        return;
      }
      this._player.unpause();
    }, 2_000);
  }

  // ── Join the configured voice channel ────────────────────────────────────
  // Playback does NOT start here — it starts when the Ready event fires
  // in _watchConnection(). This prevents AutoPaused caused by playing
  // before the Discord voice handshake is fully complete.
  async connect() {
    if (!config.VOICE_CHANNEL_ID) {
      console.error('[Radio] RADIO_VOICE_CHANNEL_ID is not set in .env — radio disabled.');
      return;
    }

    const { getVoiceConnection } = require('@discordjs/voice');
    const guild = await this._client.guilds.fetch(config.GUILD_ID);

    // Destroy any stale connection left over from a previous deployment.
    // A lingering session_id causes Discord to immediately close the voice
    // WebSocket (state 1→6) on every IDENTIFY attempt, creating an endless cycle.
    const stale = getVoiceConnection(config.GUILD_ID);
    if (stale) {
      console.log('[Radio] Destroying stale voice connection from previous session...');
      stale.destroy();
      await new Promise(r => setTimeout(r, 2_000));
    }

    // Also clear any cached voice state the bot is registered as being in
    const me = guild.members.me ?? await guild.members.fetchMe();
    if (me?.voice?.channelId) {
      console.log('[Radio] Clearing stale cached voice state...');
      await me.voice.disconnect().catch(() => {});
      await new Promise(r => setTimeout(r, 2_000));
    }

    // ── Raw gateway diagnostic ────────────────────────────────────────────
    // Intercept the raw VOICE_STATE_UPDATE and VOICE_SERVER_UPDATE events
    // from the Discord gateway to capture session_id, token, and endpoint.
    // Then do a MANUAL WebSocket connection to the voice server to get the
    // exact response/close code — completely independent of @discordjs/voice.
    let capturedSessionId = null;

    const onRawVoiceState = (data) => {
      if (data.user_id !== this._client.user?.id) return;
      if (data.guild_id !== config.GUILD_ID) return;
      capturedSessionId = data.session_id;
      console.log('[Radio/Diag] VOICE_STATE_UPDATE → session_id:', data.session_id, '| channel_id:', data.channel_id);
    };

    const onRawVoiceServer = (data) => {
      if (data.guild_id !== config.GUILD_ID) return;
      console.log('[Radio/Diag] VOICE_SERVER_UPDATE → endpoint:', data.endpoint, '| token prefix:', data.token?.slice(0, 12));

      // Manual WebSocket test — completely bypasses @discordjs/voice
      // This shows us exactly what Discord's voice server says to our IDENTIFY
      if (!capturedSessionId) {
        console.warn('[Radio/Diag] No session_id yet — skipping manual WS test');
        return;
      }
      const WS = require('ws');
      const wsUrl = `wss://${data.endpoint}/?v=4`;
      console.log('[Radio/Diag] Manual voice WS connecting to:', wsUrl);
      const testWs = new WS(wsUrl);

      testWs.on('open', () => {
        console.log('[Radio/Diag] Manual voice WS OPEN ✓ — sending IDENTIFY...');
        testWs.send(JSON.stringify({
          op: 0,
          d: {
            server_id:  data.guild_id,
            user_id:    this._client.user.id,
            session_id: capturedSessionId,
            token:      data.token,
          },
        }));
      });
      testWs.on('message', (raw) => {
        const msg = JSON.parse(String(raw));
        console.log(`[Radio/Diag] Voice WS OP ${msg.op}:`, JSON.stringify(msg.d ?? msg.code ?? '').substring(0, 200));
      });
      testWs.on('close', (code, reason) => {
        console.log(`[Radio/Diag] Voice WS CLOSED — code: ${code} reason: ${String(reason)}`);
        testWs.terminate();
      });
      testWs.on('error', (err) => {
        console.error('[Radio/Diag] Voice WS ERROR:', err.message);
      });
    };

    this._client.ws.on('VOICE_STATE_UPDATE',  onRawVoiceState);
    this._client.ws.on('VOICE_SERVER_UPDATE', onRawVoiceServer);
    // Clean up diagnostic listeners after 60s
    setTimeout(() => {
      this._client.ws.off('VOICE_STATE_UPDATE',  onRawVoiceState);
      this._client.ws.off('VOICE_SERVER_UPDATE', onRawVoiceServer);
    }, 60_000);

    this._connection = joinVoiceChannel({
      channelId:      config.VOICE_CHANNEL_ID,
      guildId:        config.GUILD_ID,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf:       true,
      debug:          true,   // enable packet-level debug events
    });

    this._connection.subscribe(this._player);
    this._watchConnection();
    console.log('[Radio] Joining voice channel...');

    // Pipe VoiceConnection debug events (packets sent/received, DAVE, UDP)
    this._connection.on('debug', msg => {
      console.log('[Radio/Conn]', String(msg).substring(0, 500));
    });

    // Log every VoiceConnection state transition + actual networking close code
    this._connection.on('stateChange', (oldState, newState) => {
      console.log(`[Radio] Connection: ${oldState.status} → ${newState.status}`);
      if (newState.status === VoiceConnectionStatus.Connecting && newState.networking) {
        const net = newState.networking;
        // Guard against attaching duplicate listeners when connecting→connecting fires
        if (net._bullyRadioMonitored) return;
        net._bullyRadioMonitored = true;
        net.on('error', err => console.error('[Radio/Net Error]', err.message));
        // Capture the ACTUAL WebSocket close code (number) emitted by networking
        net.on('close', code => console.log('[Radio/Net Close]', code));
        net.on('stateChange', (o, n) => {
          console.log(`[Radio/Net State] ${o?.code ?? '?'} → ${n?.code ?? '?'}`);
        });
      }
    });
  }

  // ── Monitor the voice connection ──────────────────────────────────────────
  _watchConnection() {
    this._connection.on(VoiceConnectionStatus.Ready, () => {
      this._reconnecting = false;
      console.log('[Radio] Voice connection ready.');
    });

    this._connection.on(VoiceConnectionStatus.Disconnected, async () => {
      if (this._reconnecting) return;
      this._reconnecting = true;
      console.log('[Radio] Disconnected — attempting to reconnect...');

      try {
        // Discord sometimes re-establishes automatically
        await Promise.race([
          entersState(this._connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(this._connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
        this._reconnecting = false;
      } catch {
        // Didn't recover — destroy and rejoin
        try { this._connection.destroy(); } catch (_) {}
        this._reconnecting = false;

        setTimeout(async () => {
          console.log('[Radio] Rejoining voice channel...');
          try {
            await this.connect();
            // Playback resumes automatically when Ready fires above
          } catch (err) {
            console.error('[Radio] Reconnect failed:', err.message, '— retrying in 30s');
            setTimeout(() => this.connect(), 30_000);
          }
        }, config.RECONNECT_DELAY_MS);
      }
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
