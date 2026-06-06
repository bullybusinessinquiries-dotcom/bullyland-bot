'use strict';
// fyp.js — Bullyland FYP feed engine
// The server's homepage: an always-alive algorithmic social feed.

const fs       = require('fs');
const path     = require('path');
const schedule = require('node-schedule');
const chokidar = require('chokidar');
const { EmbedBuilder } = require('discord.js');

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const MUSIC_DIR        = path.join(__dirname, 'music');
const AUDIO_EXTS       = new Set(['.mp3', '.wav', '.m4a', '.flac']);
const WAVE_DM_DELAY_MS = 2 * 60 * 60 * 1000; // 2 hours
const TIMEZONE         = 'America/Chicago';

// Post lifespans in hours — each type decays at its own rate
const LIFESPAN = {
  poll:       24,   // runs a full day
  feed:       24,   // tweet-style posts live a full day
  radio:      10,   // radio cards cycle out faster
  radio_new:  8,    // "added to rotation" even shorter
  new_member: 48,   // welcome posts stay up so people have time to wave
  lottery:    18,   // lottery result lives through the next day
  boost:      48,   // server boost stays up as a prestige moment
  event:      null, // event posts expire when the event starts (set dynamically)
  daily_q:    48,   // most agreed response stays up two days
};

// ─── EMBED COLORS ────────────────────────────────────────────────────────────
const COLOR = {
  POLL:       0x5865F2,
  FEED:       0x111111,
  RADIO:      0xc9a84c,
  NEW_MEMBER: 0xc9a84c,
  LOTTERY:    0xFFD700,
  BOOST:      0xFF73FA,
  EVENT:      0x57F287,
  DAILY_Q:    0x2d7d46,
};

// ─── CONTENT BANKS ───────────────────────────────────────────────────────────

