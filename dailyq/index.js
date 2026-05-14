'use strict';
// ─── DAILY QUESTIONNAIRE MODULE ───────────────────────────────────────────────
// Automated daily question system for Bully's World Discord bot.
// Drop this folder into your bot root as ./dailyq/ and wire it into bot.js.
// ─────────────────────────────────────────────────────────────────────────────

const schedule = require('node-schedule');
const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const path = require('path');
const fs   = require('fs');

const CFG       = require('./config.json');
const QUESTIONS = require('./questions.json');
const TEMPLATES = require('./templates.json');
const analytics = require('./analytics');

// ─── DB SETUP ────────────────────────────────────────────────────────────────
function setupTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dq_posts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      question_id TEXT    NOT NULL,
      question    TEXT    NOT NULL,
      tone        TEXT,
      category    TEXT,
      message_id  TEXT,
      channel_id  TEXT,
      posted_at   TEXT    NOT NULL,
      closed_at   TEXT,
      winner_uid  TEXT,
      winner_text TEXT,
      total_resp  INTEGER DEFAULT 0,
      status      TEXT    DEFAULT 'active'
    );
    CREATE TABLE IF NOT EXISTS dq_responses (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id      INTEGER NOT NULL,
      user_id      TEXT    NOT NULL,
      username     TEXT    NOT NULL,
      message_id   TEXT    NOT NULL,
      response     TEXT    NOT NULL,
      resp_length  INTEGER DEFAULT 0,
      reactions    INTEGER DEFAULT 0,
      bb_earned    INTEGER DEFAULT 0,
      streak       INTEGER DEFAULT 0,
      created_at   TEXT    DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(post_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS dq_streaks (
      user_id          TEXT PRIMARY KEY,
      username         TEXT,
      current_streak   INTEGER DEFAULT 0,
      longest_streak   INTEGER DEFAULT 0,
      last_date        TEXT,
      total_responses  INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS dq_used (
      question_id TEXT PRIMARY KEY,
      last_used   TEXT NOT NULL,
      times_used  INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS dq_psychology (
      user_id        TEXT PRIMARY KEY,
      username       TEXT,
      cat_counts     TEXT DEFAULT '{}',
      tone_counts    TEXT DEFAULT '{}',
      archetype      TEXT,
      total_resp     INTEGER DEFAULT 0,
      updated_at     TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

// ─── QUESTION SELECTION ───────────────────────────────────────────────────────
function selectQuestion(db) {
  const sixMonthsAgo = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString();

  // IDs used in last 6 months
  const usedIds = new Set(
    db.prepare('SELECT question_id FROM dq_used WHERE last_used > ?')
      .all(sixMonthsAgo).map(r => r.question_id)
  );

  // Recent tones + categories (last 3 posts)
  const recent = db.prepare(
    'SELECT tone, category FROM dq_posts ORDER BY posted_at DESC LIMIT 3'
  ).all();
  const recentTones = recent.map(r => r.tone);
  const recentCats  = recent.slice(0, 2).map(r => r.category);

  // Available handcrafted questions
  let available = QUESTIONS.filter(q => !usedIds.has(q.id));

  // If pool runs low — reset to least-recently-used
  if (available.length < 10) {
    const lruIds = new Set(
      db.prepare('SELECT question_id FROM dq_used ORDER BY last_used ASC LIMIT 50')
        .all().map(r => r.question_id)
    );
    available = QUESTIONS.filter(q => lruIds.has(q.id));
    if (!available.length) available = QUESTIONS; // full reset
  }

  // Score each candidate — penalise recent tone/category to force rotation
  const scored = available.map(q => {
    let score = 100 + Math.random() * 25; // base + jitter
    if (recentTones.includes(q.tone))     score -= 35;
    if (recentCats.includes(q.category))  score -= 20;
    return { q, score };
  }).sort((a, b) => b.score - a.score);

  // Pick randomly from top-10 for variety
  const pool = scored.slice(0, Math.min(10, scored.length));
  return pool[Math.floor(Math.random() * pool.length)].q;
}

// ─── TEMPLATE GENERATION (fallback) ───────────────────────────────────────────
function generateFromTemplate() {
  const pattern = TEMPLATES.patterns[Math.floor(Math.random() * TEMPLATES.patterns.length)];
  let text = pattern.template;
  for (const [key, options] of Object.entries(pattern.slots)) {
    const val = options[Math.floor(Math.random() * options.length)];
    text = text.replace(`{${key}}`, val);
  }
  return {
    id:       `tpl_${Date.now()}`,
    category: pattern.category,
    tone:     pattern.tone,
    question: text,
    last_used: null,
  };
}

// ─── STREAK HANDLING ──────────────────────────────────────────────────────────
function updateStreak(db, userId, username) {
  const today     = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const row       = db.prepare('SELECT * FROM dq_streaks WHERE user_id = ?').get(userId);

  if (!row) {
    db.prepare(`
      INSERT INTO dq_streaks (user_id, username, current_streak, longest_streak, last_date, total_responses)
      VALUES (?, ?, 1, 1, ?, 1)
    `).run(userId, username, today);
    return 1;
  }

  if (row.last_date === today) return row.current_streak; // already counted today

  const newStreak = row.last_date === yesterday ? row.current_streak + 1 : 1;
  const longest   = Math.max(newStreak, row.longest_streak);

  db.prepare(`
    UPDATE dq_streaks
    SET username = ?, current_streak = ?, longest_streak = ?, last_date = ?, total_responses = total_responses + 1
    WHERE user_id = ?
  `).run(username, newStreak, longest, today, userId);

  return newStreak;
}

// ─── REWARD CALCULATION ───────────────────────────────────────────────────────
// Base + thoughtful bonus, multiplied by streak (capped at 2× = +100%)
function calcReward(responseText, streak) {
  const base      = CFG.rewards.base;
  const bonus     = responseText.length >= CFG.rewards.thoughtfulMinChars ? CFG.rewards.thoughtfulBonus : 0;
  const multi     = Math.min(1 + streak * CFG.rewards.streakBonusPerDay, CFG.rewards.maxStreakMultiplier);
  return Math.round((base + bonus) * multi);
}

// ─── ANTI-SPAM: Jaccard word similarity ──────────────────────────────────────
function wordSimilarity(a, b) {
  const sA = new Set(a.toLowerCase().split(/\s+/));
  const sB = new Set(b.toLowerCase().split(/\s+/));
  const inter = [...sA].filter(w => sB.has(w)).length;
  const union  = new Set([...sA, ...sB]).size;
  return union === 0 ? 0 : inter / union;
}

// ─── PSYCHOLOGY TRACKING ──────────────────────────────────────────────────────
const ARCHETYPES = [
  { name: 'Comfort Seeker',       cats: ['emotional_comfort', 'emotional_safety', 'loneliness']         },
  { name: 'Social Magnet',        cats: ['attention_triggers', 'attraction', 'social_energy']            },
  { name: 'Chaotic Spirit',       cats: ['boredom', 'chaos_vs_stability', 'humor']                      },
  { name: 'Loyal at Heart',       cats: ['trust', 'interpersonal_values', 'emotional_safety']            },
  { name: 'Bold & Direct',        cats: ['conflict', 'confidence', 'validation']                         },
  { name: 'Deeply Sentimental',   cats: ['memory_nostalgia', 'loneliness', 'emotional_comfort']          },
  { name: 'Social Observer',      cats: ['social_dynamics', 'communication_style', 'emotional_intelligence'] },
  { name: 'Emotionally Aware',    cats: ['emotional_intelligence', 'insecurity', 'personality_preference'] },
  { name: 'Spontaneous Spirit',   cats: ['boredom', 'lifestyle_preferences', 'chaos_vs_stability']      },
  { name: 'Self-Aware Reflector', cats: ['insecurity', 'emotional_intelligence', 'routine']              },
];

function assignArchetype(catCounts) {
  let best = null, bestScore = -1;
  for (const arch of ARCHETYPES) {
    const score = arch.cats.reduce((s, c) => s + (catCounts[c] || 0), 0);
    if (score > bestScore) { bestScore = score; best = arch.name; }
  }
  return best || 'Open Book';
}

function updatePsychology(db, userId, username, category, tone) {
  const row       = db.prepare('SELECT * FROM dq_psychology WHERE user_id = ?').get(userId);
  const catCounts = row ? JSON.parse(row.cat_counts)  : {};
  const tonCounts = row ? JSON.parse(row.tone_counts) : {};

  catCounts[category] = (catCounts[category] || 0) + 1;
  tonCounts[tone]     = (tonCounts[tone]     || 0) + 1;

  const archetype = assignArchetype(catCounts);
  const now       = new Date().toISOString();

  if (row) {
    db.prepare(`
      UPDATE dq_psychology
      SET username = ?, cat_counts = ?, tone_counts = ?, archetype = ?, total_resp = total_resp + 1, updated_at = ?
      WHERE user_id = ?
    `).run(username, JSON.stringify(catCounts), JSON.stringify(tonCounts), archetype, now, userId);
  } else {
    db.prepare(`
      INSERT INTO dq_psychology (user_id, username, cat_counts, tone_counts, archetype, total_resp, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?)
    `).run(userId, username, JSON.stringify(catCounts), JSON.stringify(tonCounts), archetype, now);
  }
}

// ─── IMAGE LOADER ─────────────────────────────────────────────────────────────
// Reads all images from dailyq/images/ and returns them as a rotating pool.
// Images are cycled in order (no random repeats) using a simple index stored in
// the dq_posts table count. Add any .png/.jpg/.gif/.webp files to that folder.
const IMAGES_DIR = path.join(__dirname, 'images');
let _imagePool   = null; // lazy-loaded

function getImagePool() {
  if (_imagePool !== null) return _imagePool;
  try {
    const files = fs.readdirSync(IMAGES_DIR)
      .filter(f => /\.(png|jpg|jpeg|gif|webp)$/i.test(f))
      .map(f => path.join(IMAGES_DIR, f));
    _imagePool = files;
    console.log(`[DailyQ] ${files.length} image${files.length !== 1 ? 's' : ''} loaded from dailyq/images/`);
  } catch (_) {
    _imagePool = [];
    console.log('[DailyQ] No images/ folder found — posting without images');
  }
  return _imagePool;
}

function pickImage(postCount) {
  const pool = getImagePool();
  if (!pool.length) return null;
  // Rotate in order so every image gets used before repeating
  return pool[postCount % pool.length];
}

// ─── TONE EMOJIS (decorative only) ───────────────────────────────────────────
const TONE_EMOJI = {
  funny: '😂', reflective: '🪞', chaotic: '⚡', toxic: '☠️', playful: '🎭',
  observational: '👁️', comforting: '🫂', dramatic: '🎬', socially_analytical: '🧠',
  hypothetical: '🤔', personality_based: '✨', relationship_oriented: '💬',
  emotionally_intelligent: '💙', gossip_style: '🗣️', girl_group_chat: '💅',
};

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN MODULE EXPORT
// ═══════════════════════════════════════════════════════════════════════════════
const dailyQ = {
  client:        null,
  db:            null,
  addBB:         null,
  activePost:    null,  // { postId, questionId, tone, category, messageId, channelId }

  // ── Init ──────────────────────────────────────────────────────────────────
  init(client, db, addBBFn) {
    this.client = client;
    this.db     = db;
    this.addBB  = addBBFn;
    setupTables(db);
    analytics.init();

    // Restore any in-progress post from today
    this._restoreActive();

    // Catch-up: handle any scheduled events missed while bot was offline
    // Small delay so the Discord client is fully ready before we try to post/close
    setTimeout(() => this._catchUp(), 5000);

    // Schedule daily post (9:00 AM Chicago)
    const { hour, minute, timezone } = CFG.postTime;
    schedule.scheduleJob({ hour, minute, tz: timezone }, () => this.postDailyQuestion());

    // Schedule daily close (9:00 PM Chicago)
    const c = CFG.closeTime;
    schedule.scheduleJob({ hour: c.hour, minute: c.minute, tz: c.timezone }, () => this.closeActivePost());

    console.log('[DailyQ] Initialized — posts scheduled 9am / closes 9pm Chicago');
  },

  // ── Catch-up: run on every restart to handle missed scheduled events ────────
  _catchUp() {
    // Get the current time in the configured timezone
    const tzNow  = new Date(new Date().toLocaleString('en-US', { timeZone: CFG.postTime.timezone }));
    const hour   = tzNow.getHours();
    const minute = tzNow.getMinutes();
    const nowMins = hour * 60 + minute;

    const postMins  = CFG.postTime.hour  * 60 + CFG.postTime.minute;
    const closeMins = CFG.closeTime.hour * 60 + CFG.closeTime.minute;

    // Bot came back AFTER close time and there's still an open post — close it now
    if (nowMins >= closeMins && this.activePost) {
      console.log('[DailyQ] Catch-up: bot missed close window — closing now');
      this.closeActivePost().catch(e => console.error('[DailyQ] Catch-up close error:', e.message));
      return;
    }

    // Bot came back AFTER post time, BEFORE close time, and nothing was posted — post now
    if (nowMins >= postMins && nowMins < closeMins && !this.activePost) {
      console.log('[DailyQ] Catch-up: bot missed post window — posting now');
      this.postDailyQuestion().catch(e => console.error('[DailyQ] Catch-up post error:', e.message));
    }
  },

  _restoreActive() {
    const today  = new Date().toISOString().slice(0, 10);
    const active = this.db.prepare(
      "SELECT * FROM dq_posts WHERE posted_at LIKE ? AND status = 'active' ORDER BY id DESC LIMIT 1"
    ).get(`${today}%`);
    if (active) {
      this.activePost = {
        postId:      active.id,
        questionId:  active.question_id,
        tone:        active.tone,
        category:    active.category,
        messageId:   active.message_id,
        channelId:   active.channel_id,
      };
      console.log(`[DailyQ] Restored active post: ${active.question_id}`);
    }
  },

  // ── Post question ──────────────────────────────────────────────────────────
  async postDailyQuestion() {
    const channelId = process.env.CHANNEL_DAILYQ;
    if (!channelId) { console.error('[DailyQ] CHANNEL_DAILYQ not set — skipping post'); return; }

    const channel = await this.client.channels.fetch(channelId).catch(() => null);
    if (!channel) { console.error('[DailyQ] Channel not found'); return; }

    // Don't double-post if already active today
    if (this.activePost) { console.log('[DailyQ] Already posted today — skipping'); return; }

    const q = selectQuestion(this.db) || generateFromTemplate();

    // How many posts have gone out so far (used for image rotation index)
    const postCount = this.db.prepare('SELECT COUNT(*) as c FROM dq_posts').get()?.c ?? 0;
    const imagePath = pickImage(postCount);

    const description =
      `${CFG.display.greeting}\n` +
      `**${q.question}**\n\n` +
      `${CFG.display.cta}`;

    const embed = new EmbedBuilder()
      .setColor('#c9a84c')
      .setDescription(description)
      .setFooter({ text: CFG.display.footerText })
      .setTimestamp();

    const sendOpts = { embeds: [embed] };

    if (imagePath) {
      const attachment = new AttachmentBuilder(imagePath, { name: 'daily.png' });
      embed.setImage('attachment://daily.png');
      sendOpts.files = [attachment];
    }

    const msg = await channel.send(sendOpts);
    const now  = new Date().toISOString();

    const res = this.db.prepare(`
      INSERT INTO dq_posts (question_id, question, tone, category, message_id, channel_id, posted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(q.id, q.question, q.tone, q.category, msg.id, channelId, now);

    // Track as used
    this.db.prepare(`
      INSERT INTO dq_used (question_id, last_used, times_used) VALUES (?, ?, 1)
      ON CONFLICT(question_id) DO UPDATE SET last_used = excluded.last_used, times_used = times_used + 1
    `).run(q.id, now);

    this.activePost = {
      postId:     res.lastInsertRowid,
      questionId: q.id,
      tone:       q.tone,
      category:   q.category,
      messageId:  msg.id,
      channelId,
    };

    console.log(`[DailyQ] Posted: ${q.id} — ${q.question.slice(0, 60)}`);
    analytics.logQuestion(q, msg.id, channelId).catch(() => {});
  },

  // ── Handle incoming message (called from bot.js messageCreate) ──────────────
  async handleMessage(message) {
    if (!this.activePost)                              return;
    if (message.channelId !== this.activePost.channelId) return;
    if (message.author.bot)                            return;

    const userId   = message.author.id;
    const username = message.author.username;
    const text     = message.content.trim();

    // Ignore bot commands typed in the DQ channel
    if (text.startsWith('!')) return;

    // Minimum length gate
    if (text.length < CFG.rewards.minResponseLength) return;

    // Only first response per user counts
    const existing = this.db.prepare(
      'SELECT id FROM dq_responses WHERE post_id = ? AND user_id = ?'
    ).get(this.activePost.postId, userId);
    if (existing) return;

    // Anti-copy: compare against last 20 responses
    const recent = this.db.prepare(
      'SELECT response FROM dq_responses WHERE post_id = ? ORDER BY id DESC LIMIT 20'
    ).all(this.activePost.postId).map(r => r.response);

    if (recent.some(r => wordSimilarity(r, text) > CFG.antiSpam.maxSimilarityScore)) return;

    // Update streak
    const streak = updateStreak(this.db, userId, username);

    // Calculate and award BB
    const bb = calcReward(text, streak);
    this.addBB(userId, username, bb, 'daily question participation');

    // Save response
    this.db.prepare(`
      INSERT INTO dq_responses (post_id, user_id, username, message_id, response, resp_length, bb_earned, streak)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(this.activePost.postId, userId, username, message.id, text, text.length, bb, streak);

    // Increment total on post
    this.db.prepare('UPDATE dq_posts SET total_resp = total_resp + 1 WHERE id = ?')
      .run(this.activePost.postId);

    // Update psychology profile
    updatePsychology(this.db, userId, username, this.activePost.category, this.activePost.tone);

    // Confirm with reaction (subtle — doesn't clutter the channel)
    message.react(CFG.display.confirmReaction).catch(() => {});

    // Log to Sheets async (fire-and-forget)
    analytics.logResponse(userId, username, this.activePost, text, bb, streak).catch(() => {});

    console.log(`[DailyQ] ${username} — ${bb} BB (streak: ${streak}, chars: ${text.length})`);
  },

  // ── Handle reaction (called from bot.js messageReactionAdd) ─────────────────
  async handleReaction(reaction, user) {
    if (user.bot || !this.activePost) return;
    const resp = this.db.prepare(
      'SELECT id FROM dq_responses WHERE message_id = ?'
    ).get(reaction.message.id);
    if (!resp) return;
    this.db.prepare('UPDATE dq_responses SET reactions = reactions + 1 WHERE id = ?').run(resp.id);
  },

  // ── Close active post & post summary (called from bot.js OR scheduler) ──────
  async closeActivePost() {
    if (!this.activePost) return;

    const { postId, channelId } = this.activePost;

    // Winner = most reacted; tiebreak = longest response
    const winner = this.db.prepare(`
      SELECT * FROM dq_responses
      WHERE post_id = ?
      ORDER BY reactions DESC, resp_length DESC
      LIMIT 1
    `).get(postId);

    const channel = await this.client.channels.fetch(channelId).catch(() => null);
    this.activePost = null; // clear before any awaits to prevent double-close

    const now = new Date().toISOString();

    if (winner && channel) {
      // Award popularity bonus
      this.addBB(winner.user_id, winner.username, CFG.rewards.popularWinnerBonus, 'daily question — most popular response');

      const total = this.db.prepare('SELECT total_resp FROM dq_posts WHERE id = ?').get(postId)?.total_resp || 0;

      const embed = new EmbedBuilder()
        .setColor('#c9a84c')
        .setTitle("💬 Today's Most Agreed Response")
        .setDescription(`*"${winner.response}"*\n\n— <@${winner.user_id}>`)
        .addFields(
          { name: '🏆 Bonus earned',   value: `+${CFG.rewards.popularWinnerBonus} BB`, inline: true },
          { name: '📊 Total responses', value: `${total}`,                              inline: true },
        )
        .setFooter({ text: CFG.display.closeSummaryFooter })
        .setTimestamp();

      await channel.send({ content: CFG.display.summaryPing, embeds: [embed] }).catch(() => {});

      this.db.prepare(`
        UPDATE dq_posts SET status = 'closed', closed_at = ?, winner_uid = ?, winner_text = ? WHERE id = ?
      `).run(now, winner.user_id, winner.response, postId);

      analytics.logDailyClose(postId, winner).catch(() => {});
    } else {
      this.db.prepare("UPDATE dq_posts SET status = 'closed', closed_at = ? WHERE id = ?")
        .run(now, postId);
    }

    console.log('[DailyQ] Post closed');
  },

  // ── Admin commands (called from bot.js messageCreate for admins) ─────────────
  async handleAdminCommand(message) {
    const content = message.content.toLowerCase().trim();
    const isAdmin = message.member?.permissions.has('Administrator');
    if (!isAdmin) return false;

    if (content === '!dailyq post') {
      await this.postDailyQuestion();
      await message.reply('✅ Daily question posted.').then(r => setTimeout(() => r.delete().catch(() => {}), 5000));
      await message.delete().catch(() => {});
      return true;
    }

    if (content === '!dailyq close') {
      await this.closeActivePost();
      await message.reply('✅ Daily question closed.').then(r => setTimeout(() => r.delete().catch(() => {}), 5000));
      await message.delete().catch(() => {});
      return true;
    }

    if (content === '!dailyq stats') {
      const post = this.db.prepare('SELECT * FROM dq_posts ORDER BY id DESC LIMIT 1').get();
      if (!post) { await message.reply('No questions posted yet.'); return true; }
      const total = this.db.prepare('SELECT COUNT(*) as c FROM dq_responses WHERE post_id = ?').get(post.id)?.c || 0;
      await message.reply(
        `**Daily Q Stats**\n` +
        `Question: *${post.question}*\n` +
        `Status: ${post.status} | Responses: ${total} | Posted: ${post.posted_at.slice(0, 16)}`
      );
      return true;
    }

    if (content === '!dailyq streaks') {
      const top = this.db.prepare(
        'SELECT username, current_streak, total_responses FROM dq_streaks ORDER BY current_streak DESC LIMIT 10'
      ).all();
      if (!top.length) { await message.reply('No streak data yet.'); return true; }
      const lines = top.map((r, i) => `**${i + 1}.** ${r.username} — ${r.current_streak}🔥 (${r.total_responses} total)`).join('\n');
      const { EmbedBuilder } = require('discord.js');
      await message.reply({ embeds: [
        new EmbedBuilder().setColor('#c9a84c').setTitle('🔥 Daily Q Streaks').setDescription(lines).setTimestamp()
      ]});
      return true;
    }

    return false;
  },
};

module.exports = dailyQ;
