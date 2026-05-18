// radio/queue.js — music file scanner and shuffled rotation queue
const fs   = require('fs');
const path = require('path');
const config = require('./config');

class Queue {
  constructor() {
    this.tracks   = [];   // current shuffled playlist
    this.position = 0;    // next track index to play
    this._known   = new Set(); // absolute paths we already know about
  }

  // ── Scan /music for audio files ───────────────────────────────────────────
  // Safe to call repeatedly — only adds new files and removes deleted ones.
  // New files are inserted at a random position ahead of the current pointer
  // so they enter rotation naturally without forcing immediate playback.
  scan() {
    const dir = config.MUSIC_DIR;

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      console.log('[Radio] /music folder created — add audio files to start broadcasting.');
      return;
    }

    let found;
    try {
      found = fs.readdirSync(dir)
        .filter(f => config.AUDIO_EXTENSIONS.includes(path.extname(f).toLowerCase()))
        .map(f => path.join(dir, f));
    } catch (err) {
      console.error('[Radio] Could not read /music:', err.message);
      return;
    }

    const foundSet = new Set(found);

    // ── Remove files that no longer exist ────────────────────────────────────
    for (const f of [...this._known]) {
      if (!foundSet.has(f)) {
        this._known.delete(f);
        const idx = this.tracks.indexOf(f);
        if (idx !== -1) {
          this.tracks.splice(idx, 1);
          if (idx < this.position) this.position = Math.max(0, this.position - 1);
        }
      }
    }

    // ── Add files we haven't seen yet ────────────────────────────────────────
    const newFiles = found.filter(f => !this._known.has(f));
    for (const f of newFiles) {
      this._known.add(f);
      // Insert somewhere after current position in the remaining queue so the
      // currently-playing track isn't interrupted and the new file trickles in
      const remaining = this.tracks.length - this.position;
      const offset    = remaining > 0 ? Math.floor(Math.random() * remaining) : 0;
      this.tracks.splice(this.position + 1 + offset, 0, f);
    }

    if (newFiles.length) {
      console.log(`[Radio] +${newFiles.length} new track(s) entered rotation (total: ${this.tracks.length})`);
    }

    // ── Cold start: nothing was known yet — load and shuffle everything ──────
    if (this.tracks.length === 0 && found.length > 0) {
      this.tracks   = _shuffle([...found]);
      this._known   = new Set(found);
      this.position = 0;
      console.log(`[Radio] Loaded ${this.tracks.length} track(s) — shuffled and ready.`);
    }
  }

  // ── Advance to the next track ─────────────────────────────────────────────
  // Reshuffles when the full cycle completes.
  next() {
    if (this.tracks.length === 0) return null;

    if (this.position >= this.tracks.length) {
      this.tracks   = _shuffle(this.tracks);
      this.position = 0;
      console.log('[Radio] Full cycle complete — reshuffled for next rotation.');
    }

    return this.tracks[this.position++];
  }

  // Current track (the one that was last returned by next())
  current() {
    if (this.tracks.length === 0 || this.position === 0) return null;
    return this.tracks[this.position - 1];
  }

  // Skip to the next track without playing it (used by engine after skip cmd)
  // Just move the pointer — engine will call next() for the actual track
  skip() {
    // Nothing needed here; engine calls next() which advances position
  }

  get count() { return this.tracks.length; }
}

// Fisher-Yates shuffle — returns a new array
function _shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

module.exports = { Queue };