const POLLS = [
  // Lifestyle
  { question: 'Beach or mountains?',                                    answers: ['Beach', 'Mountains'] },
  { question: 'City or suburbs?',                                       answers: ['City', 'Suburbs'] },
  { question: 'Stay in or go out?',                                     answers: ['Stay in', 'Go out'] },
  { question: 'Plan everything or go with the flow?',                   answers: ['Plan it', 'Go with the flow'] },
  { question: 'Solo trip or group trip?',                               answers: ['Solo', 'Group'] },
  { question: 'Window seat or aisle seat?',                             answers: ['Window', 'Aisle'] },
  { question: 'Spend it or save it?',                                   answers: ['Spend', 'Save'] },
  { question: 'Talk it out or handle it alone?',                        answers: ['Talk it out', 'Handle it alone'] },
  { question: 'Early to everything or always running late?',            answers: ['Early', 'Always late'] },
  { question: 'Minimalist or maximalist?',                              answers: ['Minimalist', 'Maximalist'] },
  { question: 'Routine or spontaneous?',                                answers: ['Routine', 'Spontaneous'] },
  { question: 'Night out or dinner party?',                             answers: ['Night out', 'Dinner party'] },
  { question: 'Road trip or fly there?',                                answers: ['Road trip', 'Fly'] },
  { question: 'Staycation or vacation?',                                answers: ['Staycation', 'Vacation'] },
  { question: 'Live in the moment or plan for the future?',             answers: ['Live in the moment', 'Plan ahead'] },
  { question: 'Work to live or live to work?',                          answers: ['Work to live', 'Live to work'] },
  // Food & drink
  { question: 'Texting or calling?',                                    answers: ['Texting', 'Calling'] },
  { question: 'Pancakes or waffles?',                                   answers: ['Pancakes', 'Waffles'] },
  { question: 'Sweet or salty?',                                        answers: ['Sweet', 'Salty'] },
  { question: 'Coffee or energy drinks?',                               answers: ['Coffee', 'Energy drinks'] },
  { question: 'Fast food or sit-down restaurant?',                      answers: ['Fast food', 'Sit-down'] },
  { question: 'Cook at home or order out?',                             answers: ['Cook at home', 'Order out'] },
  { question: 'Iced or hot drinks?',                                    answers: ['Iced', 'Hot'] },
  { question: 'Chocolate or vanilla?',                                  answers: ['Chocolate', 'Vanilla'] },
  { question: 'Eat to live or live to eat?',                            answers: ['Eat to live', 'Live to eat'] },
  { question: 'Breakfast or brunch?',                                   answers: ['Breakfast', 'Brunch'] },
  { question: 'Pizza or burgers?',                                      answers: ['Pizza', 'Burgers'] },
  { question: 'Spicy or mild?',                                         answers: ['Spicy', 'Mild'] },
  { question: 'Takeout or delivery?',                                   answers: ['Pick it up', 'Delivery'] },
  { question: 'Meat lover or vegetarian?',                              answers: ['Meat lover', 'Vegetarian'] },
  { question: 'Fancy dinner or street food?',                           answers: ['Fancy dinner', 'Street food'] },
  { question: 'Binge eat or portion control?',                          answers: ['Binge eat', 'Portion control'] },
  // Entertainment
  { question: 'Movies or shows?',                                       answers: ['Movies', 'Shows'] },
  { question: 'Music or podcasts?',                                     answers: ['Music', 'Podcasts'] },
  { question: 'Old music or new music?',                                answers: ['Old music', 'New music'] },
  { question: 'Read the book or watch the movie?',                      answers: ['Read it', 'Watch it'] },
  { question: 'Skip intro or watch it every time?',                     answers: ['Skip intro', 'Watch it'] },
  { question: 'Headphones or speakers?',                                answers: ['Headphones', 'Speakers'] },
  { question: 'Binge the whole season or one episode a week?',          answers: ['Binge it', 'One a week'] },
  { question: 'Lyrics or vibes?',                                       answers: ['Lyrics', 'Vibes'] },
  { question: 'Concerts or listening at home?',                         answers: ['Concerts', 'Home'] },
  { question: 'Studio album or live version?',                          answers: ['Studio', 'Live'] },
  { question: 'Comedy or drama?',                                       answers: ['Comedy', 'Drama'] },
  { question: 'Documentary or fiction?',                                answers: ['Documentary', 'Fiction'] },
  // Style & habits
  { question: 'Night owl or early bird?',                               answers: ['Night owl', 'Early bird'] },
  { question: 'Morning shower or night shower?',                        answers: ['Morning', 'Night'] },
  { question: 'Sneakers or slides?',                                    answers: ['Sneakers', 'Slides'] },
  { question: 'Sleep with socks or no socks?',                          answers: ['Socks on', 'No socks'] },
  { question: 'Hoodie or jacket?',                                      answers: ['Hoodie', 'Jacket'] },
  { question: 'Dark mode or light mode?',                               answers: ['Dark mode', 'Light mode'] },
  { question: 'Phone on silent or ring?',                               answers: ['Silent', 'Ring'] },
  { question: 'Gym or home workout?',                                   answers: ['Gym', 'Home'] },
  { question: 'Nap or power through it?',                               answers: ['Nap', 'Power through'] },
  { question: 'Total silence or background noise?',                     answers: ['Silence', 'Background noise'] },
  { question: 'Cold room warm blanket or warm room no blanket?',        answers: ['Cold room', 'Warm room'] },
  { question: 'Overdressed or underdressed?',                           answers: ['Overdressed', 'Underdressed'] },
  { question: 'Wear the same outfit twice or never?',                   answers: ['Wear it twice', 'Never repeat'] },
  { question: 'Perfume or unscented?',                                  answers: ['Perfume', 'Unscented'] },
  // Social & personality
  { question: 'Dogs or cats?',                                          answers: ['Dogs', 'Cats'] },
  { question: 'Reply right away or make them wait?',                    answers: ['Right away', 'Make them wait'] },
  { question: 'Leave on read or respond to everyone?',                  answers: ['Leave on read', 'Respond to everyone'] },
  { question: 'Finish what you start or jump between things?',          answers: ['Finish it', 'Jump around'] },
  { question: 'Introvert or extrovert?',                                answers: ['Introvert', 'Extrovert'] },
  { question: 'Small circle or big friend group?',                      answers: ['Small circle', 'Big group'] },
  { question: 'Oversharer or keep it private?',                         answers: ['Oversharer', 'Private'] },
  { question: 'First to arrive or fashionably late?',                   answers: ['First to arrive', 'Fashionably late'] },
  { question: 'Say it directly or hint at it?',                         answers: ['Say it directly', 'Drop hints'] },
  { question: 'Hold a grudge or forgive and forget?',                   answers: ['Hold it', 'Forgive and forget'] },
  { question: 'Venting session or problem-solving mode?',               answers: ['Venting', 'Problem-solving'] },
  { question: 'Overthink everything or go with your gut?',              answers: ['Overthink', 'Gut feeling'] },
  // Work & productivity
  { question: 'Work from home or go into the office?',                  answers: ['WFH', 'Office'] },
  { question: 'Morning person on deadlines or last-minute rush?',       answers: ['Ahead of schedule', 'Last minute'] },
  { question: 'Multi-task or one thing at a time?',                     answers: ['Multi-task', 'One thing'] },
  { question: 'Paper notes or digital notes?',                          answers: ['Paper', 'Digital'] },
  { question: 'Meetings or just send an email?',                        answers: ['Meetings', 'Email'] },
  { question: 'Hustle culture or work-life balance?',                   answers: ['Hustle', 'Balance'] },
  // Tech & misc
  { question: 'iPhone or Android?',                                     answers: ['iPhone', 'Android'] },
  { question: 'AirPods or over-ear headphones?',                        answers: ['AirPods', 'Over-ear'] },
  { question: 'Cash or card?',                                          answers: ['Cash', 'Card'] },
  { question: 'Alarm on the first ring or snooze it five times?',       answers: ['First ring', 'Snooze it'] },
  { question: 'Scroll TikTok or YouTube?',                              answers: ['TikTok', 'YouTube'] },
  { question: 'Instagram or Twitter/X?',                                answers: ['Instagram', 'Twitter/X'] },
  { question: 'Call an Uber or drive yourself?',                        answers: ['Uber', 'Drive'] },
  { question: 'Buy it now or wait for the sale?',                       answers: ['Buy now', 'Wait for sale'] },
  { question: 'Keep the box or throw it away?',                         answers: ['Keep the box', 'Trash it'] },
  { question: 'Print directions or use GPS?',                           answers: ['Print it', 'GPS'] },
];

