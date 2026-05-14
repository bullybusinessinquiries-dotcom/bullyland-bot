# bot.js Integration Instructions
Copy the `dailyq/` folder into your bot root, then make these 4 targeted edits to `bot.js`.

---

## 1 — Add CHANNEL_DAILYQ to .env (and Railway Variables)

```
CHANNEL_DAILYQ=<paste your daily question channel ID here>
GOOGLE_DQ_SHEET_ID=<optional — paste your analytics Google Sheet ID here>
```

---

## 2 — Require the module (top of bot.js, after other requires)

```js
const dailyQ = require('./dailyq/index');
```

---

## 3 — Init in the ready handler

Find this block near line 2765:
```js
client.once('ready', async()=>{
  console.log(`\n✅ Bully's World Bot online as ${client.user.tag}`);
  activeCasino = true;
  await setGiveawayChannelVisible(false);
  await refreshShop();
  startScheduler();
});
```

Add one line at the end:
```js
client.once('ready', async()=>{
  console.log(`\n✅ Bully's World Bot online as ${client.user.tag}`);
  activeCasino = true;
  await setGiveawayChannelVisible(false);
  await refreshShop();
  startScheduler();
  dailyQ.init(client, db, addBB);   // ← ADD THIS
});
```

---

## 4 — Wire into messageCreate (at the very top, before any command handling)

Find the start of the main messageCreate handler. It looks like:
```js
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  ...
  const content = message.content.trim();
  const lower   = content.toLowerCase();
```

Add these lines right after `if (message.author.bot) return;`:
```js
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  // ── Daily Questionnaire ──────────────────────────────────────────────────
  // Must run before command checks so responses in the DQ channel are captured
  await dailyQ.handleMessage(message).catch(() => {});
  const _adminHandled = await dailyQ.handleAdminCommand(message).catch(() => false);
  if (_adminHandled) return;
  // ────────────────────────────────────────────────────────────────────────

  const content = message.content.trim();
  ...
```

---

## 5 — Wire into messageReactionAdd

Find the existing handler:
```js
client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot) return;
  if (!activeChest) return;
  ...
```

Add one line at the top:
```js
client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot) return;
  await dailyQ.handleReaction(reaction, user).catch(() => {});  // ← ADD THIS

  if (!activeChest) return;
  ...
```

---

## Admin Commands (available to Administrators only)

| Command | Action |
|---|---|
| `!dailyq post` | Manually trigger today's question |
| `!dailyq close` | Manually close and post winner summary |
| `!dailyq stats` | Show current post status |
| `!dailyq streaks` | Show top participation streaks |

---

## Google Sheets Setup

1. Create a new Google Sheet (can be blank — tabs auto-created on first run)
2. Share it with your service account email (`GOOGLE_SERVICE_EMAIL` in .env)
3. Copy the Sheet ID from the URL and set `GOOGLE_DQ_SHEET_ID` in Railway Variables

The bot creates 4 tabs automatically:
- **Questions** — one row per daily post
- **Responses** — one row per valid response
- **Psychology** — user archetype data (synced on bot ready)
- **Streaks** — participation streaks (synced on bot ready)

To sync psychology/streaks to Sheets from the ready handler, add:
```js
dailyQ.init(client, db, addBB);
analytics.syncPsychology(db).catch(() => {});  // optional — sync on every restart
```
where `analytics` is `require('./dailyq/analytics')`.

---

## Question Pool Status

- **425 handcrafted questions** across 23 internal psychological categories
- Covers 15 distinct tones: funny, reflective, chaotic, toxic, playful, observational,
  comforting, dramatic, socially_analytical, hypothetical, personality_based,
  relationship_oriented, emotionally_intelligent, gossip_style, girl_group_chat
- **6-month anti-repeat window** — questions won't repeat for 180 days
- **Dynamic template system** kicks in automatically if pool runs low
- Questions rotate intelligently — same tone/category won't repeat back-to-back

## Reward Summary

| Condition | BB |
|---|---|
| Base reply (≥20 chars) | 25 BB |
| Thoughtful reply (≥80 chars) | +10 BB bonus |
| Day 1 streak | ×1.05 |
| Day 10 streak | ×1.50 |
| Day 20+ streak | ×2.00 (capped) |
| Most popular response of the day | +50 BB bonus |

Max possible per day: (25 + 10) × 2 = **70 BB** from participation + 50 BB if winner = **120 BB**
