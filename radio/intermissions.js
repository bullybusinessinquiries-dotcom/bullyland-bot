// radio/intermissions.js — atmospheric clip system with non-linear probability
//
// The goal is for intermissions to feel like passing radio moments, not ads.
// Each song that ends without an intermission gradually raises the probability,
// but the increment is randomized so the pattern is never predictable.
// After a clip plays, the chance resets to a lower baseline.
//
// Example feel:
//   songs 1–4:  low chance (~6–10%)
//   songs 5–9:  moderate (~15–25%)
//   songs 10+:  could be up to 38% per song
//   After clip: resets to 4%  →  quiet again for a while

const fs     = require('fs');
const path   = require('path');
const config = require('./config');

class IntermissionSystem {
  constructor() {
    this.clips       = [];        // absolute paths to clips
    this._known      = new Set();
    this._chance     = config.INTERMISSION_BASE_CHANCE;
    this._lastPlayed = null;      // avoid back-to-back repeats
  }

  // ── Scan /intermissions folder ────────────────────────────────────────────
  scan() {
    const dir = config.INTERMISSIONS_DIR;

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      return; // silently create; intermissions are optional
    }

    let found;
    try {
      found = fs.readdirSync(dir)
        .filter(f => config.AUDIO_EXTENSIONS.includes(path.extname(f).toLowerCase()))
        .map(f => path.join(dir, f));
    } catch (err) {
      console.error('[Radio] Could not read /intermissions:', err.message);
      return;
    }

    const prev = this.clips.length;
    this.clips = found;
    this._known = new Set(found);

    if (this.clips.length !== prev) {
      console.log(`[Radio] Intermissions: ${this.clips.length} clip(s) loaded.`);
    }
  }

  // ── Roll for an intermission after a song ends ────────────────────────────
  // Returns a clip path if one should play, or null to go straight to music.
  roll() {
    if (this.clips.length === 0) return null;

    const hit = Math.random() < this._chance;

    if (hit) {
      // Reset to a quiet baseline so clips don't cluster
      this._chance = config.INTERMISSION_RESET_CHANCE;

      // Pick randomly, avoiding the immediately previous clip if possible
      const candidates = this.clips.length > 1
        ? this.clips.filter(c => c !== this._lastPlayed)
        : this.clips;

      const clip = candidates[Math.floor(Math.random() * candidates.length)];
      this._lastPlayed = clip;
      return clip;
    }

    // Miss — raise the chance by a random amount within configured range
    const [lo, hi] = config.INTERMISSION_CHANCE_INCREMENT;
    this._chance = Math.min(
      config.INTERMISSION_CHANCE_MAX,
      this._chance + lo + Math.random() * (hi - lo),
    );

    return null;
  }

  // Current probability (exposed for /radio-nowplaying diagnostics)
  get currentChance() { return this._chance; }
  get count() { return this.clips.length; }
}

module.exports = { IntermissionSystem };
