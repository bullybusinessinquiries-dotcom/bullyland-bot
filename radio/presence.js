// radio/presence.js — rotating bot status that feels like a real radio station
//
// Rotates through a curated list on a slow, irregular-feeling interval.
// The list is ordered so it cycles coherently rather than jumping randomly.
// ActivityType.Listening (2) is used throughout — "Listening to X" in Discord UI.

const { ActivityType } = require('discord.js');

const STATUSES = [
  { name: 'Bully Radio',              type: ActivityType.Listening },
  { name: 'unreleased music',         type: ActivityType.Listening },
  { name: 'BULLY Music',              type: ActivityType.Listening },
  { name: 'the vault rotation',       type: ActivityType.Listening },
  { name: 'something that dropped',   type: ActivityType.Listening },
  { name: 'low frequency signals',    type: ActivityType.Listening },
  { name: 'music you haven\'t heard', type: ActivityType.Listening },
  { name: 'Bully Radio',              type: ActivityType.Listening }, // anchor repeat
];

class PresenceManager {
  constructor() {
    this._client = null;
    this._index  = 0;
    this._timer  = null;
  }

  start(client, intervalMs) {
    this._client = client;
    this._apply(); // set immediately on boot

    this._timer = setInterval(() => {
      this._index = (this._index + 1) % STATUSES.length;
      this._apply();
    }, intervalMs);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  _apply() {
    const s = STATUSES[this._index];
    try {
      this._client.user.setPresence({
        activities: [{ name: s.name, type: s.type }],
        status: 'online',
      });
    } catch (_) {
      // Silently ignore — presence is cosmetic and Discord can throttle it
    }
  }
}

module.exports = { PresenceManager };