const FEED_POSTS = [
  // Original 40
  'People who wake up instantly scare me.',
  'Being ignored for two hours feels longer at night.',
  'The fridge is way too bright at 2AM.',
  'Some people text back in 30 seconds. Others need three days. There is no in between.',
  'If you can eat the same thing every day and never get tired of it you have a superpower.',
  'The feeling of sending a risky text and waiting for the response is genuinely unbearable.',
  'Nothing hits different than music you completely forgot you liked.',
  'People who fall asleep the second they hit the pillow are a different breed.',
  'A good playlist can shift your whole week.',
  'Some conversations need to stay in the drafts.',
  'The moment you stop checking is the moment it finally shows up.',
  'Productivity goes up when you stop telling people what you\'re working on.',
  'Some days you just need to exist quietly.',
  'Getting a full night\'s sleep and still waking up tired is one of life\'s greatest betrayals.',
  'The best ideas always show up at the worst time to write them down.',
  'You can tell a lot about someone by what they do when nobody\'s watching.',
  'Phone on silent is a personality trait.',
  'Some people buy things because they need them. Others because it felt like the right day.',
  'If you can sit in silence with someone comfortably you\'ve found something real.',
  'The version of you that stayed quiet has protected you more than once.',
  'People underestimate how much a clean space changes their thinking.',
  'Nothing feels as far away as something that almost happened.',
  'You stop explaining yourself to people who were never going to understand anyway.',
  'Music is different at 3AM. It just hits differently.',
  'Knowing when to walk away is a skill they don\'t teach you.',
  'Some people keep showing up in your mind because they earned that space.',
  'There\'s a version of you that didn\'t hesitate and it worked out.',
  'People who always know what they want to eat are rare and valuable.',
  'The most restful thing isn\'t sleep. It\'s not having to explain yourself.',
  'Energy doesn\'t lie. You can feel when someone is draining you before you consciously realize it.',
  'Some songs feel like they were written specifically for one moment in your life.',
  'The right environment makes you a completely different person.',
  'Cleaning your room at midnight hits different than cleaning it at noon.',
  'Some people lower their voice when they\'re serious. Others get louder. One of those is more trustworthy.',
  'The quietest people in the room are usually running the most thoughts.',
  'There\'s something about driving alone at night with the right song that\'s unexplainable.',
  'Apologizing without changing anything is just talking.',
  'Your body keeps score before your brain catches up.',
  'The people who check on you without being asked are the ones you keep.',
  'You can miss a version of someone that no longer exists.',
  // Additional 40
  'Some people are just built for 3AM conversations.',
  'The effort it takes to pretend you\'re okay deserves more credit.',
  'Buying something and never using it is still a form of self-care apparently.',
  'People who gas you up privately but never publicly are a specific kind of person.',
  'The wrong song at the right moment can completely ruin your peace.',
  'You don\'t realize how much you\'ve changed until you\'re around old habits.',
  'Some people are loud because they\'re confident. Others are loud because they need to be heard. Different things.',
  'The way someone treats a waiter tells you everything.',
  'Silence from someone you care about hits louder than anything they could say.',
  'You can feel the energy shift when someone\'s done trying.',
  'The version of you that didn\'t send that message made the right call.',
  'Being unbothered is a full-time job that doesn\'t pay enough.',
  'Some environments are designed to shrink you. Leaving is the work.',
  'There are people who will match your energy exactly. Find those.',
  'Loyalty is rare. When you find it, protect it.',
  'Your taste is ahead of your ability for a while and that gap is uncomfortable.',
  'People remember how you made them feel long after they forget what you said.',
  'Some of the best things happened because of the worst timing.',
  'There is an art to doing nothing and very few people have mastered it.',
  'Moving in silence has a different kind of power.',
  'The comeback is always quieter than the breakdown.',
  'You have to be the right person before the right things find you.',
  'Showing up consistently is underrated. Most people don\'t.',
  'The people who water themselves down to fit in always regret it eventually.',
  'Rest is not a reward. It\'s a requirement.',
  'Something about finishing something you started feels different than anything else.',
  'People who refuse to complain about things they can control have figured something out.',
  'The version of you from two years ago would be surprised by where you are.',
  'Some doors are closed because what\'s on the other side isn\'t for you.',
  'You grow the most in the seasons that feel the most quiet.',
  'Discipline is just deciding to do it before you feel like doing it.',
  'The people who are always "too busy" always have time for the things they actually want.',
  'Not every chapter ends cleanly. Some just stop.',
  'There\'s a version of every city you only discover at night.',
  'The right person makes the things you used to settle for obvious.',
  'Some friendships only make sense in that specific season of your life.',
  'You can care about someone and still protect your peace at the same time.',
  'The thing about growing up is realizing how many things you were told were facts that were just opinions.',
  'Being selective with your time isn\'t antisocial. It\'s self-respect.',
  'Some people are meant to show you what you don\'t want.',
];

