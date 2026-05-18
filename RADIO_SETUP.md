# Bully Radio — Setup Guide

A 24/7 ambient radio system built into the existing Bullyland bot.
No second bot, no extra hosting cost.

---

## Folder Structure

```
bullyland-bot/
├── bot.js
├── radio/
│   ├── index.js          ← entry point (called from bot.js ready handler)
│   ├── config.js         ← all tunable settings
│   ├── queue.js          ← music file scanning + shuffled rotation
│   ├── intermissions.js  ← clip probability engine
│   ├── engine.js         ← voice connection + audio playback loop
│   ├── nowplaying.js     ← persistent Now Playing embed
│   ├── presence.js       ← rotating bot status
│   └── commands.js       ← slash command registration + handlers
├── music/                ← drop your songs here (.mp3 .wav .m4a .flac)
└── intermissions/        ← drop your atmospheric clips here
```

---

## Step 1 — Install Dependencies

```bash
npm install
```

New packages added to `package.json`:
- `@discordjs/voice` — Discord voice API
- `@discordjs/opus` — native Opus encoder (best performance)
- `opusscript` — pure-JS Opus fallback (used if native fails to build)
- `ffmpeg-static` — bundled FFmpeg binary (works on Windows + Railway)
- `libsodium-wrappers` — voice encryption (pure JS, no build issues)

**If `@discordjs/opus` fails to build** (rare on Railway, possible on Windows without build tools):

```bash
npm uninstall @discordjs/opus
# opusscript will be used automatically as the fallback
```

**On Windows locally**, if you hit native build errors, install:
- [Visual Studio Build Tools](https://visualstudio.microsoft.com/downloads/#build-tools-for-visual-studio-2022)
- Python 3.x (for `node-gyp`)

---

## Step 2 — Environment Variables

Add these to your `.env` (or Railway environment variables):

```env
# ── Bully Radio ──────────────────────────────────────────────
RADIO_VOICE_CHANNEL_ID=YOUR_VOICE_CHANNEL_ID_HERE
RADIO_TEXT_CHANNEL_ID=YOUR_TEXT_CHANNEL_ID_HERE
```

`GUILD_ID` is already set from the existing bot config.

**How to get channel IDs:**
1. Enable Developer Mode in Discord (Settings → Advanced → Developer Mode)
2. Right-click the voice channel → Copy Channel ID
3. Right-click the text channel where Now Playing messages should appear → Copy Channel ID

---

## Step 3 — Bot Permissions

Make sure your bot has these permissions in the voice channel:
- **Connect**
- **Speak**
- **Use Voice Activity**

And in the text channel:
- **Send Messages**
- **Embed Links**
- **Read Message History** (to edit the Now Playing message)

---

## Step 4 — Add Audio Files

Drop audio files into the correct folders:

```
music/
  your-track.mp3
  another-song.flac
  ...

intermissions/
  station-id-01.mp3
  vault-statement.wav
  ...
```

**Supported formats:** `.mp3` `.wav` `.m4a` `.flac`

**Intermission clip guidelines:**
- Keep clips 2–5 seconds
- Record at a slightly lower level than your songs
- Soft, understated content — station IDs, ambient fragments, archive statements
- Don't use them as ads or calls to action

**The bot rescans both folders every 5 minutes.**  
New files enter rotation without a restart.

---

## Step 5 — Start

```bash
node bot.js
# or
npm start
```

On startup you'll see:
```
[Radio] Loaded 12 track(s) — shuffled and ready.
[Radio] Intermissions: 4 clip(s) loaded.
[Radio] Joined voice channel.
[Radio] Slash commands registered.
[Radio] 📻 Bully Radio is live.
```

---

## Admin Slash Commands

| Command | Description |
|---|---|
| `/radio-skip` | Skip the current track |
| `/radio-nowplaying` | Show what's on air (visible only to you) |
| `/radio-reload` | Rescan music + intermissions folders live |
| `/radio-pause` | Pause the broadcast |
| `/radio-resume` | Resume the broadcast |

`/radio-nowplaying` is available to all members.  
All other commands require **Administrator** permission.

---

## How the Intermission System Works

The system uses a non-linear probability engine so clips never feel scheduled:

1. After every song, the engine rolls against a chance value (starts at ~6%)
2. If it misses, the chance increases by a random amount (2–9%)
3. If it hits, a clip plays and the chance resets to ~4%

This means:
- Short dry spells are common — sometimes no clip for 10–15 songs
- Occasional back-to-back proximity is possible but not predictable
- The same clip won't repeat back-to-back (if you have multiple)

You can tune all probability values in `radio/config.js`.

---

## How the Music Queue Works

1. On start, all files in `/music` are loaded and shuffled (Fisher-Yates)
2. Tracks play in order through the shuffled list
3. When the list is exhausted, it reshuffles for the next cycle
4. New files added to `/music` are inserted at a random position ahead of  
   the current playback pointer — they enter rotation naturally
5. Deleted files are silently removed from the queue

---

## Deployment (Railway)

No extra steps needed. The existing Railway service will run the radio alongside the bot.

**FFmpeg:** `ffmpeg-static` provides a Linux binary that works out of the box on Railway.

**Audio files:** Upload them to your Railway volume (same volume your database uses),  
then update `MUSIC_DIR` and `INTERMISSIONS_DIR` in `radio/config.js` to point there. Or commit them directly to your repo if they're small enough.

**Persistent Now Playing:** The message ID is stored in memory, not the database.  
After a restart, the bot creates a new message. To keep it clean, pin the channel and  
delete old Now Playing messages manually after a restart.

---

## Tuning (radio/config.js)

| Setting | Default | Description |
|---|---|---|
| `RESCAN_INTERVAL_MS` | 5 min | How often to scan for new files |
| `INTERMISSION_BASE_CHANCE` | 0.06 | Starting intermission probability |
| `INTERMISSION_CHANCE_MAX` | 0.38 | Max probability cap per song |
| `INTERMISSION_RESET_CHANCE` | 0.04 | Chance after an intermission plays |
| `MUSIC_VOLUME` | 1.0 | Song volume (0.0–1.5) |
| `INTERMISSION_VOLUME` | 0.72 | Clip volume — kept quieter than songs |
| `PRESENCE_ROTATE_MS` | 11 min | How often bot status changes |
| `RECONNECT_DELAY_MS` | 5 sec | Delay before rejoining after a kick |

---

## Future Expansion Hooks

The codebase is structured for easy extension:

- **Weighted rarity** — give certain tracks higher play probability via a `weight` map in `queue.js`
- **Vault songs** — a second `Queue` instance with a separate folder and much lower intermission chance
- **Time-based moods** — check `new Date().getHours()` in `engine.js._advance()` to swap queues by time of day
- **Album art** — add `music-metadata` (npm) to `nowplaying.js` and extract ID3 cover images
- **Track duration** — same package provides `meta.format.duration` for the Now Playing embed