const RADIO_LABELS = [
  'Now Playing',
  'In Rotation',
  'Currently On',
  'On the Playlist',
  'Just Queued',
  'Back in Rotation',
];

const FEED_LABELS = [
  'Trending in Bullyland',
  'Currently Circulating',
  'Popular Today',
  'Active Discussion',
  'Gaining Reactions',
  'Resurfaced',
  'Frequently Shared',
];

// ─── MODULE STATE ─────────────────────────────────────────────────────────────
let _client       = null;
let _db           = null;
let _fypChannelId = null;

// ─── DB SETUP ─────────────────────────────────────────────────────────────────
function setupTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS fyp_posts (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT UNIQUE NOT NULL,
      thread_id  TEXT,
      type       TEXT NOT NULL,
      expires_at TEXT,
      meta       TEXT DEFAULT '{}',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS fyp_waves (
      message_id TEXT NOT NULL,
      user_id    TEXT NOT NULL,
      username   TEXT NOT NULL,
      PRIMARY KEY (message_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS fyp_wave_timers (
      message_id  TEXT PRIMARY KEY,
      member_id   TEXT NOT NULL,
      member_name TEXT NOT NULL,
      fire_at     TEXT NOT NULL
    );
  `);
}

// ─── UTILITIES ────────────────────────────────────────────────────────────────
function rand(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Returns an ISO expiry string `hours` from now.
// The expiry check job runs every 10 minutes — this sets WHEN a post dies,
// not how fast the job runs. A 24-hour post lives for 24 hours.
function expiresAt(hours) {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

async function getChannel() {
  if (!_client || !_fypChannelId) return null;
  return _client.channels.fetch(_fypChannelId).catch(() => null);
}

function trackPost(messageId, type, expiresAtIso, meta = {}) {
  try {
    _db.prepare(
      'INSERT OR IGNORE INTO fyp_posts (message_id, type, expires_at, meta) VALUES (?,?,?,?)'
    ).run(messageId, type, expiresAtIso, JSON.stringify(meta));
  } catch (e) {
    console.error('[FYP] trackPost error:', e.message);
  }
}

async function openThread(message) {
  try {
    const thread = await message.startThread({
      name: '💬 Comment Section',
      autoArchiveDuration: 1440,
    });
    await thread.send('💬 Comment Section');
    _db.prepare('UPDATE fyp_posts SET thread_id = ? WHERE message_id = ?').run(thread.id, message.id);
  } catch (e) {
    console.error('[FYP] Thread open error:', e.message);
  }
}

function getMusicFiles() {
  try {
    return fs.readdirSync(MUSIC_DIR)
      .filter(f => AUDIO_EXTS.has(path.extname(f).toLowerCase()) && !f.startsWith('.'));
  } catch { return []; }
}

function formatTrackName(filename) {
  const base = path.basename(filename, path.extname(filename));
  return base.replace(/^[^-]+-\s*/, '').trim();
}

function formatEventTime(date) {
  return date.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZone: TIMEZONE,
  });
}

// ─── CHANNEL LOCK ─────────────────────────────────────────────────────────────
async function lockChannel() {
  const channel = await getChannel();
  if (!channel?.guild) return;
  const everyone = channel.guild.roles.everyone;
  await channel.permissionOverwrites.edit(everyone, {
    SendMessages:          false,
    AddReactions:          true,
    ReadMessageHistory:    true,
    ViewChannel:           true,
    CreatePublicThreads:   false,
    SendMessagesInThreads: true,
  }).catch(e => console.error('[FYP] Channel lock failed:', e.message));
  console.log('[FYP] Channel locked — bot-only posting');
}

// ─── EXPIRY SYSTEM ────────────────────────────────────────────────────────────
// Runs every 10 minutes. Deletes posts whose expires_at has passed.
// The interval is the check frequency — post lifespans are set in hours (see LIFESPAN above).
async function runExpiry() {
  const now     = new Date().toISOString();
  const expired = _db.prepare(
    'SELECT message_id FROM fyp_posts WHERE expires_at <= ? AND expires_at IS NOT NULL'
  ).all(now);
  if (!expired.length) return;

  const channel = await getChannel();
  for (const { message_id } of expired) {
    if (channel) {
      const msg = await channel.messages.fetch(message_id).catch(() => null);
      if (msg) await msg.delete().catch(() => {});
    }
    _db.prepare('DELETE FROM fyp_posts WHERE message_id = ?').run(message_id);
  }
  console.log(`[FYP] Expired ${expired.length} post(s)`);
}

// ─── WAVE DM SYSTEM ───────────────────────────────────────────────────────────
async function runWaveTimers() {
  const now   = new Date().toISOString();
  const ready = _db.prepare('SELECT * FROM fyp_wave_timers WHERE fire_at <= ?').all(now);

  for (const timer of ready) {
    const wavers = _db.prepare(
      'SELECT username FROM fyp_waves WHERE message_id = ? ORDER BY rowid ASC'
    ).all(timer.message_id);

    if (wavers.length > 0) {
      try {
        const guild  = _client.guilds.cache.first();
        const member = await guild?.members.fetch(timer.member_id).catch(() => null);
        if (member) {
          const names  = wavers.map(w => w.username).join(', ');
          const plural = wavers.length === 1 ? 'someone waved' : `${wavers.length} people waved`;
          await member.send(`👋 ${plural} at you in Bullyland.\n\n${names}`).catch(() => {});
        }
      } catch {}
    }

    _db.prepare('DELETE FROM fyp_wave_timers WHERE message_id = ?').run(timer.message_id);
  }
}

// ─── POST: POLL ───────────────────────────────────────────────────────────────
async function postPoll() {
  const channel = await getChannel();
  if (!channel) return;

  const poll     = rand(POLLS);
  const duration = LIFESPAN.poll; // native poll duration = lifespan so they sync

  const msg = await channel.send({
    poll: {
      question:         { text: poll.question },
      answers:          poll.answers.map(a => ({ text: a })),
      duration,
      allowMultiselect: false,
    },
  }).catch(e => { console.error('[FYP] Poll send failed:', e.message); return null; });

  if (!msg) return;
  trackPost(msg.id, 'poll', expiresAt(LIFESPAN.poll));
  await openThread(msg);
  console.log('[FYP] Poll posted');
}

// ─── POST: FEED POST ──────────────────────────────────────────────────────────
async function postFeedPost() {
  const channel = await getChannel();
  if (!channel) return;

  const text  = rand(FEED_POSTS);
  const label = rand(FEED_LABELS);

  const embed = new EmbedBuilder()
    .setColor(COLOR.FEED)
    .setDescription(text)
    .setFooter({ text: label });

  const msg = await channel.send({ embeds: [embed] }).catch(() => null);
  if (!msg) return;
  trackPost(msg.id, 'feed', expiresAt(LIFESPAN.feed));
  await openThread(msg);
  console.log('[FYP] Feed post posted');
}

// ─── POST: BULLY RADIO (scheduled) ────────────────────────────────────────────
async function postRadioNowPlaying() {
  const channel = await getChannel();
  if (!channel) return;

  const files = getMusicFiles();
  if (!files.length) return;

  const file  = rand(files);
  const track = formatTrackName(file);
  const label = rand(RADIO_LABELS);

  const embed = new EmbedBuilder()
    .setColor(COLOR.RADIO)
    .setAuthor({ name: 'Bully Radio' })
    .setDescription(`**${label}**\n${track}`)
    .setFooter({ text: 'Bullyland Radio' });

  const msg = await channel.send({ embeds: [embed] }).catch(() => null);
  if (!msg) return;
  trackPost(msg.id, 'radio', expiresAt(LIFESPAN.radio));
  await openThread(msg);
  console.log(`[FYP] Radio post — ${track}`);
}

// ─── POST: NEW TRACK ADDED TO FOLDER ──────────────────────────────────────────
async function postRadioNewTrack(filePath) {
  const channel = await getChannel();
  if (!channel) return;

  const track = formatTrackName(filePath);

  const embed = new EmbedBuilder()
    .setColor(COLOR.RADIO)
    .setAuthor({ name: 'Bully Radio' })
    .setDescription(`**Added to Rotation**\n${track}`)
    .setFooter({ text: 'Bullyland Radio' });

  const msg = await channel.send({ embeds: [embed] }).catch(() => null);
  if (!msg) return;
  trackPost(msg.id, 'radio_new', expiresAt(LIFESPAN.radio_new));
  await openThread(msg);
  console.log(`[FYP] New track announced: ${track}`);
}

// ─── POST: DAILY Q MOST AGREED ────────────────────────────────────────────────
async function postDailyQResult() {
  const channel = await getChannel();
  if (!channel) return;

  const today = new Date().toISOString().slice(0, 10);

  const post = _db.prepare(
    'SELECT * FROM dq_posts WHERE posted_at LIKE ? ORDER BY id DESC LIMIT 1'
  ).get(`${today}%`);
  if (!post) return;

  const already = _db.prepare(
    "SELECT 1 FROM fyp_posts WHERE type = 'daily_q' AND meta LIKE ?"
  ).get(`%"post_id":${post.id}%`);
  if (already) return;

  const top = _db.prepare(
    'SELECT username, response, reactions FROM dq_responses WHERE post_id = ? ORDER BY reactions DESC, created_at ASC LIMIT 1'
  ).get(post.id);
  if (!top?.response) return;

  const embed = new EmbedBuilder()
    .setColor(COLOR.DAILY_Q)
    .setTitle("Today's Most Agreed Response")
    .setDescription(`**${post.question}**\n\n"${top.response}"`)
    .setFooter({ text: `— ${top.username} · Bullyland Daily` });

  const msg = await channel.send({ embeds: [embed] }).catch(() => null);
  if (!msg) return;
  trackPost(msg.id, 'daily_q', expiresAt(LIFESPAN.daily_q), { post_id: post.id });
  await openThread(msg);
  console.log('[FYP] Daily Q result posted');
}

// ─── PUBLIC HOOK: DISCORD SCHEDULED EVENT ─────────────────────────────────────
// Called when a new guild scheduled event is created.
// The post expires when the event is scheduled to start (or 7 days, whichever is sooner).
async function postDiscordEvent(event) {
  const channel = await getChannel();
  if (!channel) return;

  const startTime  = event.scheduledStartAt;
  const timeStr    = startTime ? formatEventTime(startTime) : 'coming soon';
  const expireTime = startTime
    ? Math.min((startTime.getTime() - Date.now()) / 3600000, 7 * 24) // until event starts, max 7 days
    : 7 * 24;

  if (expireTime <= 0) return; // event is already in the past

  const embed = new EmbedBuilder()
    .setColor(COLOR.EVENT)
    .setTitle(event.name)
    .setDescription(
      event.description
        ? `${event.description}\n\n${timeStr}`
        : timeStr
    )
    .setFooter({ text: 'Bullyland Events' });

  if (event.coverImageURL()) embed.setImage(event.coverImageURL({ size: 1024 }));

  const msg = await channel.send({ embeds: [embed] }).catch(() => null);
  if (!msg) return;
  trackPost(msg.id, 'event', expiresAt(expireTime), { event_id: event.id });
  await openThread(msg);
  console.log(`[FYP] Event posted: ${event.name}`);
}

// ─── PUBLIC HOOK: SERVER BOOST ────────────────────────────────────────────────
async function postServerBoost(member) {
  const channel = await getChannel();
  if (!channel) return;

  const embed = new EmbedBuilder()
    .setColor(COLOR.BOOST)
    .setDescription(`**${member.displayName}** boosted the server.`)
    .setFooter({ text: 'Bullyland' });

  const msg = await channel.send({ embeds: [embed] }).catch(() => null);
  if (!msg) return;
  trackPost(msg.id, 'boost', expiresAt(LIFESPAN.boost));
  await openThread(msg);
  console.log(`[FYP] Boost posted for ${member.user.username}`);
}

// ─── PUBLIC HOOK: LOTTERY WINNER ──────────────────────────────────────────────
async function postLotteryWinner(winner, totalPot) {
  const channel = await getChannel();
  if (!channel) return;

  const embed = new EmbedBuilder()
    .setColor(COLOR.LOTTERY)
    .setDescription(
      `**${winner.username}** just won the weekly lottery.\n\n` +
      `${totalPot.toLocaleString()} BB.`
    )
    .setFooter({ text: 'Trending in Bullyland' });

  const msg = await channel.send({ embeds: [embed] }).catch(() => null);
  if (!msg) return;
  trackPost(msg.id, 'lottery', expiresAt(LIFESPAN.lottery));
  await openThread(msg);
}

// ─── PUBLIC HOOK: NEW MEMBER ──────────────────────────────────────────────────
async function postNewMember(member) {
  const channel = await getChannel();
  if (!channel) return;

  const embed = new EmbedBuilder()
    .setColor(COLOR.NEW_MEMBER)
    .setDescription('new member joined bullyland 🧡')
    .setFooter({ text: member.displayName });

  const msg = await channel.send({ embeds: [embed] }).catch(() => null);
  if (!msg) return;

  await msg.react('👋').catch(() => {});
  trackPost(msg.id, 'new_member', expiresAt(LIFESPAN.new_member), { member_id: member.id });
  await openThread(msg);

  const fireAt = new Date(Date.now() + WAVE_DM_DELAY_MS).toISOString();
  _db.prepare(
    'INSERT OR REPLACE INTO fyp_wave_timers (message_id, member_id, member_name, fire_at) VALUES (?,?,?,?)'
  ).run(msg.id, member.id, member.displayName, fireAt);
}

// ─── REACTION HANDLER (called from bot.js messageReactionAdd) ─────────────────
function handleReaction(reaction, user) {
  if (user.bot) return;
  if (reaction.message.channelId !== _fypChannelId) return;
  if (reaction.emoji.name !== '👋') return;

  const timer = _db.prepare('SELECT member_id FROM fyp_wave_timers WHERE message_id = ?').get(reaction.message.id);
  if (!timer) return;
  if (timer.member_id === user.id) return; // no self-wave

  _db.prepare(
    'INSERT OR IGNORE INTO fyp_waves (message_id, user_id, username) VALUES (?,?,?)'
  ).run(reaction.message.id, user.id, user.username);
}

// ─── SCHEDULER ────────────────────────────────────────────────────────────────
function scheduleAll() {
  const tz = TIMEZONE;

  // Polls: 10am, 2pm, 7pm CST
  schedule.scheduleJob({ hour: 10, minute: 0,  tz }, () => postPoll().catch(e => console.error('[FYP] Poll error:', e.message)));
  schedule.scheduleJob({ hour: 14, minute: 0,  tz }, () => postPoll().catch(e => console.error('[FYP] Poll error:', e.message)));
  schedule.scheduleJob({ hour: 19, minute: 0,  tz }, () => postPoll().catch(e => console.error('[FYP] Poll error:', e.message)));

  // Feed posts: 9am, 12pm, 4:30pm, 9pm CST
  schedule.scheduleJob({ hour: 9,  minute: 0,  tz }, () => postFeedPost().catch(e => console.error('[FYP] Feed error:', e.message)));
  schedule.scheduleJob({ hour: 12, minute: 0,  tz }, () => postFeedPost().catch(e => console.error('[FYP] Feed error:', e.message)));
  schedule.scheduleJob({ hour: 16, minute: 30, tz }, () => postFeedPost().catch(e => console.error('[FYP] Feed error:', e.message)));
  schedule.scheduleJob({ hour: 21, minute: 0,  tz }, () => postFeedPost().catch(e => console.error('[FYP] Feed error:', e.message)));

  // Radio: 11am, 3:30pm, 8pm CST
  schedule.scheduleJob({ hour: 11, minute: 0,  tz }, () => postRadioNowPlaying().catch(e => console.error('[FYP] Radio error:', e.message)));
  schedule.scheduleJob({ hour: 15, minute: 30, tz }, () => postRadioNowPlaying().catch(e => console.error('[FYP] Radio error:', e.message)));
  schedule.scheduleJob({ hour: 20, minute: 0,  tz }, () => postRadioNowPlaying().catch(e => console.error('[FYP] Radio error:', e.message)));

  // Daily Q result: 11:45pm CST (after the Q closes)
  schedule.scheduleJob({ hour: 23, minute: 45, tz }, () => postDailyQResult().catch(e => console.error('[FYP] Daily Q error:', e.message)));

  // Housekeeping every 10 minutes — checks expiry and fires wave DMs
  schedule.scheduleJob('*/10 * * * *', async () => {
    await runExpiry().catch(e => console.error('[FYP] Expiry error:', e.message));
    await runWaveTimers().catch(e => console.error('[FYP] Wave timer error:', e.message));
  });

  console.log('[FYP] Scheduler ready');
}

// ─── MUSIC FOLDER WATCHER ─────────────────────────────────────────────────────
function startFileWatcher() {
  const watcher = chokidar.watch(MUSIC_DIR, {
    persistent:       true,
    ignoreInitial:    true,
    awaitWriteFinish: { stabilityThreshold: 3000, pollInterval: 500 },
  });

  watcher.on('add', filePath => {
    const ext = path.extname(filePath).toLowerCase();
    if (!AUDIO_EXTS.has(ext)) return;
    console.log(`[FYP] New track detected: ${path.basename(filePath)}`);
    postRadioNewTrack(filePath).catch(e => console.error('[FYP] New track post error:', e.message));
  });

  console.log('[FYP] Music folder watcher started');
}

// ─── STARTUP SEED ─────────────────────────────────────────────────────────────
// Posts one feed post + one poll immediately so the channel is never empty on boot.
// Skipped if the channel already has recent FYP content (bot restarted, not first launch).
async function seedOnStartup() {
  const recentPost = _db.prepare(
    "SELECT 1 FROM fyp_posts WHERE created_at > datetime('now', '-1 hour') LIMIT 1"
  ).get();
  if (recentPost) {
    console.log('[FYP] Recent posts found — skipping startup seed');
    return;
  }

  console.log('[FYP] No recent posts found — seeding feed...');
  await postFeedPost().catch(e => console.error('[FYP] Seed feed error:', e.message));
  // Small delay so posts don't stack at the exact same timestamp
  await new Promise(r => setTimeout(r, 2000));
  await postPoll().catch(e => console.error('[FYP] Seed poll error:', e.message));
  await new Promise(r => setTimeout(r, 2000));
  await postRadioNowPlaying().catch(e => console.error('[FYP] Seed radio error:', e.message));
}

// ─── STATUS HELPER (exposed to bot.js) ───────────────────────────────────────
async function _status(msg) {
  const count  = _db.prepare('SELECT COUNT(*) as n FROM fyp_posts').get();
  const active = _db.prepare("SELECT COUNT(*) as n FROM fyp_posts WHERE expires_at > datetime('now') OR expires_at IS NULL").get();
  const channel = await getChannel().catch(() => null);
  await msg.reply(
    `**FYP Status**\n` +
    `Channel: ${channel ? `<#${_fypChannelId}>` : `⚠️ channel not found — ID: \`${_fypChannelId}\``}\n` +
    `Active posts tracked: **${active?.n ?? 0}**\n` +
    `Total posts in DB: **${count?.n ?? 0}**\n` +
    `Bot user: ${_client?.user?.tag ?? 'not ready'}`
  );
}

// ─── INIT ─────────────────────────────────────────────────────────────────────
function initFYP(client, db, fypChannelId) {
  if (!fypChannelId || fypChannelId === 'PASTE_HERE') {
    console.error('[FYP] ❌ CHANNEL_FYP is not set or is still a placeholder. FYP will not post anything. Set CHANNEL_FYP in your .env / .env.local file.');
    return;
  }

  _client       = client;
  _db           = db;
  _fypChannelId = fypChannelId;

  console.log(`[FYP] Channel ID: ${fypChannelId}`);
  setupTables(db);
  scheduleAll();
  startFileWatcher();

  // Lock channel and seed feed after a short delay to let Discord connection stabilise
  setTimeout(async () => {
    await lockChannel();
    await seedOnStartup();
  }, 5000);

  // Listen for new Discord scheduled events
  client.on('guildScheduledEventCreate', event => {
    postDiscordEvent(event).catch(e => console.error('[FYP] Event post error:', e.message));
  });

  console.log(`[FYP] Initialized — channel: ${fypChannelId}`);
}

module.exports = {
  initFYP,
  postNewMember,
  postLotteryWinner,
  postServerBoost,
  handleReaction,
  // Direct post functions for !fyp admin commands in bot.js
  _postFeedPost:        postFeedPost,
  _postPoll:            postPoll,
  _postRadioNowPlaying: postRadioNowPlaying,
  _postDailyQResult:    postDailyQResult,
  _status,
};
