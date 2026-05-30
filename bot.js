const path = require('path');
// Load .env.local first (local dev/test), fall back to .env (production)
const _envLocal = path.join(__dirname, '.env.local');
const _envFile  = require('fs').existsSync(_envLocal) ? _envLocal : path.join(__dirname, '.env');
require('dotenv').config({ path: _envFile });
console.log(`[ENV] Loaded: ${_envFile}`);
let stripe = null;
try { const Stripe = require('stripe'); stripe = Stripe(process.env.STRIPE_SECRET_KEY); } catch(e) { console.log('[Stripe] Not installed — auction payments disabled.'); }
const Anthropic = require('@anthropic-ai/sdk');
const Database = require('better-sqlite3');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const schedule = require('node-schedule');

const { Client, GatewayIntentBits, EmbedBuilder, PermissionsBitField, Partials, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, StringSelectMenuBuilder } = require('discord.js');
const initRadio = require('./radio');
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildVoiceStates, // required for @discordjs/voice
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── DATABASE ──────────────────────────────────────────────────────────────
// Auto-detect Railway persistent volume, fall back to DB_PATH env var, then __dirname
const fs = require('fs');
const dailyQ = require('./dailyq/index');
const { startDashboard, setStripePaymentCallback } = require('./dashboard');
function resolveDBPath() {
  if (process.env.DB_PATH) return process.env.DB_PATH;
  // Railway mounts volumes at user-configured paths — try common ones
  const railwayCandidates = ['/data', '/var/data', '/storage', '/app/data', '/mnt/data'];
  for (const dir of railwayCandidates) {
    try {
      fs.accessSync(dir, fs.constants.W_OK);
      return path.join(dir, 'bullyland.db'); // first writable non-app mount wins
    } catch (_) {}
  }
  return path.join(__dirname, 'bullyland.db'); // local fallback
}
const DB_PATH = resolveDBPath();
const db = new Database(DB_PATH);
console.log(`\n[DB] Using database: ${DB_PATH}`);
db.exec(`
  CREATE TABLE IF NOT EXISTS balances (
    user_id TEXT PRIMARY KEY, username TEXT,
    balance INTEGER DEFAULT 0, total_earned INTEGER DEFAULT 0,
    streak INTEGER DEFAULT 0, last_checkin TEXT, last_message TEXT,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT, amount INTEGER, reason TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS shop_purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT, item_name TEXT, cost INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS monthly_earnings (
    user_id TEXT PRIMARY KEY, username TEXT,
    earned_this_month INTEGER DEFAULT 0, month TEXT
  );
  CREATE TABLE IF NOT EXISTS redeem_codes (
    code TEXT PRIMARY KEY, amount INTEGER, claimed INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS used_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT, code TEXT, tier TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS lottery_tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT, username TEXT, tickets INTEGER DEFAULT 0, week TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS shields (
    user_id TEXT PRIMARY KEY, expires_at TEXT
  );

  CREATE TABLE IF NOT EXISTS auctions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT, description TEXT, image_url TEXT,
    starting_bid REAL, current_bid REAL, current_bidder_id TEXT, current_bidder_username TEXT,
    second_bid REAL, second_bidder_id TEXT, second_bidder_username TEXT,
    status TEXT DEFAULT 'active',
    ends_at TEXT, message_id TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS auction_bids (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    auction_id INTEGER, user_id TEXT, username TEXT, amount REAL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS auction_warnings (
    user_id TEXT PRIMARY KEY, username TEXT,
    warnings INTEGER DEFAULT 0, blacklisted INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS auction_payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    auction_id INTEGER, stripe_session_id TEXT UNIQUE,
    winner_id TEXT, winner_username TEXT,
    amount REAL, status TEXT DEFAULT 'pending',
    paid_at TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS heist_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS heist_cooldown (
    user_id TEXT PRIMARY KEY, last_heist TEXT
  );

  CREATE TABLE IF NOT EXISTS duels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    challenger_id TEXT, challenger_username TEXT,
    challenged_id TEXT, challenged_username TEXT,
    amount INTEGER, status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS heists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    heist_name TEXT, entry_cost INTEGER, base_chance REAL, payout INTEGER,
    leader_id TEXT, leader_username TEXT,
    crew TEXT DEFAULT '[]',
    status TEXT DEFAULT 'recruiting',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS steal_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stealer_id TEXT, target_id TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS steal_cooldown (
    user_id TEXT PRIMARY KEY,
    last_steal TEXT
  );

  CREATE TABLE IF NOT EXISTS heist_completions (
    user_id TEXT,
    heist_index INTEGER,
    PRIMARY KEY (user_id, heist_index)
  );

  CREATE TABLE IF NOT EXISTS jail (
    user_id TEXT PRIMARY KEY,
    release_at TEXT NOT NULL,
    bail_amount INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS feature_flags (
    feature TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS role_inventory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT, role_name TEXT, rarity TEXT,
    equipped INTEGER DEFAULT 1,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS giveaway_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT, username TEXT, tickets INTEGER DEFAULT 0, cycle TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS user_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    uses_remaining INTEGER NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS item_cooldowns (
    user_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    last_used TEXT NOT NULL,
    PRIMARY KEY (user_id, item_id)
  );

  CREATE TABLE IF NOT EXISTS booster_payouts (
    user_id TEXT NOT NULL,
    week    TEXT NOT NULL,
    paid_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, week)
  );

  CREATE TABLE IF NOT EXISTS superfan_payouts (
    user_id TEXT NOT NULL,
    week    TEXT NOT NULL,
    paid_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, week)
  );
`);

// ── Auction scheduling columns (migration — safe to run on every boot) ────────
try { db.exec('ALTER TABLE auctions ADD COLUMN scheduled_start TEXT'); }   catch(_) {}
try { db.exec('ALTER TABLE auctions ADD COLUMN duration_minutes INTEGER DEFAULT 240'); } catch(_) {}

// ── Shop state persistence — survives bot restarts ────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS shop_state (
    id           INTEGER PRIMARY KEY CHECK (id = 1),
    roles_json   TEXT NOT NULL,
    expires_at   TEXT NOT NULL
  );
`);

// ── DM preferences — users can opt out of non-critical DMs ───────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS dm_preferences (
    user_id    TEXT PRIMARY KEY,
    opted_out  INTEGER DEFAULT 0,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

// ── SQLite durability settings (must come before any writes) ──────────────────
// WAL mode: writes don't block reads, survives crashes mid-write.
// NORMAL sync: safe without a full fsync on every commit (much faster on Railway).
db.pragma('journal_mode = WAL');
db.pragma('synchronous  = NORMAL');

// Migrate existing DB — add bank_balance column if it doesn't exist yet
try { db.exec('ALTER TABLE balances ADD COLUMN bank_balance INTEGER DEFAULT 0'); } catch (_) {}
// Garnishment debt — tracks BB owed to the King after a treason punishment
try { db.exec('ALTER TABLE balances ADD COLUMN garnish_debt INTEGER NOT NULL DEFAULT 0'); } catch (_) {}

// Integrity check — runs after tables are guaranteed to exist
{ const count = db.prepare('SELECT COUNT(*) as c FROM balances').get()?.c ?? 0; console.log(`[DB] Users in database: ${count}${count === 0 ? ' ⚠️  (empty — check DB_PATH if this is unexpected on a live server)' : ''}`); }

// ─── PROTECTED BANNER MESSAGES ────────────────────────────────────────────
// These message IDs are branding banners pinned at the top of each channel.
// Every purge/refresh function must skip these so they are never deleted.
const BANNER_MESSAGE_IDS = new Set([
  '1506875770918801531', // 🎉win-bully-apparrel🎉 (giveaway channel)
  '1506875861373030413', // auction-house
  '1506875960233037895', // BULLY Radio
  '1506876074078900284', // 📊leaderboards
  '1506876134510428280', // 🏪bullys-store
]);

// ─── CONFIG ────────────────────────────────────────────────────────────────
const CONFIG = {
  GUILD_ID: process.env.GUILD_ID,
  OWNER_ID: process.env.OWNER_ID,
  TIMEZONE: 'America/Chicago',
  SHOP_URL: 'https://bullysapparel.fourthwall.com',
  TIKTOK_URL: 'https://www.tiktok.com/@itzzbully',

  CHANNELS: {
    MEMBER_SPOTLIGHT: process.env.CHANNEL_MEMBER_SPOTLIGHT,
    MYSTERY_DROPS:    process.env.CHANNEL_MYSTERY_DROPS,
    CHECKIN:          process.env.CHANNEL_CHECKIN,
    SHOP:             process.env.CHANNEL_SHOP,
    LEADERBOARD:      process.env.CHANNEL_LEADERBOARD,
    GIVEAWAY:         process.env.CHANNEL_GIVEAWAY,
    AUCTION:          process.env.CHANNEL_AUCTION,
    GENERAL:          process.env.CHANNEL_GENERAL,
    GAMES:            process.env.CHANNEL_GAMES,
    GAMES_2:          process.env.CHANNEL_GAMES_2,
    TESTING:          '1492228049272438834',
  },

  ROLES: {
    ROOKIE:             process.env.ROLE_ROOKIE,
    ADMIN:              process.env.ROLE_ADMIN,
    LEADERBOARD_LEADER: process.env.ROLE_LEADERBOARD_LEADER,
    GAMER:              process.env.ROLE_GAMER, // @gamer — pinged on check-in
  },

  // Bully Bucks
  MESSAGE_BB: 5,
  MESSAGE_COOLDOWN_MS: 5 * 1000,
  CHECKIN_WINDOW_MS: 3 * 60 * 1000,
  CHECKIN_BASE: 25,
  STREAK_TIERS: [
    { days: 28, reward: 400 },
    { days: 21, reward: 200 },
    { days: 14, reward: 100 },
    { days: 7,  reward: 50  },
    { days: 0,  reward: 25  },
  ],
  MONTHLY_WINNER_BB: 50,
  EVERYONE_ROLE_ID: '1352881884333473812',
  GIVEAWAY_MAX_TICKETS: 15,
  GIVEAWAY_PRIZE: "a free garment from Bully's Apparel",
  SHOP_ACCESS_ROLE: process.env.ROLE_ROOKIE,
  SHOP_LOCKED_MSG: "The shop is locked until you reach **Level 1** (Rookie) in the server. Keep chatting and check in daily — you'll get there fast.",
  DROP_EXPIRES_MINUTES: 30,

  // Discount code pools — 150 codes per tier
  DISCOUNT_CODES: {
    '5percent':  { label: '5% off',  cost: 300,  codes: ['MYSTERY5_AJ7K','MYSTERY5_S6BL','MYSTERY5_E2IC','MYSTERY5_C3D1','MYSTERY5_J1ZL','MYSTERY5_QT6B','MYSTERY5_VFUQ','MYSTERY5_87X6','MYSTERY5_A6E7','MYSTERY5_XUCQ','MYSTERY5_L9YE','MYSTERY5_1S1N','MYSTERY5_C4JM','MYSTERY5_ZUGA','MYSTERY5_L41V','MYSTERY5_2LAN','MYSTERY5_7LEF','MYSTERY5_5SQD','MYSTERY5_4VXA','MYSTERY5_ISZM','MYSTERY5_DDB8','MYSTERY5_2QD6','MYSTERY5_MKMG','MYSTERY5_S2SY','MYSTERY5_VV5I','MYSTERY5_66UZ','MYSTERY5_U2KY','MYSTERY5_JPUL','MYSTERY5_F1ZE','MYSTERY5_4YRM','MYSTERY5_N2X6','MYSTERY5_T51X','MYSTERY5_RQLJ','MYSTERY5_BDFB','MYSTERY5_T462','MYSTERY5_JGDK','MYSTERY5_4W4V','MYSTERY5_6HSW','MYSTERY5_NW1E','MYSTERY5_BXED','MYSTERY5_V3SF','MYSTERY5_8XSU','MYSTERY5_4VFX','MYSTERY5_C1WC','MYSTERY5_39X3','MYSTERY5_L7RX','MYSTERY5_CSBW','MYSTERY5_3XY4','MYSTERY5_MICJ','MYSTERY5_T2U8','MYSTERY5_DED2','MYSTERY5_SEXN','MYSTERY5_XCCP','MYSTERY5_A1A2','MYSTERY5_T1TJ','MYSTERY5_KNLU','MYSTERY5_5S37','MYSTERY5_EP78','MYSTERY5_8X46','MYSTERY5_KRGZ','MYSTERY5_EE1G','MYSTERY5_SQSF','MYSTERY5_5MHW','MYSTERY5_AECM','MYSTERY5_962R','MYSTERY5_MKF7','MYSTERY5_VB8H','MYSTERY5_6RKZ','MYSTERY5_I2QZ','MYSTERY5_XQWV','MYSTERY5_WE4A','MYSTERY5_PUPB','MYSTERY5_Q28N','MYSTERY5_XNRA','MYSTERY5_9BF4','MYSTERY5_HXHW','MYSTERY5_8IY9','MYSTERY5_CZZ6','MYSTERY5_LKKD','MYSTERY5_P7Y4','MYSTERY5_CEQ4','MYSTERY5_GQJ7','MYSTERY5_S6JF','MYSTERY5_WKMK','MYSTERY5_IN9N','MYSTERY5_RX9S','MYSTERY5_66NC','MYSTERY5_DT6V','MYSTERY5_SQ7Y','MYSTERY5_7V2S','MYSTERY5_QEC6','MYSTERY5_Y63W','MYSTERY5_SCLB','MYSTERY5_1TSQ','MYSTERY5_2MLP','MYSTERY5_A7KY','MYSTERY5_EDP5','MYSTERY5_Q258','MYSTERY5_4XXM','MYSTERY5_A58Q','MYSTERY5_86UK','MYSTERY5_TNXJ','MYSTERY5_JV9P','MYSTERY5_NISF','MYSTERY5_RMXX','MYSTERY5_4BHW','MYSTERY5_P8NK','MYSTERY5_1Z3S','MYSTERY5_HEC9','MYSTERY5_49YY','MYSTERY5_ERNZ','MYSTERY5_FQ6L','MYSTERY5_75U9','MYSTERY5_WGBT','MYSTERY5_AC42','MYSTERY5_VW5Y','MYSTERY5_VVC8','MYSTERY5_H857','MYSTERY5_P7V2','MYSTERY5_UN3K','MYSTERY5_WR34','MYSTERY5_B35V','MYSTERY5_HV6F','MYSTERY5_3LIA','MYSTERY5_BTSA','MYSTERY5_ZKJA','MYSTERY5_ZJQC','MYSTERY5_4VPE','MYSTERY5_R19M','MYSTERY5_J7EB','MYSTERY5_VIX4','MYSTERY5_YFTT','MYSTERY5_IM7C','MYSTERY5_8XIZ','MYSTERY5_WWAL','MYSTERY5_3PY1','MYSTERY5_F54N','MYSTERY5_VX3Z','MYSTERY5_KX9L','MYSTERY5_2484','MYSTERY5_YNHA','MYSTERY5_K7FX','MYSTERY5_GWP7','MYSTERY5_LBAK','MYSTERY5_MUGZ','MYSTERY5_L4JN','MYSTERY5_66EF','MYSTERY5_2IL4','MYSTERY5_ECCQ','MYSTERY5_4SLU'] },
    '10percent': { label: '10% off', cost: 600,  codes: ['MYSTERY10_2Z5N','MYSTERY10_FHMU','MYSTERY10_5QR8','MYSTERY10_Z6RZ','MYSTERY10_SWQZ','MYSTERY10_RIWX','MYSTERY10_VWPE','MYSTERY10_82L6','MYSTERY10_1GVG','MYSTERY10_2ACC','MYSTERY10_JXXY','MYSTERY10_LCTE','MYSTERY10_K2J9','MYSTERY10_L9YE','MYSTERY10_X3UD','MYSTERY10_BVG8','MYSTERY10_E3MI','MYSTERY10_AFMJ','MYSTERY10_B68N','MYSTERY10_F3IE','MYSTERY10_NAW9','MYSTERY10_HUZQ','MYSTERY10_YY8Z','MYSTERY10_K325','MYSTERY10_PJQ1','MYSTERY10_892F','MYSTERY10_RGC9','MYSTERY10_C5EX','MYSTERY10_GZ63','MYSTERY10_TC67','MYSTERY10_CQ9N','MYSTERY10_81JX','MYSTERY10_B8SS','MYSTERY10_PM82','MYSTERY10_42K6','MYSTERY10_DDWM','MYSTERY10_EMYF','MYSTERY10_9XE7','MYSTERY10_HBIG','MYSTERY10_9YBR','MYSTERY10_4AY6','MYSTERY10_U77D','MYSTERY10_RXU9','MYSTERY10_C4EY','MYSTERY10_QVK3','MYSTERY10_BT2T','MYSTERY10_FDHW','MYSTERY10_5NZN','MYSTERY10_KP4P','MYSTERY10_27NY','MYSTERY10_92QL','MYSTERY10_9ABY','MYSTERY10_DC8U','MYSTERY10_T5BA','MYSTERY10_HLPC','MYSTERY10_24B1','MYSTERY10_JK23','MYSTERY10_JKYT','MYSTERY10_7AK4','MYSTERY10_L75K','MYSTERY10_Q226','MYSTERY10_VSLJ','MYSTERY10_28V5','MYSTERY10_N9R5','MYSTERY10_ZVS7','MYSTERY10_PY6N','MYSTERY10_2GVW','MYSTERY10_6Z2M','MYSTERY10_F3FH','MYSTERY10_X1T2','MYSTERY10_WWEA','MYSTERY10_DLXP','MYSTERY10_P53H','MYSTERY10_ZCC7','MYSTERY10_5CJH','MYSTERY10_YVNS','MYSTERY10_IXL8','MYSTERY10_BP1M','MYSTERY10_PF2Q','MYSTERY10_1W1P','MYSTERY10_VD5L','MYSTERY10_W84S','MYSTERY10_I2I7','MYSTERY10_G3LI','MYSTERY10_K5U7','MYSTERY10_G4DN','MYSTERY10_LX67','MYSTERY10_93AA','MYSTERY10_NBGR','MYSTERY10_LBMW','MYSTERY10_IC79','MYSTERY10_IX9Z','MYSTERY10_MM72','MYSTERY10_8F74','MYSTERY10_HMA9','MYSTERY10_H1C8','MYSTERY10_IJND','MYSTERY10_B9Y2','MYSTERY10_YBNE','MYSTERY10_62IW','MYSTERY10_XINF','MYSTERY10_G4PQ','MYSTERY10_HZGE','MYSTERY10_J6VS','MYSTERY10_31CF','MYSTERY10_3LCJ','MYSTERY10_2FD5','MYSTERY10_YV97','MYSTERY10_QV6B','MYSTERY10_MKLI','MYSTERY10_9ZZB','MYSTERY10_SHBU','MYSTERY10_99JI','MYSTERY10_L4MI','MYSTERY10_4MDX','MYSTERY10_R12L','MYSTERY10_GXX6','MYSTERY10_SBEG','MYSTERY10_I9TU','MYSTERY10_422I','MYSTERY10_REBD','MYSTERY10_FD5Q','MYSTERY10_D9LP','MYSTERY10_SCPR','MYSTERY10_G3RA','MYSTERY10_8A7N','MYSTERY10_CFYA','MYSTERY10_RQV6','MYSTERY10_P9SV','MYSTERY10_EXJR','MYSTERY10_MJG2','MYSTERY10_8PD9','MYSTERY10_8ZH9','MYSTERY10_JAW6','MYSTERY10_JM85','MYSTERY10_G5CL','MYSTERY10_K5TK','MYSTERY10_SICH','MYSTERY10_UWNR','MYSTERY10_3DFS','MYSTERY10_FFMA','MYSTERY10_QDGK','MYSTERY10_GYJS','MYSTERY10_BUL2','MYSTERY10_4NDC','MYSTERY10_5AJ8','MYSTERY10_7HZV','MYSTERY10_4MX6','MYSTERY10_GGV5','MYSTERY10_T9M3'] },
    '15percent': { label: '15% off', cost: 1500, codes: ['MYSTERY15_G6K8','MYSTERY15_KSNA','MYSTERY15_YQDI','MYSTERY15_MBQA','MYSTERY15_URK7','MYSTERY15_4D63','MYSTERY15_JDE7','MYSTERY15_2YPZ','MYSTERY15_Z3QQ','MYSTERY15_IWKI','MYSTERY15_Z141','MYSTERY15_2BJM','MYSTERY15_MBJZ','MYSTERY15_4PUZ','MYSTERY15_CC2G','MYSTERY15_4DSC','MYSTERY15_71E4','MYSTERY15_B9K1','MYSTERY15_KLQS','MYSTERY15_9WE6','MYSTERY15_P41W','MYSTERY15_ABRC','MYSTERY15_BEWJ','MYSTERY15_4AQS','MYSTERY15_YYUN','MYSTERY15_PRQL','MYSTERY15_5947','MYSTERY15_MK2R','MYSTERY15_ES5B','MYSTERY15_MXJE','MYSTERY15_S2NR','MYSTERY15_XM26','MYSTERY15_LDQR','MYSTERY15_XSZI','MYSTERY15_7WXC','MYSTERY15_EG94','MYSTERY15_3S65','MYSTERY15_UCHG','MYSTERY15_TR1B','MYSTERY15_FUKN','MYSTERY15_YPDI','MYSTERY15_KZQX','MYSTERY15_MEPL','MYSTERY15_DNWW','MYSTERY15_UAVL','MYSTERY15_CS9R','MYSTERY15_XCG6','MYSTERY15_35SQ','MYSTERY15_HF2X','MYSTERY15_AJK5','MYSTERY15_DQ5H','MYSTERY15_NLA4','MYSTERY15_3DYK','MYSTERY15_A5M5','MYSTERY15_NUC4','MYSTERY15_9IF3','MYSTERY15_JK7P','MYSTERY15_FV6B','MYSTERY15_UNF5','MYSTERY15_DFIP','MYSTERY15_3H6A','MYSTERY15_7MR4','MYSTERY15_AXHY','MYSTERY15_THHM','MYSTERY15_8YCQ','MYSTERY15_117G','MYSTERY15_8KXX','MYSTERY15_Z4PI','MYSTERY15_U187','MYSTERY15_B5X9','MYSTERY15_5QKQ','MYSTERY15_BM2D','MYSTERY15_HKSU','MYSTERY15_LLRX','MYSTERY15_49N7','MYSTERY15_EVRG','MYSTERY15_TI5P','MYSTERY15_M52G','MYSTERY15_6SXD','MYSTERY15_T5CR','MYSTERY15_VC1A','MYSTERY15_BL1D','MYSTERY15_PTEX','MYSTERY15_CFGX','MYSTERY15_8LPR','MYSTERY15_S7V5','MYSTERY15_NQDW','MYSTERY15_WY31','MYSTERY15_ZU7M','MYSTERY15_YU88','MYSTERY15_ZBYJ','MYSTERY15_ATE8','MYSTERY15_6K49','MYSTERY15_5FHV','MYSTERY15_1SKC','MYSTERY15_4DQE','MYSTERY15_IVZK','MYSTERY15_IWPD','MYSTERY15_DACN','MYSTERY15_45CW','MYSTERY15_FKI5','MYSTERY15_DJYU','MYSTERY15_S1MW','MYSTERY15_PJA7','MYSTERY15_ZAXK','MYSTERY15_C1A4','MYSTERY15_T4CE','MYSTERY15_HIKN','MYSTERY15_LPVH','MYSTERY15_E95M','MYSTERY15_I4Z2','MYSTERY15_F9MB','MYSTERY15_BQPT','MYSTERY15_QUKQ','MYSTERY15_K6DY','MYSTERY15_QWKZ','MYSTERY15_9WTF','MYSTERY15_1F6S','MYSTERY15_FVKT','MYSTERY15_UIFR','MYSTERY15_G5GV','MYSTERY15_K22N','MYSTERY15_S4HQ','MYSTERY15_SYPE','MYSTERY15_CHIL','MYSTERY15_JS92','MYSTERY15_R7SI','MYSTERY15_AIM5','MYSTERY15_GJ53','MYSTERY15_86DP','MYSTERY15_ACTK','MYSTERY15_88NW','MYSTERY15_DQFQ','MYSTERY15_Q5EU','MYSTERY15_IPUW','MYSTERY15_9BJ8','MYSTERY15_WB3T','MYSTERY15_687R','MYSTERY15_2XWT','MYSTERY15_D1FV','MYSTERY15_APPZ','MYSTERY15_2J1K','MYSTERY15_LP2I','MYSTERY15_SAU3','MYSTERY15_T8FQ','MYSTERY15_GUCI','MYSTERY15_K62Y','MYSTERY15_53RE','MYSTERY15_IXBF','MYSTERY15_JJL8'] },
    '20percent': { label: '20% off', cost: 2000, codes: ['MYSTERY20_LSHA','MYSTERY20_CJW7','MYSTERY20_NK4U','MYSTERY20_B3XG','MYSTERY20_9GGF','MYSTERY20_F179','MYSTERY20_4WCI','MYSTERY20_9AC2','MYSTERY20_5GPZ','MYSTERY20_SQ94','MYSTERY20_VN66','MYSTERY20_4KDE','MYSTERY20_5K5Z','MYSTERY20_Z2GT','MYSTERY20_3HBJ','MYSTERY20_8XMM','MYSTERY20_VS4H','MYSTERY20_TDL3','MYSTERY20_A21M','MYSTERY20_M3RT','MYSTERY20_LRM3','MYSTERY20_PE53','MYSTERY20_BK2S','MYSTERY20_4557','MYSTERY20_CLSA','MYSTERY20_KI6L','MYSTERY20_JRBU','MYSTERY20_LYTX','MYSTERY20_IMDF','MYSTERY20_3U8L','MYSTERY20_MXX2','MYSTERY20_ZYXS','MYSTERY20_4ILL','MYSTERY20_VUE1','MYSTERY20_ZUF8','MYSTERY20_6IZW','MYSTERY20_HM1V','MYSTERY20_1BCF','MYSTERY20_CR2Z','MYSTERY20_2X6E','MYSTERY20_Y8PI','MYSTERY20_42XS','MYSTERY20_3A74','MYSTERY20_1QVC','MYSTERY20_WVSY','MYSTERY20_RKKR','MYSTERY20_1NJY','MYSTERY20_WSH1','MYSTERY20_Y2VL','MYSTERY20_YPY9','MYSTERY20_2Q6X','MYSTERY20_EBFR','MYSTERY20_77LJ','MYSTERY20_8LRJ','MYSTERY20_SRXM','MYSTERY20_CI6A','MYSTERY20_X46F','MYSTERY20_1ILK','MYSTERY20_HCJ7','MYSTERY20_FZ6Y','MYSTERY20_G3ND','MYSTERY20_IYPA','MYSTERY20_9KH4','MYSTERY20_KS8Y','MYSTERY20_SSTR','MYSTERY20_9EVB','MYSTERY20_ZJMQ','MYSTERY20_E4FP','MYSTERY20_ELSB','MYSTERY20_5NJS','MYSTERY20_GRS2','MYSTERY20_HBSY','MYSTERY20_5GYY','MYSTERY20_79CB','MYSTERY20_LQIP','MYSTERY20_GH9S','MYSTERY20_4P6F','MYSTERY20_KMNG','MYSTERY20_2IU9','MYSTERY20_2MHK','MYSTERY20_AU9S','MYSTERY20_6CD7','MYSTERY20_8Y6U','MYSTERY20_484H','MYSTERY20_1BT2','MYSTERY20_JAEQ','MYSTERY20_3VPP','MYSTERY20_RWRB','MYSTERY20_QE78','MYSTERY20_R44D','MYSTERY20_PZE9','MYSTERY20_8AVK','MYSTERY20_GTA1','MYSTERY20_E6IM','MYSTERY20_YFPC','MYSTERY20_DUVQ','MYSTERY20_DZUA','MYSTERY20_FXC8','MYSTERY20_57XE','MYSTERY20_YG2C','MYSTERY20_L37L','MYSTERY20_VCF8','MYSTERY20_49DC','MYSTERY20_SP5X','MYSTERY20_LU3B','MYSTERY20_U4F3','MYSTERY20_SQH5','MYSTERY20_296X','MYSTERY20_Z7JE','MYSTERY20_5FLJ','MYSTERY20_LKUE','MYSTERY20_H71R','MYSTERY20_LAEV','MYSTERY20_FJ6L','MYSTERY20_MUJQ','MYSTERY20_EZB4','MYSTERY20_LSHN','MYSTERY20_B6VM','MYSTERY20_WBD2','MYSTERY20_TQMZ','MYSTERY20_UB4R','MYSTERY20_RWC7','MYSTERY20_P8HX','MYSTERY20_VNL7','MYSTERY20_RCNG','MYSTERY20_CAGG','MYSTERY20_BP44','MYSTERY20_DJG9','MYSTERY20_D3UL','MYSTERY20_V7FE','MYSTERY20_KV7S','MYSTERY20_JL4C','MYSTERY20_CV1I','MYSTERY20_ESKG','MYSTERY20_D4AG','MYSTERY20_RW4Q','MYSTERY20_7VAN','MYSTERY20_GBXP','MYSTERY20_JU8Y','MYSTERY20_EBS3','MYSTERY20_6J9P','MYSTERY20_43RA','MYSTERY20_FEWU','MYSTERY20_WCYS','MYSTERY20_N615','MYSTERY20_BBCL','MYSTERY20_PMD1','MYSTERY20_PUCX','MYSTERY20_T1WJ','MYSTERY20_H1GQ'] },
  },

  // Shop items
  // Role prices by rarity — loaded from Google Sheet at boot
  ROLE_PRICES: {
    Common:    750,
    Uncommon:  1250,
    Rare:      2000,
    Legendary: 5000,
  },
  // Roles are loaded from Google Sheet — SHOP_ITEMS kept minimal for non-role items
  SHOP_ITEMS: [],

  // Mystery drop tiers
  DROP_TIERS: [
    { label: '5% off',       tierKey: '5percent',  prob: 0.575 },
    { label: '10% off',      tierKey: '10percent', prob: 0.250 },
    { label: '15% off',      tierKey: '15percent', prob: 0.100 },
    { label: '20% off',      tierKey: '20percent', prob: 0.050 },
    { label: 'FREE GARMENT', tierKey: null,        prob: 0.025 },
  ],


  // Collectible roles
  ROLES_BASE: {
    Common:    ['Foodie','Big Back','Plate Cleaner','Snack Queen','Extra Sauce','Fresh Coat','Brushstroke','Studio Girl','Sketch Up','Canvas Baby','Drip Check','Fit Check','Daily Regular','Showed Up','Just Here'],
    Uncommon:  ["Bully's Wife",'OG','Day One','Gallery Girl','Art Lover','Palette Queen','Sauce Boss','Clean Plate','Fit God','Dripped Out','The Regular','Loyal One'],
    Rare:      ["Bully's Favorite",'Top Pick','Limited Edition','Collector','Gallery VIP','Rare Find',"Chef's Kiss",'First Plate','Signed Print','Inner Circle'],
    Legendary: ['One of One','Bully Approved','Signed by Bully','The Original','Hall of Fame','Untouchable','Main Character','The Standard'],
  },
  ROLES_SEASONAL: {
    spring: { Common:['Fresh Bloom','Petal Girl','New Growth','Spring Fling'], Uncommon:['In Bloom','Soft Launch','Cherry Pick'], Rare:['First Thaw','Bloom Season'], Legendary:['The Renaissance'] },
    summer: { Common:['Hot Girl','Sun Kissed','Beach Snack','Heat Wave'], Uncommon:['Main Event','Poolside','Glazed Over'], Rare:['Golden Hour','Hot Commodity'], Legendary:['Solar Flare'] },
    fall:   { Common:['Cozy Girl','Pumpkin Spice','Sweater Weather','Apple Pick'], Uncommon:['Burnt Sienna','Fall Fit','Harvest Moon'], Rare:['Last Leaf','Amber Alert'], Legendary:['Autumn One'] },
    winter: { Common:['Frost Baby','Hot Cocoa','Snow Bunny','Cold Drip'], Uncommon:['Winter Muse','Iced Out','Midnight Blue'], Rare:['Black Ice','Frozen Edition'], Legendary:["Winter's One"] },
  },
};

// ─── ACTIVE STATE ──────────────────────────────────────────────────────────
let activeDrop = null;
let activeCheckin = null;
let activeShop = [];
let shopRefreshTime = null;
let activeCasino = false;
let dropsEnabled = true;
let lastShopMessageId = null;
let lastLeaderboardMessageId = null;
const _pendingDMUse  = new Map(); // userId   → { itemId, guildId }
const activeTrivia   = new Map(); // channelId → trivia game state
const activeHangman  = new Map(); // channelId → hangman game state
const gameCooldowns  = new Map(); // `${type}.${channelId}` → timestamp

// ─── DM PREFERENCE HELPERS ─────────────────────────────────────────────────
function dmAllowed(userId) {
  const row = db.prepare('SELECT opted_out FROM dm_preferences WHERE user_id = ?').get(userId);
  return !row || row.opted_out === 0;
}
function setDmOptOut(userId, optOut) {
  db.prepare(`
    INSERT INTO dm_preferences (user_id, opted_out, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET opted_out = excluded.opted_out, updated_at = excluded.updated_at
  `).run(userId, optOut ? 1 : 0);
}

// ─── DB HELPERS ────────────────────────────────────────────────────────────
function getUser(userId, username) {
  let user = db.prepare('SELECT * FROM balances WHERE user_id = ?').get(userId);
  if (!user) { db.prepare('INSERT INTO balances (user_id, username) VALUES (?, ?)').run(userId, username); user = db.prepare('SELECT * FROM balances WHERE user_id = ?').get(userId); }
  return user;
}
function addBB(userId, username, amount, reason) {
  try {
    getUser(userId, username);
    db.prepare('UPDATE balances SET balance = balance + ?, total_earned = total_earned + ?, username = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?').run(amount, amount > 0 ? amount : 0, username, userId);
    db.prepare('INSERT INTO transactions (user_id, amount, reason) VALUES (?, ?, ?)').run(userId, amount, reason);
    if (amount > 0) {
      const month = new Date().toISOString().slice(0,7);
      db.prepare(`
        INSERT INTO monthly_earnings (user_id, username, earned_this_month, month) VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          earned_this_month = CASE WHEN month = excluded.month THEN earned_this_month + excluded.earned_this_month ELSE excluded.earned_this_month END,
          month = excluded.month,
          username = excluded.username
      `).run(userId, username, amount, month);

      // ── Garnishment: if user owes a treason debt, collect 25% of each earning ──
      if (userId !== CONFIG.OWNER_ID) {
        const debt = db.prepare('SELECT garnish_debt FROM balances WHERE user_id = ?').get(userId)?.garnish_debt ?? 0;
        if (debt > 0) {
          const garnish = Math.min(Math.ceil(amount * 0.25), debt);
          db.prepare('UPDATE balances SET balance = balance - ?, garnish_debt = MAX(0, garnish_debt - ?) WHERE user_id = ?').run(garnish, garnish, userId);
          db.prepare('INSERT INTO transactions (user_id, amount, reason) VALUES (?, ?, ?)').run(userId, -garnish, `treason garnishment — debt reduced by ${garnish}`);
          // Pay owner directly (avoid recursion — don't call addBB here)
          getUser(CONFIG.OWNER_ID, 'Bully');
          db.prepare('UPDATE balances SET balance = balance + ?, total_earned = total_earned + ? WHERE user_id = ?').run(garnish, garnish, CONFIG.OWNER_ID);
          db.prepare('INSERT INTO transactions (user_id, amount, reason) VALUES (?, ?, ?)').run(CONFIG.OWNER_ID, garnish, `garnishment from ${username}`);
        }
      }
    }
  } catch (err) {
    console.error(`[addBB] Error for ${userId} (${username}): ${err.message}`);
  }
}
function spendBB(userId, amount) {
  db.prepare('UPDATE balances SET balance = balance - ? WHERE user_id = ?').run(amount, userId);
  db.prepare('INSERT INTO transactions (user_id, amount, reason) VALUES (?, ?, ?)').run(userId, -amount, 'shop purchase');
}

// ── Feature flags ────────────────────────────────────────────────────────────
const FEATURE_FLAGS = {
  heist:   true,
  casino:  true,
  lottery: true,
  shop:    true,
  trivia:  true,
  hangman: true,
  steal:   true,
  gift:    true,
  rain:    true,
  duel:    true,
};
function isEnabled(f)      { return FEATURE_FLAGS[f] !== false; }
function setFeature(f, v)  {
  FEATURE_FLAGS[f] = v;
  db.prepare('INSERT OR REPLACE INTO feature_flags (feature, enabled) VALUES (?, ?)').run(f, v ? 1 : 0);
}
function loadFeatureFlags() {
  const rows = db.prepare('SELECT feature, enabled FROM feature_flags').all();
  for (const r of rows) { if (r.feature in FEATURE_FLAGS) FEATURE_FLAGS[r.feature] = r.enabled === 1; }
}

const GC_FEATURES = [
  { key: 'heist',   label: '🦹 Heist'  },
  { key: 'casino',  label: '🎰 Casino' },
  { key: 'lottery', label: '🎟️ Lottery' },
  { key: 'trivia',  label: '🧠 Trivia' },
  { key: 'hangman', label: '🔤 Hangman' },
  { key: 'steal',   label: '🕵️ Steals' },
  { key: 'gift',    label: '💸 Gifts'  },
  { key: 'rain',    label: '🌧️ BB Rain' },
  { key: 'duel',    label: '⚔️ Duels'  },
  { key: 'shop',    label: '🛍️ Shop'   },
];

function buildGameController() {
  const statusLines = GC_FEATURES.map(f =>
    `${isEnabled(f.key) ? '🟢' : '🔴'} ${f.label} — **${isEnabled(f.key) ? 'ON' : 'OFF'}**`
  ).join('\n');

  const embed = new EmbedBuilder()
    .setColor('#c9a84c')
    .setTitle('🎮 Game Controller')
    .setDescription('Toggle features on/off. Changes take effect immediately and persist after restart.\n\n' + statusLines)
    .setFooter({ text: "Bully's World Admin • Green = ON  •  Red = OFF" })
    .setTimestamp();

  // Split into rows of 5
  const rows = [];
  for (let i = 0; i < GC_FEATURES.length; i += 5) {
    rows.push(new ActionRowBuilder().addComponents(
      GC_FEATURES.slice(i, i + 5).map(f =>
        new ButtonBuilder()
          .setCustomId(`gc_toggle.${f.key}`)
          .setLabel(f.label)
          .setStyle(isEnabled(f.key) ? ButtonStyle.Success : ButtonStyle.Danger)
      )
    ));
  }
  return { embeds: [embed], components: rows };
}

// Ping @Gamers role on announcements instead of @everyone
const GAMER_PING = process.env.ROLE_GAMER ? `<@&${process.env.ROLE_GAMER}>` : '@here';

// ── Jail helpers ─────────────────────────────────────────────────────────────
function getJail(userId) {
  const row = db.prepare('SELECT * FROM jail WHERE user_id = ?').get(userId);
  if (!row) return null;
  if (new Date(row.release_at) <= new Date()) {
    db.prepare('DELETE FROM jail WHERE user_id = ?').run(userId);
    return null;
  }
  return row;
}
function isJailed(userId) { return getJail(userId) !== null; }
function jailUser(userId, minutes, bailAmount) {
  const releaseAt = new Date(Date.now() + minutes * 60000).toISOString();
  db.prepare('INSERT OR REPLACE INTO jail (user_id, release_at, bail_amount) VALUES (?, ?, ?)').run(userId, releaseAt, bailAmount);
}

// Jail duration / bail scaled to the amount that was attempted to steal
function calcJailTime(stealAmount) { return Math.min(60, Math.max(5, Math.round(stealAmount / 10))); }
function calcBail(stealAmount)     { return Math.min(5000, Math.max(100, stealAmount * 2)); }

// Is a user active (sent a message in the last 5 days)?
function isActive(userId) {
  const row = db.prepare('SELECT last_message FROM balances WHERE user_id = ?').get(userId);
  if (!row || !row.last_message) return false;
  return Date.now() - new Date(row.last_message).getTime() < 5 * 24 * 60 * 60 * 1000;
}
// ─── BANK SYSTEM ──────────────────────────────────────────────────────────
// Bank capacity is determined by the member's Lurkr level role.
// Add each level role ID + its bank capacity below.
// Higher roles override lower ones — the highest matching role wins.
const BANK_LEVEL_ROLES = [
  { roleId: '1490053545116827934', capacity: 150,  label: 'Rookie'         },
  { roleId: '1490051621521195099', capacity: 350,  label: 'Newbie'         },
  { roleId: '1490051740349894867', capacity: 700,  label: 'BB Member'      },
  { roleId: '1490051785048588449', capacity: 1250, label: 'Veteran'        },
  { roleId: '1490051823384662187', capacity: 2500, label: 'OG'             },
  { roleId: '1490051918976913558', capacity: 4000, label: 'VIP'            },
  { roleId: '1490052510868574341', capacity: 6000, label: 'BOSS'           },
  { roleId: '1490051416449093652', capacity: 9000, label: 'BULLY Approved' },
];
const BANK_BASE_CAPACITY = 0; // no role yet — must earn Rookie to unlock the bank

function getBankCapacity(member) {
  let best = { capacity: BANK_BASE_CAPACITY, label: 'Base' };
  if (member && BANK_LEVEL_ROLES.length) {
    for (const tier of BANK_LEVEL_ROLES) {
      if (member.roles.cache.has(tier.roleId) && tier.capacity > best.capacity) {
        best = tier;
      }
    }
  }
  return best;
}

function depositBB(userId, amount) {
  db.prepare('UPDATE balances SET balance = balance - ?, bank_balance = bank_balance + ? WHERE user_id = ?').run(amount, amount, userId);
  db.prepare('INSERT INTO transactions (user_id, amount, reason) VALUES (?, ?, ?)').run(userId, -amount, `bank deposit`);
}

function withdrawBB(userId, amount) {
  db.prepare('UPDATE balances SET balance = balance + ?, bank_balance = bank_balance - ? WHERE user_id = ?').run(amount, amount, userId);
  db.prepare('INSERT INTO transactions (user_id, amount, reason) VALUES (?, ?, ?)').run(userId, amount, `bank withdrawal`);
}

// ─── BOOSTER & SUPERFAN CLUB ─────────────────────────────────────────────────
// Returns an ISO week string like "2025-W20" — used as the payout period key
function getISOWeek(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo    = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

const BOOSTER_WEEKLY_BB   = 500;
const SUPERFAN_WEEKLY_BB  = 500;

// ── Booster paycheck DM ───────────────────────────────────────────────────────
async function sendBoosterPaycheck(member, isFirstTime = false) {
  const embed = new EmbedBuilder()
    .setColor('#f47fff')
    .setTitle(isFirstTime ? '🧡 Welcome to The Boosters Club.' : '🧡 Your Booster Club deposit has arrived.')
    .setDescription(
      isFirstTime
        ? `Welcome to The Boosters Club. 🧡\n\nYour weekly BB deposits are now active.\nEnjoy the perks ✨`
        : `Your weekly Booster Club deposit has arrived ✨\n\n**+${BOOSTER_WEEKLY_BB} BB** has been added to your balance.`
    )
    .setFooter({ text: "Bully's World • Booster Club" })
    .setTimestamp();
  await member.send({ embeds: [embed] }).catch(() => {});
}

// ── Superfan paycheck DM ──────────────────────────────────────────────────────
async function sendSuperfanPaycheck(member, isFirstTime = false) {
  const embed = new EmbedBuilder()
    .setColor('#ff6b35')
    .setTitle(isFirstTime ? '🔥 Welcome to the Superfan Club.' : '🔥 Superfan Club — Weekly Paycheck')
    .setDescription(
      isFirstTime
        ? `You're a TikTok Superfan — and we see you.\n\n` +
          `The Superfan Club is reserved for the people who support Bully's content at the highest level. ` +
          `That kind of loyalty deserves to be rewarded, not just acknowledged.\n\n` +
          `As a Superfan, you'll receive **${SUPERFAN_WEEKLY_BB} Bully Bucks every week** for as long as your subscription is active.\n\n` +
          `Your first paycheck just hit. Check your balance with \`!balance\`.\n\n` +
          `Welcome to the inner circle. 🎨`
        : `Your weekly Superfan Club paycheck just dropped.\n\n` +
          `**+${SUPERFAN_WEEKLY_BB} BB** added to your balance for being one of Bully's top supporters on TikTok.\n\n` +
          `Superfan status is rare. The paycheck is your reminder that it's recognized.\n\n` +
          `Check your balance: \`!balance\``
    )
    .setFooter({ text: "Bully's World • Superfan Club • Inner circle." })
    .setTimestamp();
  await member.send({ embeds: [embed] }).catch(() => {});
}

// ── Weekly booster payouts — runs every Friday at noon CT ────────────────────
async function runBoosterPayouts() {
  try {
    const boosterRoleId = process.env.ROLE_BOOSTER;
    if (!boosterRoleId) {
      console.warn('[Booster] ⚠️  ROLE_BOOSTER not set in env — weekly payouts are disabled. Add ROLE_BOOSTER to Railway env vars.');
      return { paid: 0, skipped: 0, reason: 'missing_env' };
    }
    const guild = await client.guilds.fetch(CONFIG.GUILD_ID);
    await guild.members.fetch(); // populate cache
    const week     = getISOWeek();
    const boosters = guild.members.cache.filter(m => m.roles.cache.has(boosterRoleId) && !m.user.bot);
    if (!boosters.size) {
      console.log(`[Booster] No members with Booster role found (week ${week})`);
      return { paid: 0, skipped: 0, reason: 'no_boosters' };
    }
    let paid = 0, skipped = 0;
    for (const [, member] of boosters) {
      const already = db.prepare('SELECT 1 FROM booster_payouts WHERE user_id = ? AND week = ?').get(member.id, week);
      if (already) { skipped++; continue; }
      addBB(member.id, member.user.username, BOOSTER_WEEKLY_BB, 'Booster Club weekly paycheck');
      db.prepare('INSERT OR IGNORE INTO booster_payouts (user_id, week) VALUES (?, ?)').run(member.id, week);
      await sendBoosterPaycheck(member, false);
      paid++;
    }
    console.log(`[Booster] Paid ${paid} boosters ${BOOSTER_WEEKLY_BB} BB each (week ${week}) | ${skipped} already paid`);
    return { paid, skipped };
  } catch (e) {
    console.error('[Booster] Payout error:', e.message);
    return { paid: 0, skipped: 0, error: e.message };
  }
}

// ── Weekly superfan payouts — runs every Friday at noon CT ───────────────────
async function runSuperfanPayouts() {
  try {
    const superfanRoleId = process.env.ROLE_SUPERFAN;
    if (!superfanRoleId) {
      console.warn('[Superfan] ⚠️  ROLE_SUPERFAN not set in env — weekly payouts are disabled. Add ROLE_SUPERFAN to Railway env vars.');
      return { paid: 0, skipped: 0, reason: 'missing_env' };
    }
    const guild = await client.guilds.fetch(CONFIG.GUILD_ID);
    await guild.members.fetch();
    const week      = getISOWeek();
    const superfans = guild.members.cache.filter(m => m.roles.cache.has(superfanRoleId));
    if (!superfans.size) {
      console.log(`[Superfan] No superfan members found (week ${week})`);
      return { paid: 0, skipped: 0, reason: 'no_members' };
    }
    let paid = 0, skipped = 0;
    for (const [, member] of superfans) {
      const already = db.prepare('SELECT 1 FROM superfan_payouts WHERE user_id = ? AND week = ?').get(member.id, week);
      if (already) { skipped++; continue; }
      addBB(member.id, member.user.username, SUPERFAN_WEEKLY_BB, 'Superfan Club weekly paycheck');
      db.prepare('INSERT OR IGNORE INTO superfan_payouts (user_id, week) VALUES (?, ?)').run(member.id, week);
      await sendSuperfanPaycheck(member, false);
      paid++;
    }
    console.log(`[Superfan] Paid ${paid} superfans ${SUPERFAN_WEEKLY_BB} BB each (week ${week}) | ${skipped} already paid`);
    return { paid, skipped };
  } catch (e) {
    console.error('[Superfan] Payout error:', e.message);
    return { paid: 0, skipped: 0, error: e.message };
  }
}

// ─── ITEM SHOP ────────────────────────────────────────────────────────────
const ITEMS = {
  account_pull: {
    id:          'account_pull',
    name:        'Account Pull',
    emoji:       '📄',
    description: "Estimate another user's bank balance. Output is approximate (±15–20%).",
    price:       1200,
    maxUses:     3,
    stackLimit:  3,
    cooldownMs:  20 * 60 * 1000,
  },
  pocket_scan: {
    id:          'pocket_scan',
    name:        'Pocket Scan',
    emoji:       '👀',
    description: "Reveal another user's exact wallet balance.",
    price:       500,
    maxUses:     5,
    stackLimit:  5,
    cooldownMs:  10 * 60 * 1000,
  },
  vault_key: {
    id:          'vault_key',
    name:        'Vault Key',
    emoji:       '🔑',
    description: "Steal 20–25% of another user's bank (min 3,000 BB banked, max 5,000 BB stolen). They have a window to block it.",
    price:       2000,
    maxUses:     1,
    stackLimit:  2,
    cooldownMs:  2 * 60 * 60 * 1000,
  },
  shield: {
    id:          'shield',
    name:        'Shield',
    emoji:       '🛡️',
    description: 'Protect yourself from steals for 24 hours. Activates immediately on purchase — no separate use step.',
    price:       5000,
    maxUses:     1,
    stackLimit:  1,
    instant:     true, // activates on purchase, skips user_items table
    cooldownMs:  0,
  },
};

// Resolve item ID from user input (handles spaces, underscores, case)
function resolveItemId(input) {
  const normalized = input.toLowerCase().replace(/[\s_-]+/g, '_');
  if (ITEMS[normalized]) return normalized;
  // Fuzzy match by name
  return Object.keys(ITEMS).find(k => ITEMS[k].name.toLowerCase().replace(/\s+/g,'_') === normalized) || null;
}

// Total uses across all stacks
function getItemUses(userId, itemId) {
  const rows = db.prepare('SELECT SUM(uses_remaining) as t FROM user_items WHERE user_id = ? AND item_id = ?').get(userId, itemId);
  return rows?.t ?? 0;
}

// Number of distinct stacks (for stack limit)
function getItemStacks(userId, itemId) {
  return db.prepare('SELECT COUNT(*) as c FROM user_items WHERE user_id = ? AND item_id = ?').get(userId, itemId)?.c ?? 0;
}

// Consume one use from oldest stack; apply cooldown
function consumeItemUse(userId, itemId) {
  const stack = db.prepare('SELECT * FROM user_items WHERE user_id = ? AND item_id = ? ORDER BY created_at ASC LIMIT 1').get(userId, itemId);
  if (!stack) return false;
  if (stack.uses_remaining <= 1) db.prepare('DELETE FROM user_items WHERE id = ?').run(stack.id);
  else db.prepare('UPDATE user_items SET uses_remaining = uses_remaining - 1 WHERE id = ?').run(stack.id);
  db.prepare('INSERT OR REPLACE INTO item_cooldowns (user_id, item_id, last_used) VALUES (?, ?, ?)').run(userId, itemId, new Date().toISOString());
  return true;
}

// Milliseconds remaining on cooldown (0 = ready)
function itemCooldownRemaining(userId, itemId) {
  const item = ITEMS[itemId];
  const cd = db.prepare('SELECT last_used FROM item_cooldowns WHERE user_id = ? AND item_id = ?').get(userId, itemId);
  if (!cd) return 0;
  return Math.max(0, item.cooldownMs - (Date.now() - new Date(cd.last_used).getTime()));
}

function fmtCooldown(ms) {
  const m = Math.floor(ms / 60000), s = Math.ceil((ms % 60000) / 1000);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

// ─── ROLE INVENTORY HELPERS ───────────────────────────────────────────────
function getRoleInventory(userId) {
  return db.prepare('SELECT * FROM role_inventory WHERE user_id = ? ORDER BY created_at DESC').all(userId);
}
function getEquippedRoles(userId) {
  return db.prepare('SELECT * FROM role_inventory WHERE user_id = ? AND equipped = 1').all(userId);
}
function ownsRole(userId, roleName) {
  return db.prepare('SELECT * FROM role_inventory WHERE user_id = ? AND role_name = ?').get(userId, roleName);
}
function addToInventory(userId, roleName, rarity) {
  const existing = ownsRole(userId, roleName);
  if (!existing) db.prepare('INSERT INTO role_inventory (user_id, role_name, rarity, equipped) VALUES (?, ?, ?, 1)').run(userId, roleName, rarity);
}
async function equipRole(member, roleName, rarity, userId) {
  const guild = await client.guilds.fetch(CONFIG.GUILD_ID);
  const guildRoles = await guild.roles.fetch();
  const role = guildRoles.find(r => r.name === roleName);
  if (role) await member.roles.add(role).catch(()=>{});
  db.prepare('UPDATE role_inventory SET equipped = 1 WHERE user_id = ? AND role_name = ?').run(userId, roleName);
}
async function unequipRole(member, roleName, userId) {
  const guild = await client.guilds.fetch(CONFIG.GUILD_ID);
  const guildRoles = await guild.roles.fetch();
  const role = guildRoles.find(r => r.name === roleName);
  if (role) await member.roles.remove(role).catch(()=>{});
  db.prepare('UPDATE role_inventory SET equipped = 0 WHERE user_id = ? AND role_name = ?').run(userId, roleName);
}

// ── Inventory embed builder ──────────────────────────────────────────────────
const INV_RARITY_EMOJI = { Common: '⬜', Uncommon: '🟦', Rare: '🟣', Legendary: '🟡' };

async function sendInventoryEmbed(channel, userId, username, page, messageOrInteraction) {
  const inv = getRoleInventory(userId);
  const equipped = inv.filter(r => r.equipped === 1);
  const unequipped = inv.filter(r => r.equipped === 0);

  // Build description
  let desc = '';
  if (!inv.length) {
    desc = '_Your inventory is empty. Head to the shop with **!shop** to grab some roles!_';
  } else {
    if (equipped.length) {
      desc += `**✅ Equipped (${equipped.length}/3):**\n`;
      desc += equipped.map(r => `${INV_RARITY_EMOJI[r.rarity] || '⬜'} **${r.role_name}** [${r.rarity}]`).join('\n');
      desc += '\n\n';
    }
    if (unequipped.length) {
      desc += `**📦 In Inventory (${unequipped.length}):**\n`;
      desc += unequipped.map(r => `${INV_RARITY_EMOJI[r.rarity] || '⬜'} **${r.role_name}** [${r.rarity}]`).join('\n');
    }
  }

  const embed = new EmbedBuilder()
    .setColor('#c9a84c')
    .setTitle(`🎒 ${username}'s Inventory`)
    .setDescription(desc)
    .setFooter({ text: `Bully's World • ${equipped.length}/3 slots equipped${inv.length ? ' · Click a button to equip or unequip' : ''}` })
    .setTimestamp();

  // Build equip/unequip buttons — show unequipped roles as "Equip", equipped as "Unequip"
  const rows = [];

  if (unequipped.length) {
    // Equip buttons (up to 5 per row, max 2 rows = 10 unequipped shown)
    const canEquip = equipped.length < 3;
    const equipChunks = [];
    for (let i = 0; i < Math.min(unequipped.length, 10); i += 5) equipChunks.push(unequipped.slice(i, i + 5));
    for (const chunk of equipChunks) {
      rows.push(new ActionRowBuilder().addComponents(
        chunk.map(r => new ButtonBuilder()
          .setCustomId(`inv_equip.${Buffer.from(r.role_name).toString('base64').slice(0,80)}`)
          .setLabel((r.role_name.length > 22 ? r.role_name.slice(0,20)+'…' : r.role_name) + ' ▲')
          .setStyle(ButtonStyle.Success)
          .setDisabled(!canEquip)
        )
      ));
    }
  }

  if (equipped.length) {
    // Unequip buttons
    const unequipChunks = [];
    for (let i = 0; i < equipped.length; i += 5) unequipChunks.push(equipped.slice(i, i + 5));
    for (const chunk of unequipChunks) {
      rows.push(new ActionRowBuilder().addComponents(
        chunk.map(r => new ButtonBuilder()
          .setCustomId(`inv_unequip.${Buffer.from(r.role_name).toString('base64').slice(0,80)}`)
          .setLabel((r.role_name.length > 20 ? r.role_name.slice(0,18)+'…' : r.role_name) + ' ✕')
          .setStyle(ButtonStyle.Danger)
        )
      ));
    }
  }

  // If no buttons, add a shop shortcut
  if (!rows.length) {
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('shop_page.0').setLabel('🛍️ Visit Shop').setStyle(ButtonStyle.Primary)
    ));
  }

  const payload = { embeds: [embed], components: rows.slice(0, 5) };

  // Reply or send depending on context
  if (messageOrInteraction?.reply) {
    return messageOrInteraction.reply(payload);
  } else {
    return channel.send(payload);
  }
}

function pickUniqueCode(tierKey, userId) {
  const dc = CONFIG.DISCOUNT_CODES[tierKey];
  if (!dc) return null;
  const used = db.prepare('SELECT code FROM used_codes WHERE user_id = ? AND tier = ?').all(userId, tierKey).map(r => r.code);
  const available = dc.codes.filter(c => !used.includes(c));
  const chosen = available.length ? available[Math.floor(Math.random() * available.length)] : dc.codes[Math.floor(Math.random() * dc.codes.length)];
  db.prepare('INSERT INTO used_codes (user_id, code, tier) VALUES (?, ?, ?)').run(userId, chosen, tierKey);
  return chosen;
}
function getStreakReward(streak) {
  for (const t of CONFIG.STREAK_TIERS) { if (streak >= t.days) return t.reward; }
  return CONFIG.CHECKIN_BASE;
}
function getCurrentSeason() {
  const m = new Date().getMonth() + 1, d = new Date().getDate();
  if ((m===3&&d>=20)||m===4||m===5||(m===6&&d<=20)) return 'spring';
  if ((m===6&&d>=21)||m===7||m===8||(m===9&&d<=22)) return 'summer';
  if ((m===9&&d>=23)||m===10||m===11||(m===12&&d<=20)) return 'fall';
  return 'winter';
}
function getRandomRole(rarity) {
  const base = CONFIG.ROLES_BASE[rarity] || [];
  const seasonal = CONFIG.ROLES_SEASONAL[getCurrentSeason()][rarity] || [];
  const pool = [...base, ...seasonal];
  return pool[Math.floor(Math.random() * pool.length)];
}
function rollDrop() {
  const roll = Math.random(); let cum = 0;
  for (const t of CONFIG.DROP_TIERS) { cum += t.prob; if (roll < cum) return t; }
  return CONFIG.DROP_TIERS[0];
}
function getCurrentGiveawayCycle() {
  const now = new Date();
  return `${now.getFullYear()}-Q${Math.floor(now.getMonth()/3)+1}`;
}
function getGiveawayEntries(userId) {
  const cycle = getCurrentGiveawayCycle();
  return db.prepare('SELECT tickets FROM giveaway_entries WHERE user_id = ? AND cycle = ?').get(userId, cycle)?.tickets || 0;
}
function addGiveawayEntries(userId, username, tickets) {
  const cycle = getCurrentGiveawayCycle();
  const ex = db.prepare('SELECT * FROM giveaway_entries WHERE user_id = ? AND cycle = ?').get(userId, cycle);
  if (ex) db.prepare('UPDATE giveaway_entries SET tickets = tickets + ? WHERE user_id = ? AND cycle = ?').run(tickets, userId, cycle);
  else db.prepare('INSERT INTO giveaway_entries (user_id, username, tickets, cycle) VALUES (?, ?, ?, ?)').run(userId, username, tickets, cycle);
}

// ─── CLAUDE GENERATOR ──────────────────────────────────────────────────────
async function generateContent(prompt) {
  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514', max_tokens: 400,
    messages: [{ role: 'user', content: `You are the voice of "Bully" — a bold, confident creative woman who paints on TikTok live and runs "Bully's Apparel". Tone: bold, direct, intentional. Never corny. Max 2 emojis. No fluff.\n${prompt}` }]
  });
  return msg.content[0].text;
}



// ─── TRIVIA — Open Trivia DB (free, no API key) ───────────────────────────
// Categories chosen to match BULLYLAND's audience
const OPENTDB_CATEGORIES = [9, 11, 12, 14, 21, 26]; // General, Film, Music, TV, Sports, Celebrities

function decodeHTML(str) {
  return str
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&ldquo;/g, '"')
    .replace(/&rdquo;/g, '"').replace(/&lsquo;/g, "'").replace(/&rsquo;/g, "'")
    .replace(/&eacute;/g, 'é').replace(/&egrave;/g, 'è').replace(/&ntilde;/g, 'ñ')
    .replace(/&ouml;/g, 'ö').replace(/&uuml;/g, 'ü').replace(/&aacute;/g, 'á')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

// Anti-cheat: invisible zero-width spaces between every character.
// Text looks identical in Discord but copy-pasting to Google/AI returns garbage.
function obfuscate(text) {
  return [...text].join('​');
}

async function generateTriviaQuestion(catId) {
  const cat = catId || OPENTDB_CATEGORIES[Math.floor(Math.random() * OPENTDB_CATEGORIES.length)];
  const res  = await fetch(`https://opentdb.com/api.php?amount=1&category=${cat}&type=multiple`);
  const data = await res.json();
  if (data.response_code !== 0 || !data.results?.length) throw new Error('OpenTDB returned no results');

  const r = data.results[0];
  const question = decodeHTML(r.question);
  const correct  = decodeHTML(r.correct_answer);
  const wrong    = r.incorrect_answers.map(decodeHTML);

  // Shuffle all 4 options and assign A/B/C/D
  const all = [correct, ...wrong].sort(() => Math.random() - 0.5);
  const letters = ['A', 'B', 'C', 'D'];
  const options  = {};
  letters.forEach((l, i) => { options[l] = all[i]; });
  const answer = letters[all.indexOf(correct)];

  return { question, options, answer };
}

// ─── HANGMAN — local word bank (free, instant) ───────────────────────────
const HANGMAN_WORDS = require('./hangman_words.json');
let _hmUsed = new Set(); // in-memory anti-repeat within a session

// Category definitions — slug → { label, filter }
// filter = string matching .category in JSON, 'words' = Word+Phrase combined, null = all
const HM_CATS = {
  artist:  { label: '🎵 Artist',          filter: 'Artist'     },
  song:    { label: '🎶 Song Title',       filter: 'Song Title' },
  tvshow:  { label: '📺 TV Show',          filter: 'TV Show'    },
  movie:   { label: '🎬 Movie',            filter: 'Movie'      },
  athlete: { label: '🏆 Athlete',          filter: 'Athlete'    },
  sneaker: { label: '👟 Sneaker',          filter: 'Sneaker'    },
  brand:   { label: '🏷️ Brand',           filter: 'Brand'      },
  slang:   { label: '💬 Slang',            filter: 'Slang'      },
  app:     { label: '📱 App',              filter: 'App'        },
  words:   { label: '📝 Words & Phrases',  filter: 'words'      },
  random:  { label: '🎲 Random',           filter: null         },
};

function generateHangmanWord(filter) {
  // Build pool based on filter
  let pool;
  if (!filter) {
    pool = HANGMAN_WORDS;
  } else if (filter === 'words') {
    pool = HANGMAN_WORDS.filter(w => w.category === 'Word' || w.category === 'Phrase');
  } else {
    pool = HANGMAN_WORDS.filter(w => w.category === filter);
  }
  const poolIndices = pool.map(entry => HANGMAN_WORDS.indexOf(entry));
  // Anti-repeat: if all entries in this pool used, clear only this pool from _hmUsed
  const available = poolIndices.filter(i => !_hmUsed.has(i));
  if (available.length === 0) poolIndices.forEach(i => _hmUsed.delete(i));
  const finalPool = available.length > 0 ? available : poolIndices;
  const pick = finalPool[Math.floor(Math.random() * finalPool.length)];
  _hmUsed.add(pick);
  return HANGMAN_WORDS[pick]; // { word, category, hint }
}

// ─── HANGMAN ASCII ────────────────────────────────────────────────────────
// 7 stages: 0 wrong = empty gallows → 6 wrong = full figure (game over)
const HANGMAN_STAGES = [
  // 0 — empty gallows
  '```\n  +--------+\n  |        |\n  |         \n  |         \n  |         \n  |         \n  |         \n  +----------\n```',
  // 1 — head
  '```\n  +--------+\n  |        |\n  |        O\n  |         \n  |         \n  |         \n  |         \n  +----------\n```',
  // 2 — head + body
  '```\n  +--------+\n  |        |\n  |        O\n  |        |\n  |        |\n  |         \n  |         \n  +----------\n```',
  // 3 — head + body + left arm
  '```\n  +--------+\n  |        |\n  |        O\n  |       /|\n  |        |\n  |         \n  |         \n  +----------\n```',
  // 4 — head + body + both arms
  '```\n  +--------+\n  |        |\n  |        O\n  |       /|\\\n  |        |\n  |         \n  |         \n  +----------\n```',
  // 5 — head + body + both arms + left leg
  '```\n  +--------+\n  |        |\n  |        O\n  |       /|\\\n  |        |\n  |       /  \n  |         \n  +----------\n```',
  // 6 — full figure (both legs) — game over
  '```\n  +--------+\n  |        |\n  |        O\n  |       /|\\\n  |        |\n  |       / \\\n  |         \n  +----------\n```',
];

function buildHangmanDisplay(word, guessed) {
  // Each character slot spaced out so players can clearly count letters per word.
  // Non-alpha characters (apostrophes, hyphens, etc.) are always shown.
  // Words separated by extra space so phrase/sentence structure is obvious.
  // e.g. "DOGS ARE GREAT" with A,R,G guessed → "D _ G _   A R _   G R _ A _"
  return word.split(' ')
    .map(w => w.split('').map(c => /[A-Z]/i.test(c) ? (guessed.has(c) ? c : '_') : c).join(' '))
    .join('   ');
}

function buildHangmanEmbed(state) {
  const { word, category, hint, guessed, wrong, display } = state;
  const wrongArr = [...wrong];
  const dangerColor = ['#2ecc71','#2ecc71','#f1c40f','#e67e22','#e67e22','#e74c3c','#8B0000'][wrong.size] || '#8B0000';
  return new EmbedBuilder()
    .setColor(dangerColor)
    .setTitle(`🔤 Hangman — ${category}`)
    .setDescription(
      `${HANGMAN_STAGES[wrong.size]}\n\n` +
      `**${display}**\n\n` +
      `💡 *${hint}*`
    )
    .addFields(
      { name: '❌ Wrong guesses', value: wrongArr.length ? wrongArr.join('  ') : '—', inline: true },
      { name: '💀 Lives left',    value: `${6 - wrong.size}`,                           inline: true },
    )
    .setFooter({ text: "Press a button, then type your guess • 30s cooldown per letter • Bully's World" })
    .setTimestamp();
}

// ─── MEMBER SPOTLIGHT ──────────────────────────────────────────────────────
async function postMemberSpotlight() {
  const channel = await client.channels.fetch(CONFIG.CHANNELS.MEMBER_SPOTLIGHT).catch(()=>null);
  if (!channel) return;
  const guild = await client.guilds.fetch(CONFIG.GUILD_ID);
  const members = await guild.members.fetch();
  const eligible = [...members.filter(m=>!m.user.bot).values()];
  if (!eligible.length) return;
  const chosen = eligible[Math.floor(Math.random()*eligible.length)];
  const days = Math.floor((Date.now()-chosen.joinedAt)/86400000);
  const role = chosen.roles.highest.name !== '@everyone' ? chosen.roles.highest.name : 'Member';
  const spotlight = await generateContent(`Write a member spotlight for: ${chosen.displayName}, role: ${role}, ${days} days in server. Make her feel seen. End with nudge for others to stay active. 4-5 sentences. Bold big sister energy.`);
  const embed = new EmbedBuilder().setColor('#c9a84c').setTitle('Member Spotlight').setDescription(spotlight)
    .addFields({name:'Member',value:`<@${chosen.id}>`,inline:true},{name:'Role',value:role,inline:true},{name:'Days with us',value:`${days}`,inline:true})
    .setThumbnail(chosen.user.displayAvatarURL()).setFooter({text:"Bully's World • Stay active. Get your flowers."}).setTimestamp();
  await channel.send({ embeds: [embed] });
  console.log(`[Member Spotlight] Featured: ${chosen.displayName}`);
}

// ─── MYSTERY DROP ──────────────────────────────────────────────────────────
async function postMysteryDrop() {
  if (!dropsEnabled) { console.log('[Mystery Drop] Skipped — drops are paused.'); return; }
  const channel = await client.channels.fetch(CONFIG.CHANNELS.MYSTERY_DROPS).catch(()=>null);
  if (!channel) return;
  if (activeDrop && !activeDrop.claimed && Date.now() < activeDrop.expiresAt) return;
  const tier = rollDrop();
  const expiresAt = Date.now() + CONFIG.DROP_EXPIRES_MINUTES * 60 * 1000;
  const embed = new EmbedBuilder().setColor('#1a1a1a').setTitle('🎰  MYSTERY DROP')
    .setDescription(`A mystery drop just landed.\n\nType **!claim** in this channel.\n**First to claim it gets it. No second chances.**`)
    .addFields({name:'Expires',value:`<t:${Math.floor(expiresAt/1000)}:R>`,inline:true})
    .setFooter({text:"Bully's World • You snooze, you lose."}).setTimestamp();
  // Purge old messages before posting new drop (preserve banner)
  try {
    const old = await channel.messages.fetch({ limit: 100 });
    const toDelete = old.filter(m => !BANNER_MESSAGE_IDS.has(m.id));
    if (toDelete.size > 0) await channel.bulkDelete(toDelete).catch(async () => { for (const [,m] of toDelete) await m.delete().catch(()=>{}); });
  } catch (_) {}
  const msg = await channel.send({ content: GAMER_PING, embeds: [embed] });
  activeDrop = { tier, claimed: false, expiresAt, messageId: msg.id };
  setTimeout(async () => {
    if (activeDrop && !activeDrop.claimed && activeDrop.messageId === msg.id) {
      activeDrop = null;
      const exp = new EmbedBuilder().setColor('#444441').setTitle('🎰  MYSTERY DROP — EXPIRED').setDescription('Nobody claimed it in time.\n\nAnother one is coming. Keep your notifications on.').setFooter({text:"Bully's World • Don't sleep next time."}).setTimestamp();
      await msg.edit({ embeds: [exp] }).catch(()=>{});
    }
  }, CONFIG.DROP_EXPIRES_MINUTES * 60 * 1000);
}

// ─── DAILY CHECK-IN ────────────────────────────────────────────────────────
async function postCheckin() {
  const channel = await client.channels.fetch(CONFIG.CHANNELS.CHECKIN).catch(()=>null);
  if (!channel) return;
  if (activeCheckin && !activeCheckin.expired && Date.now() < activeCheckin.expiresAt) return;
  const expiresAt = Date.now() + CONFIG.CHECKIN_WINDOW_MS;
  const embed = new EmbedBuilder().setColor('#c9a84c').setTitle('DAILY CHECK-IN')
    .setDescription(`Type **!checkin** in the next **3 minutes** to claim your daily Bully Bucks.\n\nDon't miss it — your streak is on the line.`)
    .addFields({name:'Expires',value:`<t:${Math.floor(expiresAt/1000)}:R>`,inline:true})
    .setFooter({text:"Bully's World • Show up every day."}).setTimestamp();
  const gamerPing = CONFIG.ROLES.GAMER ? `<@&${CONFIG.ROLES.GAMER}>` : '@here';
  const msg = await channel.send({ content: gamerPing, embeds: [embed] });
  activeCheckin = { messageId: msg.id, expiresAt, claimedUsers: new Set(), expired: false };
  setTimeout(async () => {
    if (activeCheckin && !activeCheckin.expired && activeCheckin.messageId === msg.id) {
      activeCheckin.expired = true;
      const count = activeCheckin.claimedUsers.size;
      const exp = new EmbedBuilder().setColor('#444441').setTitle('CHECK-IN CLOSED')
        .setDescription(count > 0 ? `**${count} member${count !== 1 ? 's' : ''}** checked in today. Good work.\n\nCome back tomorrow.` : 'Nobody checked in. Come back tomorrow.\n\nSet your alarm.')
        .setFooter({text:"Bully's World • Don't sleep next time."}).setTimestamp();
      await msg.edit({ embeds: [exp] }).catch(()=>{});
    }
  }, CONFIG.CHECKIN_WINDOW_MS);
}

// ─── SHOP ──────────────────────────────────────────────────────────────────

// In-memory role catalogue loaded from Google Sheet
let SHOP_ROLES = []; // [{ name, rarity, cost }]

async function loadRolesFromSheet() {
  try {
    const auth = new JWT({
      email: process.env.GOOGLE_SERVICE_EMAIL,
      key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
    const doc = new GoogleSpreadsheet(process.env.GOOGLE_ROLES_SHEET_ID, auth);
    await doc.loadInfo();
    // Try the roles sheet — try common tab names
    const sheet = doc.sheetsByTitle['Sheet1'] || doc.sheetsByTitle['Roles'] || doc.sheetsByTitle['BULLYLAND Roles'] || doc.sheetsByIndex[0];
    if (!sheet) { console.log('[Shop] Could not find roles sheet tab'); return []; }
    const rows = await sheet.getRows();
    const loaded = rows
      .filter(r => {
        const active = (r.get('active') || r.get('Active') || '').toString().trim().toUpperCase();
        return active === 'TRUE' || active === 'YES' || active === '1';
      })
      .map(r => {
        const name = (r.get('role_name') || r.get('Role Name') || '').trim();
        const rarity = (r.get('rarity') || r.get('Rarity') || 'Common').trim();
        const cost = CONFIG.ROLE_PRICES[rarity] || CONFIG.ROLE_PRICES['Common'];
        return { name, rarity, cost };
      })
      .filter(r => r.name);
    console.log(`[Shop] Loaded ${loaded.length} roles from Google Sheet`);
    return loaded;
  } catch (err) {
    console.error('[Shop] Failed to load roles from sheet:', err.message);
    return [];
  }
}

// Rarity order for sorting
const RARITY_ORDER = { Common: 0, Uncommon: 1, Rare: 2, Legendary: 3 };
const RARITY_COLOR = { Common: '#aaaaaa', Uncommon: '#57a8ff', Rare: '#cc44ff', Legendary: '#FFD700' };
const RARITY_EMOJI = { Common: '⬜', Uncommon: '🟦', Rare: '🟣', Legendary: '🟡' };

// ── Shop rotation: pick a small weighted-random selection every 12 hours ──────
// With 60 roles and 5 shown per cycle (2x/day), a user would need ~6 cycles per
// role on average = ~180 days to see all roles if they check every refresh.
// Rarity weights make Common appear more often, Legendary very rarely.
const SHOP_RARITY_WEIGHTS = { Common: 10, Uncommon: 5, Rare: 2, Legendary: 1 };
const SHOP_SLOT_COUNT = 5; // roles shown per 12h cycle

let activeShopRoles = []; // the current 5 roles on sale

function pickShopRoles(allRoles) {
  if (!allRoles.length) return [];
  // Build weighted pool
  const pool = [];
  for (const role of allRoles) {
    const w = SHOP_RARITY_WEIGHTS[role.rarity] || 1;
    for (let i = 0; i < w; i++) pool.push(role);
  }
  // Fisher-Yates shuffle then pick unique roles
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  const seen = new Set();
  const picked = [];
  for (const r of shuffled) {
    if (!seen.has(r.name) && picked.length < SHOP_SLOT_COUNT) {
      seen.add(r.name);
      picked.push(r);
    }
  }
  return picked;
}

async function purgeShopChannel(channel) {
  try {
    const messages = await channel.messages.fetch({ limit: 100 });
    const toDelete = messages.filter(m => !BANNER_MESSAGE_IDS.has(m.id));
    if (toDelete.size > 0) {
      await channel.bulkDelete(toDelete).catch(async () => {
        for (const [, m] of toDelete) await m.delete().catch(() => {});
      });
    }
  } catch (_) {}
}

async function refreshShop(forceNew = false) {
  SHOP_ROLES = await loadRolesFromSheet();

  // Restore persisted shop if still valid (survives bot restarts/updates)
  if (!forceNew) {
    const saved = db.prepare('SELECT * FROM shop_state WHERE id = 1').get();
    if (saved && new Date(saved.expires_at) > new Date()) {
      try {
        activeShopRoles = JSON.parse(saved.roles_json);
        shopRefreshTime = new Date(saved.expires_at);
        console.log('[Shop] Restored persisted shop lineup — still valid until', saved.expires_at);
      } catch (_) { /* fall through to re-pick */ }
    }
  }

  // Pick new roles if nothing valid in DB
  if (!activeShopRoles.length || forceNew) {
    activeShopRoles = pickShopRoles(SHOP_ROLES);
    shopRefreshTime = new Date(Date.now() + 12 * 60 * 60 * 1000);
    db.prepare(`
      INSERT INTO shop_state (id, roles_json, expires_at) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET roles_json = excluded.roles_json, expires_at = excluded.expires_at
    `).run(JSON.stringify(activeShopRoles), shopRefreshTime.toISOString());
  }

  const channel = await client.channels.fetch(CONFIG.CHANNELS.SHOP).catch(() => null);
  if (!channel) return;
  await purgeShopChannel(channel);
  lastShopMessageId = null;
  if (!activeShopRoles.length) {
    const msg = await channel.send({ embeds: [new EmbedBuilder().setColor('#1a1a1a').setTitle("🛍️ BULLY'S STORE").setDescription('The shop is loading. Check back shortly.').setFooter({ text: "Bully's World" }).setTimestamp()] });
    lastShopMessageId = msg.id;
    return;
  }
  const msg = await postShopEmbed(channel);
  if (msg) lastShopMessageId = msg.id;
}

async function postShopEmbed(channel) {
  const nextRefresh = shopRefreshTime || new Date(Date.now() + 12 * 60 * 60 * 1000);

  // ── Shop closed state ────────────────────────────────────────────────────────
  if (!isEnabled('shop')) {
    const closedEmbed = new EmbedBuilder()
      .setColor('#1a1a1a')
      .setTitle("🛍️ BULLY'S STORE")
      .setDescription('🔒 **The shop is currently closed.**\n\nCheck back later!')
      .setFooter({ text: "Bully's World" })
      .setTimestamp();
    return channel.send({ embeds: [closedEmbed], components: [] });
  }

  const roles = activeShopRoles;

  // Always derive price from CONFIG so stale DB cache never shows wrong price
  const desc = roles.map(r => {
    const price = CONFIG.ROLE_PRICES[r.rarity] || CONFIG.ROLE_PRICES['Common'];
    return `${RARITY_EMOJI[r.rarity] || '⬜'} **${r.name}** [${r.rarity}] — **${price} BB**`;
  }).join('\n');

  const embed = new EmbedBuilder()
    .setColor('#c9a84c')
    .setTitle("🛍️ BULLY'S STORE")
    .setDescription(
      `New roles available! They go straight to your inventory when purchased.\n\n${desc}\n\n` +
      `_Refreshes <t:${Math.floor(nextRefresh.getTime() / 1000)}:R> · Use **!inventory** to manage your roles._`
    )
    .addFields(
      { name: '💰 Prices', value: Object.entries(CONFIG.ROLE_PRICES).map(([r, p]) => `${RARITY_EMOJI[r]} ${r}: **${p} BB**`).join(' · '), inline: false }
    )
    .setFooter({ text: "Bully's World • Check back every 12 hours for new roles." })
    .setTimestamp();

  // One row of buy buttons — one per role (max 5)
  const btns = roles.map((r, i) => new ButtonBuilder()
    .setCustomId(`shopbuy_role.${i}`)
    .setLabel(r.name.length > 25 ? r.name.slice(0, 23) + '…' : r.name)
    .setStyle(
      r.rarity === 'Legendary' ? ButtonStyle.Success :
      r.rarity === 'Rare'      ? ButtonStyle.Primary :
      ButtonStyle.Secondary
    )
  );

  const rows = [];
  for (let i = 0; i < btns.length; i += 5) {
    rows.push(new ActionRowBuilder().addComponents(...btns.slice(i, i + 5)));
  }

  return channel.send({ embeds: [embed], components: rows });
}

// ─── TESTER GATE ────────────────────────────────────────────────────────────
// Toggle with !testingmode on/off (admin only). Off by default for live use.
let TESTING_MODE = false;
const TESTER_ROLE_ID = '1498127933963767987';

function hasAccess(member) {
  if (!TESTING_MODE) return true;
  if (!member) return false;
  if (member.permissions.has(PermissionsBitField.Flags.Administrator)) return true;
  if (member.roles.cache.has(TESTER_ROLE_ID)) return true;
  return false;
}
// ────────────────────────────────────────────────────────────────────────────


async function doMonthlyReset() {
  const channel = await client.channels.fetch(CONFIG.CHANNELS.LEADERBOARD).catch(()=>null);
  if (!channel) return;
  const month = new Date().toISOString().slice(0,7);
  const top = db.prepare('SELECT * FROM monthly_earnings WHERE month = ? ORDER BY earned_this_month DESC LIMIT 1').get(month);
  if (!top) return;
  addBB(top.user_id, top.username, CONFIG.MONTHLY_WINNER_BB, 'monthly leaderboard winner');
  const guild = await client.guilds.fetch(CONFIG.GUILD_ID);
  const member = await guild.members.fetch(top.user_id).catch(()=>null);
  if (member && CONFIG.ROLES.LEADERBOARD_LEADER) {
    await member.roles.add(CONFIG.ROLES.LEADERBOARD_LEADER).catch(()=>{});
    setTimeout(async()=>{ await member.roles.remove(CONFIG.ROLES.LEADERBOARD_LEADER).catch(()=>{}); }, 30*24*60*60*1000);
  }
  const embed = new EmbedBuilder().setColor('#c9a84c').setTitle('MONTHLY LEADERBOARD WINNER')
    .setDescription(`<@${top.user_id}> earned the most Bully Bucks this month.\n\nShe takes home **${CONFIG.MONTHLY_WINNER_BB} BB** and the **BIG BALLER💴** role for 30 days.\n\nCome for her crown next month.`)
    .addFields({name:'Bucks earned this month',value:`${top.earned_this_month} BB`,inline:true})
    .setFooter({text:"Bully's World • The top spot is up for grabs again."}).setTimestamp();
  await channel.send({ embeds: [embed] });
  db.prepare('DELETE FROM monthly_earnings WHERE month = ?').run(month);
}

// ─── LEADERBOARD EMBED BUILDER ────────────────────────────────────────────
function buildLeaderboardEmbed() {
  const top = db.prepare(
    `SELECT user_id, username, (balance + COALESCE(bank_balance, 0)) as total
     FROM balances WHERE user_id != ? ORDER BY total DESC LIMIT 10`
  ).all(CONFIG.OWNER_ID);

  const king = db.prepare('SELECT balance, COALESCE(bank_balance, 0) as bank FROM balances WHERE user_id = ?').get(CONFIG.OWNER_ID);
  const kingTotal = king ? (king.balance + king.bank) : 0;
  const kingSection = `👑 **The King** — **${kingTotal.toLocaleString()} BB**\n​\n`;
  const topSection = top.length
    ? top.map((u, i) => `**${i + 1}.** ${u.username}`).join('\n')
    : '_No one has any BB yet._';

  return new EmbedBuilder()
    .setColor('#c9a84c')
    .setTitle('📊 Monthly Leaderboard')
    .setDescription(kingSection + topSection + '\n\nTop earner at month end wins the **BIG BALLER💴** role + bonus BB.')
    .setFooter({ text: "Bully's World • Come for that top spot." })
    .setTimestamp();
}

async function purgeLeaderboardChannel(channel) {
  try {
    const messages = await channel.messages.fetch({ limit: 100 });
    const toDelete = messages.filter(m => !BANNER_MESSAGE_IDS.has(m.id));
    if (toDelete.size > 0) {
      await channel.bulkDelete(toDelete).catch(async () => {
        for (const [, m] of toDelete) await m.delete().catch(() => {});
      });
    }
  } catch (_) {}
}

async function postDailyLeaderboard() {
  const channel = await client.channels.fetch(CONFIG.CHANNELS.LEADERBOARD).catch(() => null);
  if (!channel) return;
  await purgeLeaderboardChannel(channel);
  lastLeaderboardMessageId = null;
  const embed = buildLeaderboardEmbed();
  const msg = await channel.send({ embeds: [embed] });
  lastLeaderboardMessageId = msg.id;
}

// ─── GIVEAWAY CHANNEL VISIBILITY ──────────────────────────────────────────
async function setGiveawayChannelVisible(visible) {
  try {
    const guild = await client.guilds.fetch(CONFIG.GUILD_ID);
    const channel = await guild.channels.fetch(CONFIG.CHANNELS.GIVEAWAY).catch(()=>null);
    if (!channel) return;
    await channel.permissionOverwrites.edit(CONFIG.EVERYONE_ROLE_ID, {
      ViewChannel: visible,
      SendMessages: false,
    });
    console.log(`[Giveaway Channel] ${visible ? 'Shown' : 'Hidden'}`);
  } catch(e) { console.error('[Giveaway Channel] Error:', e); }
}

async function postGiveawayOpening() {
  await setGiveawayChannelVisible(true);
  const channel = await client.channels.fetch(CONFIG.CHANNELS.GIVEAWAY).catch(()=>null);
  if (!channel) return;
  const embed = new EmbedBuilder().setColor('#c9a84c')
    .setTitle('🎉 QUARTERLY GIVEAWAY IS OPEN!')
    .setDescription(
      `The quarterly giveaway window is now open!\n\n` +
      `**Prize:** ${CONFIG.GIVEAWAY_PRIZE}\n\n` +
      `You have **7 days** to buy tickets in the shop before the winner is drawn.\n\n` +
      `Type **!shop** in the server to grab your tickets.\n\n` +
      `**Ticket prices:**\n` +
      `• x1 ticket — 500 BB\n` +
      `• x3 tickets — 1,000 BB\n\n` +
      `Max 15 tickets per person. More tickets = better odds. Good luck! 🎰`
    )
    .setFooter({text:"Bully's World • May the best lady win."}).setTimestamp();
  await channel.send({ content: GAMER_PING, embeds: [embed] });
  console.log('[Giveaway] Opening announcement posted');
}

// ─── ACTIVE GIVEAWAY SESSIONS ─────────────────────────────────────────────
// Tracks active winner sessions so owner DM replies get forwarded correctly
const activeGiveawaySessions = new Map();
// Map<ownerId, { winnerUserId, winnerMember, cycle }>

// ─── QUARTERLY GIVEAWAY ────────────────────────────────────────────────────
async function runGiveaway() {
  const channel = await client.channels.fetch(CONFIG.CHANNELS.GIVEAWAY).catch(()=>null);
  if (!channel) return;
  const cycle = getCurrentGiveawayCycle();
  const entries = db.prepare('SELECT * FROM giveaway_entries WHERE cycle = ?').all(cycle);
  if (!entries.length) { await channel.send('No entries this cycle. Next giveaway starts now.'); return; }
  const pool = [];
  entries.forEach(e=>{ for(let i=0;i<e.tickets;i++) pool.push({userId:e.user_id,username:e.username}); });
  const winner = pool[Math.floor(Math.random()*pool.length)];
  const winnerTickets = entries.find(e=>e.user_id===winner.userId)?.tickets||1;

  // Public winner announcement
  const embed = new EmbedBuilder().setColor('#c9a84c').setTitle('🎉 QUARTERLY GIVEAWAY WINNER')
    .setDescription(`<@${winner.userId}> just won the quarterly giveaway!\n\nPrize: **${CONFIG.GIVEAWAY_PRIZE}**\n\nCheck your DMs to claim. You have **48 hours** or the prize is forfeited.`)
    .addFields({name:'Total entries',value:`${pool.length}`,inline:true},{name:"Winner's tickets",value:`${winnerTickets}`,inline:true})
    .setFooter({text:"Bully's World • Congratulations!"}).setTimestamp();
  await channel.send({ content: GAMER_PING, embeds: [embed] });

  try {
    const guild = await client.guilds.fetch(CONFIG.GUILD_ID);
    const winMember = await guild.members.fetch(winner.userId).catch(()=>null);
    if (!winMember) return;

    // Winner DM — shipping form
    const winnerDM = new EmbedBuilder().setColor('#c9a84c').setTitle("🎉 You won Bully's World Quarterly Giveaway!")
      .setDescription(
        `Congratulations! You just won **a free garment from Bully's Apparel!**\n\n` +
        `To claim your prize, copy and paste the form below, fill in each field, and reply to this DM.\n\n` +
        `─────────────────────\n\n` +
        `**Full Name:**\n\n` +
        `**Address Line 1:**\n\n` +
        `**Address Line 2** *(apartment, suite, etc. — type N/A if none)*:\n\n` +
        `**City:**\n\n` +
        `**State/Province:**\n\n` +
        `**ZIP/Postal Code:**\n\n` +
        `**Country:**\n\n` +
        `**Phone Number** *(for delivery purposes)*:\n\n` +
        `**Garment Size** *(XS / S / M / L / XL / XXL)*:\n\n` +
        `─────────────────────\n\n` +
        `You have **48 hours** to reply or your prize is forfeited and a new winner will be selected.\n\n` +
        `⚠️ Please fill out every field. Incomplete forms may delay your prize.`
      )
      .setFooter({text:"Bully's Apparel • You earned this."}).setTimestamp();
    await winMember.send({ embeds: [winnerDM] });

    // Start the back-and-forth shipping collection loop
    await collectShippingLoop(winMember, winner, cycle, winnerTickets);

  } catch(e){ console.error('[Giveaway] Error:', e); }
  db.prepare('DELETE FROM giveaway_entries WHERE cycle = ?').run(cycle);
}

async function collectShippingLoop(winMember, winner, cycle, winnerTickets) {
  const winnerDMChannel = await winMember.createDM();
  const owner = await client.users.fetch(CONFIG.OWNER_ID).catch(()=>null);
  if (!owner) { console.error('[Giveaway] Could not fetch owner'); return; }
  const ownerDMChannel = await owner.createDM();

  // Store active session so owner replies get routed correctly
  activeGiveawaySessions.set(owner.id, { winnerUserId: winner.userId, winnerMember: winMember, cycle });

  // Listen for winner reply (48 hour window, no max — keeps going until confirmed)
  const winnerCollector = winnerDMChannel.createMessageCollector({
    filter: m => m.author.id === winner.userId,
    time: 48 * 60 * 60 * 1000,
  });

  winnerCollector.on('collect', async(msg) => {
    // Forward winner's message to owner with confirm instructions
    const ownerEmbed = new EmbedBuilder().setColor('#1a1a1a')
      .setTitle(`📦 Giveaway Shipping Info — ${cycle}`)
      .setDescription(
        `**Winner:** ${winner.username} (<@${winner.userId}>)\n` +
        `**Tickets:** ${winnerTickets}\n\n` +
        `─────────────────────\n\n` +
        `${msg.content}\n\n` +
        `─────────────────────\n\n` +
        `Type **!confirm** to confirm this information is complete and send the winner a confirmation message.\n\n` +
        `Or type any other message and it will be forwarded directly to the winner asking them to fix or add the missing information.`
      )
      .setFooter({text:"Bully's World — Giveaway System"}).setTimestamp();
    await owner.send({ embeds: [ownerEmbed] });
  });

  winnerCollector.on('end', async(col) => {
    if (!col.size) {
      await winMember.send("Your prize has been forfeited due to no response within 48 hours. Better luck next cycle!").catch(()=>{});
      activeGiveawaySessions.delete(owner.id);
    }
  });
}

// ─── OWNER DM HANDLER — giveaway confirm/forward ──────────────────────────
client.on('messageCreate', async(message) => {
  if (!message.author.bot && message.channel.type === 1 && message.author.id === CONFIG.OWNER_ID) {
    const session = activeGiveawaySessions.get(CONFIG.OWNER_ID);
    if (!session) return;

    const { winnerMember, cycle } = session;

    if (message.content.trim().toLowerCase() === '!confirm') {
      // Confirmed — send winner the confirmation message
      const confirmEmbed = new EmbedBuilder().setColor('#3B6D11')
        .setTitle('✅ Shipping Information Confirmed!')
        .setDescription(
          `Your shipping information has been received!\n\n` +
          `Your prize will be on its way soon.\n\n` +
          `Thank you for being part of BULLYLAND! 🎉`
        )
        .setFooter({text:"Bully's Apparel • Wear the art."}).setTimestamp();
      await winnerMember.send({ embeds: [confirmEmbed] }).catch(()=>{});
      await message.reply(`✅ Confirmed! Winner has been notified that their prize is on the way.`);
      activeGiveawaySessions.delete(CONFIG.OWNER_ID);
      await setGiveawayChannelVisible(false);

    } else {
      // Forward owner's message to winner asking them to fix/add info
      const forwardEmbed = new EmbedBuilder().setColor('#c9a84c')
        .setTitle('📝 Update needed on your shipping form')
        .setDescription(
          `Hey! We received your shipping form but need a little more info:\n\n` +
          `**${message.content}**\n\n` +
          `Please reply to this DM with the corrected or missing information.`
        )
        .setFooter({text:"Bully's Apparel • Almost there!"}).setTimestamp();
      await winnerMember.send({ embeds: [forwardEmbed] }).catch(()=>{});
      await message.reply(`✅ Message forwarded to the winner. Waiting for their updated response.`);
    }
  }
});

// ─── TREASURE CHEST REACTION HANDLER ─────────────────────────────────────
client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot) return;
  await dailyQ.handleReaction(reaction, user).catch(() => {});
  if (!activeChest) return;
  if (reaction.message.id !== activeChest.messageId) return;
  if (reaction.emoji.name !== '🧡') return;

  const { tier, generalChannelId, generalAnnouncementMsgId } = activeChest;
  activeChest = null;

  const amount = Math.floor(Math.random() * (tier.max - tier.min + 1)) + tier.min;
  const guild = await client.guilds.fetch(CONFIG.GUILD_ID);
  const member = await guild.members.fetch(user.id).catch(()=>null);
  if (!member) return;

  addBB(user.id, user.username, amount, `treasure chest — ${tier.name}`);

  // Delete the chest message in the hidden channel
  await reaction.message.delete().catch(()=>{});

  // Delete the general "chest appeared" announcement
  if (generalChannelId && generalAnnouncementMsgId) {
    const general = await client.channels.fetch(generalChannelId).catch(()=>null);
    if (general) {
      const announcementMsg = await general.messages.fetch(generalAnnouncementMsgId).catch(()=>null);
      if (announcementMsg) await announcementMsg.delete().catch(()=>{});

      // Post winner notice and auto-delete after 20 seconds
      const winnerMsg = await general.send({
        embeds: [new EmbedBuilder().setColor(tier.color)
          .setTitle(`${tier.emoji} Treasure Chest Claimed!`)
          .setDescription(`<@${user.id}> found the **${tier.name}** treasure chest and walked away with **${amount} BB**!`)
          .setFooter({text:"Bully's World • Keep exploring."}).setTimestamp()
        ]
      }).catch(()=>null);
      if (winnerMsg) setTimeout(() => winnerMsg.delete().catch(()=>{}), 20000);
    }
  }
});

// ─── WELCOME DM ────────────────────────────────────────────────────────────
client.on('guildMemberAdd', async(member) => {
  try {
    const embed = new EmbedBuilder()
      .setColor('#c9a84c')
      .setTitle(`🎨 Welcome to BULLYLAND, ${member.displayName}!`)
      .setDescription(
        `You just joined Bully's private community — the only place where showing up actually pays.\n\n` +

        `**💰 Bully Bucks**\n` +
        `Every message you send earns you **5 BB**. Check in daily for up to **400 BB** per day. Stack your streak and that number keeps climbing.\n\n` +

        `**📅 Daily Check-In**\n` +
        `A check-in drops in the server every morning. Type **!checkin** when you see it — you have **3 minutes** to grab it. Don't miss it. Turn on notifications.\n\n` +

        `**🏦 The Bank**\n` +
        `Your BB can be stolen. Keep it safe by depositing into your bank with **!deposit**. Your bank limit grows as you level up. Type **!bank** for details.\n\n` +

        `**🛍️ The Shop**\n` +
        `Once you hit **Level 1 (Rookie)**, the shop opens up. Spend your BB on discount codes for Bully's Apparel, collectible badges, and more. Type **!shop** to browse.\n\n` +

        `**🎮 Games**\n` +
        `Casino, Heists, Trivia, Lottery, Hangman — all of it lives in the games channel. Type **!bullygames** to open the menu.\n\n` +

        `**⚡ Quick Commands**\n` +
        `\`!balance\` — see your BB\n` +
        `\`!bank\` — banking guide & tiers\n` +
        `\`!bullygames\` — game menu\n` +
        `\`!shop\` — what's for sale\n` +
        `\`!help\` — full guide with topic buttons\n\n` +

        `See you in the server. 🤝`
      )
      .setFooter({ text: "Bully's World • Show up. Stack up." })
      .setTimestamp();
    await member.send({ embeds: [embed] });
  } catch { console.log(`[Welcome DM] Could not DM ${member.user.username}`); }
});

// ─── LEVEL-UP REWARDS — auto-DM when Lurkr assigns a new level role ──────────
// NOTE: Disable Lurkr's own level-up DM in the Lurkr dashboard — this bot owns
// the level-up experience. Two DMs would be confusing and redundant.
const LEVEL_REWARD_INFO = {
  '1490053545116827934': { // Rookie
    color: '#2ecc71',
    title: '🏁 Rookie. You made it in.',
    body:
      `Most people join and disappear. You didn't. That already means something.\n\n` +
      `Here's what just unlocked for you:\n\n` +
      `🏦 **Your bank is open.** Deposit up to **150 BB** to protect your bag from steals and heists. Use \`!deposit\` to lock it in.\n\n` +
      `🛍️ **The shop is yours.** Roles, perks, and collectibles rotate every 12 hours. Type \`!shop\` to browse.\n\n` +
      `🎟️ **Lottery access.** Buy tickets for the weekly jackpot through \`!bullygames\`.\n\n` +
      `You're in the game now. Every level from here raises your bank cap and opens more. Keep going.`,
  },
  '1490051621521195099': { // Newbie
    color: '#3498db',
    title: '📶 Newbie. Still here — that\'s not nothing.',
    body:
      `A lot of people hit Rookie and stop. You kept going.\n\n` +
      `Your bank cap just jumped to **350 BB**. Move more into savings — the bigger your bank, the harder you are to touch.\n\n` +
      `Use \`!deposit\` to top it off. Use \`!bank\` to see your full picture.\n\n` +
      `The next level is closer than you think. You already know how this works — just keep showing up.`,
  },
  '1490051740349894867': { // BB Member
    color: '#9b59b6',
    title: '💜 BB Member. You\'re not a newcomer anymore.',
    body:
      `You've put in real time here. BULLYLAND recognizes that.\n\n` +
      `Bank cap raised to **700 BB**. At this level your savings are starting to actually mean something — don't leave it sitting in your wallet where anyone can take it.\n\n` +
      `You're becoming one of the regulars. The ones who've been around long enough to know how everything works.\n\n` +
      `More levels ahead. More rewards waiting. Don't slow down now.`,
  },
  '1490051785048588449': { // Veteran
    color: '#e67e22',
    title: '⚔️ Veteran. You\'ve earned that title.',
    body:
      `Not everyone gets here. You've been consistent enough that the server gave you a title for it.\n\n` +
      `Bank cap raised to **1,250 BB**. At Veteran level your bank is a real asset — protect it, grow it, use it.\n\n` +
      `You know this community better than most. That knowledge is worth something.\n\n` +
      `Four levels down. Four to go. The higher you climb, the more exclusive the company gets.`,
  },
  '1490051823384662187': { // OG
    color: '#e74c3c',
    title: '🔥 OG. There\'s a short list of people who get here.',
    body:
      `OG status isn't handed out. You put in the time, stayed consistent, and showed up when others didn't.\n\n` +
      `Bank cap raised to **2,500 BB**. You're sitting on real weight now. Make sure it's protected.\n\n` +
      `You're part of the foundation of this community — the people who were here when it was being built. That matters.\n\n` +
      `Three levels left. The top is visible from here.`,
  },
  '1490051918976913558': { // VIP
    color: '#c9a84c',
    title: '💎 VIP. You\'re not just a member — you\'re a fixture.',
    body:
      `VIP. One of the most active, most present people in BULLYLAND.\n\n` +
      `Bank cap raised to **4,000 BB**. At this level you're not playing around — you're stacking serious weight.\n\n` +
      `Bully sees who's in the room every day. VIPs are the ones who never leave.\n\n` +
      `Two levels between you and the top. You already know what to do.`,
  },
  '1490052510868574341': { // BOSS
    color: '#8e44ad',
    title: '👑 BOSS. Real ones recognize.',
    body:
      `BOSS tier. You're in the upper echelon of this community now.\n\n` +
      `Bank cap raised to **6,000 BB**. Protect every bit of it.\n\n` +
      `There are people in this server who've been here for months who haven't touched this level. You did. That's not luck — that's dedication.\n\n` +
      `One level left. The highest one. You know what it is.`,
  },
  '1490051416449093652': { // BULLY Approved
    color: '#1a1a1a',
    title: '🌟 BULLY Approved. This is as high as it goes.',
    body:
      `You made it to the top.\n\n` +
      `**BULLY Approved** — the highest rank in BULLYLAND. Bank cap maxed at **9,000 BB**.\n\n` +
      `There's no higher level. No more unlocks after this one. Just the fact that you're one of the very few people in this community who went all the way.\n\n` +
      `Bully knows who you are. The community knows who you are.\n\n` +
      `You are BULLYLAND. 🎨`,
  },
};

client.on('guildMemberUpdate', async (oldMember, newMember) => {
  try {
    const addedRoleIds = [...newMember.roles.cache.keys()].filter(id => !oldMember.roles.cache.has(id));

    // ── Lurkr level-up rewards ────────────────────────────────────────────────
    for (const roleId of addedRoleIds) {
      const info = LEVEL_REWARD_INFO[roleId];
      if (!info) continue;
      const tier = BANK_LEVEL_ROLES.find(t => t.roleId === roleId);
      const embed = new EmbedBuilder()
        .setColor(info.color || '#c9a84c')
        .setTitle(info.title)
        .setDescription(info.body)
        .setFooter({ text: "Bully's World • Keep leveling up." })
        .setTimestamp();
      await newMember.send({ embeds: [embed] }).catch(() => {});
      console.log(`[LevelUp] Sent reward DM to ${newMember.user.username} for role ${tier?.label || roleId}`);
    }

    // ── Booster role granted ──────────────────────────────────────────────────
    const boosterRoleId = process.env.ROLE_BOOSTER;
    if (boosterRoleId && addedRoleIds.includes(boosterRoleId)) {
      const week = getISOWeek();
      const already = db.prepare('SELECT 1 FROM booster_payouts WHERE user_id = ? AND week = ?').get(newMember.id, week);
      if (!already) {
        addBB(newMember.id, newMember.user.username, BOOSTER_WEEKLY_BB, 'Booster Club — first week reward');
        db.prepare('INSERT OR IGNORE INTO booster_payouts (user_id, week) VALUES (?, ?)').run(newMember.id, week);
        await sendBoosterPaycheck(newMember, true);
        console.log(`[Booster] New booster: ${newMember.user.username} — paid ${BOOSTER_WEEKLY_BB} BB`);
      }
    }

    // ── Superfan role granted (admin manually assigns ROLE_SUPERFAN) ──────────
    const superfanRoleId = process.env.ROLE_SUPERFAN;
    if (superfanRoleId && addedRoleIds.includes(superfanRoleId)) {
      const week    = getISOWeek();
      const already = db.prepare('SELECT 1 FROM superfan_payouts WHERE user_id = ? AND week = ?').get(newMember.id, week);
      if (!already) {
        addBB(newMember.id, newMember.user.username, SUPERFAN_WEEKLY_BB, 'Superfan Club — first week reward');
        db.prepare('INSERT OR IGNORE INTO superfan_payouts (user_id, week) VALUES (?, ?)').run(newMember.id, week);
        await sendSuperfanPaycheck(newMember, true);
        console.log(`[Superfan] New superfan: ${newMember.user.username} — paid ${SUPERFAN_WEEKLY_BB} BB`);
      }
    }

  } catch (e) {
    console.error('[LevelUp/Booster] guildMemberUpdate error:', e.message);
  }
});


// ═══════════════════════════════════════════════════════════════════════════════
// ─── HEIST ROLE CHALLENGE SYSTEM ───────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function getHeistDifficulty(entry) {
  if (entry <= 8)  return 'easy';
  if (entry <= 15) return 'medium';
  return 'hard';
}

function getOutcomeTier(totalScore, crewCount) {
  const maxScore = crewCount * 2;
  const pct = maxScore > 0 ? totalScore / maxScore : 0;
  if (totalScore < 0) return 'arrest';
  if (pct >= 0.80)    return 'major';
  if (pct >= 0.60)    return 'success';
  if (pct >= 0.35)    return 'partial';
  return 'failure';
}

function hcScoreLabel(score) {
  if (score >= 2)  return '\u2705 **+2 pts** \u2014 Perfect!';
  if (score === 1) return '\u26a0\ufe0f **+1 pt** \u2014 Success';
  if (score === 0) return '\u274c **0 pts** \u2014 Failed';
  return '\ud83d\udca5 **\u22121 pt** \u2014 Critical Failure';
}
function hcScoreColor(score) {
  if (score >= 2)  return '#3B6D11';
  if (score === 1) return '#FFD700';
  if (score === 0) return '#888888';
  return '#8B0000';
}

// ── Content pools ─────────────────────────────────────────────────────────────

const MASTERMIND_SCENARIOS = {
  easy: [
    { situation: 'A guard just changed patrol route and is heading toward the crew.',
      choices: [
        { label: 'A) Hide and wait for them to pass',       score: 2,  feedback: 'Smart call. The guard walked right past.' },
        { label: 'B) Keep moving quickly through the area', score: 1,  feedback: 'Barely avoided detection. Risky but fine.' },
        { label: 'C) Fall back and abort the objective',    score: -1, feedback: 'Unnecessary abort. The crew lost their window for nothing.' },
      ]
    },
    { situation: 'An alarm starts beeping in an adjacent room.',
      choices: [
        { label: 'A) Send the Distraction to investigate', score: 2,  feedback: 'False alarm. Distraction neutralized it perfectly.' },
        { label: 'B) Ignore it and push forward',          score: 1,  feedback: 'It was nothing \u2014 but that was a gamble.' },
        { label: 'C) Abort immediately',                   score: -1, feedback: 'False alarm. You pulled the crew for nothing.' },
      ]
    },
    { situation: 'Your entry window is closing faster than expected.',
      choices: [
        { label: 'A) Prioritize the main target only',              score: 2,  feedback: 'Focused the crew. In, grabbed it, out.' },
        { label: 'B) Rush through and grab everything possible',    score: 0,  feedback: 'Rushing caused noise. Barely escaped.' },
        { label: 'C) Abort and wait for a better window',           score: -1, feedback: 'Needless retreat. The opportunity is gone.' },
      ]
    },
    { situation: 'A staff member walks into the room next to your position.',
      choices: [
        { label: 'A) Hold position and let them pass',              score: 2, feedback: 'They left after two minutes. Clean.' },
        { label: 'B) Push forward quietly and fast',                score: 1, feedback: 'Tight. They heard something but dismissed it.' },
        { label: 'C) Create a loud distraction to draw them away',  score: 0, feedback: 'It worked but attracted two more staff.' },
      ]
    },
  ],
  medium: [
    { situation: 'Security has doubled near the vault. One guard is watching a separate camera feed.',
      choices: [
        { label: 'A) Push forward \u2014 hit them fast',                     score: -1, feedback: 'Walked straight into the patrol. Busted.' },
        { label: 'B) Lookout handles camera, rest push through',       score: 2,  feedback: 'Camera blind spot exploited. Textbook.' },
        { label: 'C) Wait 10 minutes for the shift change',            score: 1,  feedback: 'Safe call, but the delay cost the crew time.' },
        { label: 'D) Take the loading dock detour around security',    score: 0,  feedback: 'Long route. Window had already shrunk.' },
      ]
    },
    { situation: 'The Driller is running 3 minutes over schedule. Everyone is exposed.',
      choices: [
        { label: 'A) Hold \u2014 give the Driller 2 more minutes',         score: 2,  feedback: 'They got through. Trust in your crew paid off.' },
        { label: 'B) Send Getaway ahead to scout the exit early',    score: 1,  feedback: 'Solid thinking. Exit confirmed clear when needed.' },
        { label: 'C) Pull the Driller and switch to secondary entry', score: 0,  feedback: 'Secondary entry was slower. Lost even more time.' },
        { label: 'D) Trigger a fire alarm to buy time',              score: -1, feedback: 'Fire alarm locked down the entire building.' },
      ]
    },
    { situation: 'Motion sensors activated in the target room. You have 90 seconds.',
      choices: [
        { label: 'A) Abort \u2014 sensor activation means exposure',       score: 0,  feedback: 'Sensor was a glitch. Mission aborted for nothing.' },
        { label: 'B) Go now \u2014 move through before security verifies', score: 2,  feedback: 'Made it through before they confirmed. Razor thin.' },
        { label: 'C) Send one person while rest hold the perimeter', score: 1,  feedback: 'Worked. Solo entry was slower but undetected.' },
        { label: 'D) Have Distraction pull fire alarm to reset sensors', score: -1, feedback: 'Full lockdown triggered. Every exit sealed.' },
      ]
    },
  ],
  hard: [
    { situation: 'Biometric scanner on the vault door. Your bypass device is malfunctioning.',
      choices: [
        { label: 'A) Force entry before security responds',             score: -1, feedback: 'Silent alarm triggered. Surrounded in 40 seconds.' },
        { label: 'B) Have Driller access the secondary hardwire panel', score: 2,  feedback: 'Driller found the bypass. Clean entry. No alarm.' },
        { label: 'C) Bluff through as maintenance staff',               score: 1,  feedback: 'They were suspicious. You talked your way in.' },
        { label: 'D) Abort \u2014 equipment failure means mission failure', score: 0, feedback: 'Smart retreat but the objective was abandoned.' },
      ]
    },
    { situation: 'One guard has eyes on your Distraction and is radioing for backup.',
      choices: [
        { label: 'A) Distraction runs \u2014 draw security away',          score: 2,  feedback: 'Sacrificial play worked. Crew secured the objective.' },
        { label: 'B) Complete objective fast, leave Distraction behind', score: 1,  feedback: 'Cold. Effective. Objective secured before lockdown.' },
        { label: 'C) Everyone freeze and hope the guard loses interest', score: -1, feedback: 'Guard radioed in. Backup arrived in 90 seconds.' },
        { label: 'D) Attempt to quietly neutralize the guard',          score: 0,  feedback: 'Too risky. Guard got a partial radio call out.' },
      ]
    },
    { situation: 'Silent countdown \u2014 60 seconds to enter the final code or vault locks for 24 hours.',
      choices: [
        { label: 'A) Take full time to verify every digit',           score: 2,  feedback: 'Entered with 4 seconds to spare. Vault open.' },
        { label: 'B) Enter best guess with 20 seconds remaining',     score: 1,  feedback: 'Got it right. You\'ll take the luck.' },
        { label: 'C) Have crew buy more time outside',                score: 0,  feedback: 'Crew couldn\'t hold long enough. Time ran out.' },
        { label: 'D) Try the backup code from the leaked intel',      score: -1, feedback: 'Backup code was a honeypot. Alarm triggered instantly.' },
      ]
    },
  ],
};

const GETAWAY_SCENARIOS = {
  easy: [
    { situation: '\ud83d\ude93 A police cruiser just turned onto your street.',
      choices: [
        { label: 'A) Cut through the alley',                      score: 2,  feedback: 'Back streets were clear. Clean escape.' },
        { label: 'B) Stay on main road and act casual',           score: 1,  feedback: 'Drove right past. Nerve-wracking but fine.' },
        { label: 'C) Double back to the target building',         score: -1, feedback: 'Walked back into the scene. Caught.' },
      ]
    },
    { situation: '\ud83d\udd26 A flashlight beam is sweeping toward your position.',
      choices: [
        { label: 'A) Drop behind the nearest cover immediately',  score: 2, feedback: 'Beam passed directly over where you were standing.' },
        { label: 'B) Sprint to the corner before it reaches you', score: 1, feedback: 'Made it to cover. That was close.' },
        { label: 'C) Freeze and hope they don\'t look directly',  score: 0, feedback: 'They scanned right past you. Just barely.' },
      ]
    },
    { situation: '\ud83d\udc15 A guard dog starts barking in your direction.',
      choices: [
        { label: 'A) Throw a distraction in the opposite direction', score: 2, feedback: 'Dog chased the decoy. Textbook.' },
        { label: 'B) Stay completely still until it stops',          score: 1, feedback: 'Dog lost interest after a long minute.' },
        { label: 'C) Run for it now',                               score: 0, feedback: 'Dog gave chase but couldn\'t keep up. Drew attention.' },
      ]
    },
    { situation: '\ud83d\udea7 Construction has blocked your planned exit route.',
      choices: [
        { label: 'A) Take the back river path',                  score: 2, feedback: 'River path completely clear. Smooth exit.' },
        { label: 'B) Wait for a gap in traffic on the main road', score: 1, feedback: 'Waited 3 minutes. Got through clean.' },
        { label: 'C) Push through the construction site',        score: 0, feedback: 'Workers spotted you but didn\'t call it in.' },
      ]
    },
  ],
  medium: [
    { situation: '\ud83d\ude93 Police scanner active. Two patrol routes converging on your area.',
      choices: [
        { label: 'A) Storm drain route',                              score: 2,  feedback: 'Storm drain bypassed both patrols. Vanished.' },
        { label: 'B) Rooftop crossing',                               score: 1,  feedback: 'Patrols passed below. Made it across.' },
        { label: 'C) Highway on-ramp',                                score: -1, feedback: 'Highway checkpoint. Plates flagged.' },
        { label: 'D) Double back through warehouse district',         score: 0,  feedback: 'Secondary patrol there. Narrow escape.' },
      ]
    },
    { situation: '\ud83d\ude81 A helicopter spotlight is sweeping the block.',
      choices: [
        { label: 'A) Underground parking garage',               score: 2,  feedback: 'Spotlight can\'t reach underground. Disappeared.' },
        { label: 'B) Keep moving using building shadows',       score: 1,  feedback: 'Stayed ahead of the beam. Made it.' },
        { label: 'C) Abandon vehicle and go on foot',           score: 0,  feedback: 'On foot was slow but undetected.' },
        { label: 'D) Head to the crowded city center',          score: -1, feedback: 'More eyes in the city center. Got IDed.' },
      ]
    },
    { situation: '\ud83d\udea8 Undercover unit spotted the crew. Radio call went out.',
      choices: [
        { label: 'A) Split up \u2014 meet at the secondary point', score: 2, feedback: 'Splitting made you impossible to track. All clear.' },
        { label: 'B) Switch vehicles at the parking structure',  score: 1, feedback: 'Clean swap. Officers followed the wrong car.' },
        { label: 'C) Take the industrial back roads',            score: 1, feedback: 'Long way round but the roads were empty.' },
        { label: 'D) Stick together and push for the main exit', score: 0, feedback: 'Backup was waiting. Barely slipped through.' },
      ]
    },
  ],
  hard: [
    { situation: '\ud83d\ude93 Full lockdown. Roadblock on main route, helicopter overhead, K9 units sweeping.',
      choices: [
        { label: 'A) Storm Drain (on foot)',          score: 2,  feedback: 'Storm drain was off all patrol routes. Clean vanish.' },
        { label: 'B) Freeway at speed',              score: -1, feedback: 'Roadblock caught every vehicle. Arrested.' },
        { label: 'C) Industrial Park back roads',    score: 1,  feedback: 'Industrial park mostly clear. Made it.' },
        { label: 'D) Warehouse District',            score: 0,  feedback: 'K9 picked up a scent. Handler was slow. Barely got out.' },
        { label: 'E) River Route by boat',           score: 0,  feedback: 'Boat patrols active. Stopped, talked your way out.' },
      ]
    },
    { situation: '\ud83d\ude81 Three tactical units responding. Every major route monitored.',
      choices: [
        { label: 'A) Commuter rail tunnel on foot',                  score: 2,  feedback: 'Tunnel not on any patrol route. Clean escape.' },
        { label: 'B) Disguised as food delivery on main street',     score: 1,  feedback: 'Nervous stop. Badge check was light. Released.' },
        { label: 'C) Steal a vehicle and outrun them',               score: -1, feedback: 'Chase ended in a crash. Everyone arrested.' },
        { label: 'D) Hide in place until the lockdown lifts',        score: 0,  feedback: 'Three hours in hiding. Slipped out when patrols thinned.' },
        { label: 'E) Emergency services route with stolen uniforms', score: 1,  feedback: 'Light ID check. Uniforms held up. Made it through.' },
      ]
    },
    { situation: '\ud83d\udea8 An undercover officer is following your getaway vehicle.',
      choices: [
        { label: 'A) Lead them on a chase to lose them',          score: -1, feedback: 'Chase attracted backup. Swarmed within 3 minutes.' },
        { label: 'B) Pull into a parking garage, abandon vehicle', score: 2,  feedback: 'Officer lost you in the garage. Split up on foot.' },
        { label: 'C) Swap vehicles at the predetermined drop point', score: 2, feedback: 'Officer followed the wrong car for 12 minutes. Gone.' },
        { label: 'D) Drive normally and hope they break off',     score: 0,  feedback: 'They called backup first. Barely lost the tail.' },
        { label: 'E) Speed for the county line',                  score: -1, feedback: 'State troopers radioed ahead. Roadblock waiting.' },
      ]
    },
  ],
};

const LOOKOUT_EMOJI_POOL = ['\ud83d\ude93','\ud83d\udcb0','\ud83d\udd27','\ud83c\udfad','\ud83d\ude97','\ud83d\udcbc','\ud83e\udde8','\ud83d\udd12','\ud83d\udea8','\ud83d\udc6e','\ud83d\uddf3\ufe0f','\ud83d\udcf1','\ud83d\udd26','\u231a','\ud83d\udc5c','\ud83c\udfaf','\ud83e\uddf2','\ud83d\udcf7','\ud83d\udd10','\ud83c\udfb2','\ud83d\uddc3\ufe0f','\ud83d\udcdf','\ud83d\udd11','\ud83c\udf92','\ud83d\udd75\ufe0f'];
const LOOKOUT_CONFIG = {
  easy:   { count: 4, viewMs: 6000, type: 'position' },
  medium: { count: 6, viewMs: 5000, type: 'position' },
  hard:   { count: 8, viewMs: 4000, type: 'missing'  },
};

const DISTRACTION_PHRASES = {
  easy:   ['COFFEE', 'FIRE EXIT', 'MOVE OUT', 'CODE RED', 'STAY DOWN', 'CLEAR OUT'],
  medium: ['FIRE ALARM', 'CLEAR THE AREA', 'LOCK IT DOWN', 'SECURITY CHECK', 'STAND BACK NOW'],
  hard:   ['SECURITY BREACH IN PROGRESS', 'ALL UNITS RESPOND IMMEDIATELY', 'EMERGENCY EVACUATION REQUIRED', 'CONTAINMENT PROTOCOL ACTIVATED'],
};
const DISTRACTION_TIMERS = { easy: 28, medium: 20, hard: 14 };

const DRILLER_CONFIG = {
  easy:   { barWidth: 21, targetStart: 8,  targetEnd: 12, period: 4200, updateMs: 1400, timeLimit: 16 },
  medium: { barWidth: 21, targetStart: 9,  targetEnd: 11, period: 3600, updateMs: 1300, timeLimit: 14 },
  hard:   { barWidth: 21, targetStart: 10, targetEnd: 11, period: 3000, updateMs: 1200, timeLimit: 12 },
};

function calcDrillerPos(elapsedMs, periodMs, barWidth) {
  const t = (elapsedMs % periodMs) / periodMs;
  const bounce = t < 0.5 ? t * 2 : (1 - t) * 2;
  return Math.round(bounce * (barWidth - 1));
}

function renderDrillerBar(pos, tStart, tEnd, barWidth) {
  let out = '';
  for (let i = 0; i < barWidth; i++) {
    if (i === pos && i >= tStart && i <= tEnd) out += '\u2605'; // ★ in zone
    else if (i === pos) out += '\u25cf';  // ● indicator
    else if (i >= tStart && i <= tEnd) out += '\u2593'; // ▓ target
    else out += '\u2591'; // ░ empty
  }
  return '\x60|' + out + '|\x60';
}

function scoreDrillerShot(pos, tStart, tEnd) {
  if (pos >= tStart && pos <= tEnd) return 2;
  const dist = pos < tStart ? tStart - pos : pos - tEnd;
  if (dist <= 2) return 1;
  if (dist <= 5) return 0;
  return -1;
}

// ── Challenge runners ─────────────────────────────────────────────────────────

async function runMastermindChallenge(member, heistId, difficulty, channel) {
  return new Promise(async (resolve) => {
    const pool = MASTERMIND_SCENARIOS[difficulty];
    const scenario = pool[Math.floor(Math.random() * pool.length)];
    const timeLimit = { easy: 30, medium: 22, hard: 15 }[difficulty];
    const buttons = scenario.choices.map((c, i) =>
      new ButtonBuilder()
        .setCustomId(`hc_mm.${heistId}.${member.id}.${i}`)
        .setLabel(c.label.length > 80 ? c.label.slice(0, 79) + '\u2026' : c.label)
        .setStyle(ButtonStyle.Primary)
    );
    const rows = [];
    for (let i = 0; i < buttons.length; i += 3)
      rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 3)));
    const embed = new EmbedBuilder()
      .setColor('#c9a84c').setTitle('\ud83d\udcbc MASTERMIND CHALLENGE')
      .setDescription(`<@${member.id}> \u2014 **${timeLimit}s** to make the call!\n\n> **${scenario.situation}**`)
      .setFooter({ text: 'Choose wisely \u2014 your crew is counting on you.' });
    const msg = await channel.send({ embeds: [embed], components: rows });
    const state = heistChallengeState.get(heistId);
    if (!state) { resolve(0); return; }
    const timer = setTimeout(async () => {
      if (!heistChallengeState.get(heistId)?.challenges.has(member.id)) return;
      heistChallengeState.get(heistId)?.challenges.delete(member.id);
      await msg.edit({ embeds: [new EmbedBuilder().setColor('#888888').setTitle('\ud83d\udcbc MASTERMIND \u2014 TIME\'S UP').setDescription(`<@${member.id}> didn't respond in time.\n\n\u274c **0 pts** \u2014 Failed`)], components: [] }).catch(() => {});
      resolve(0);
    }, timeLimit * 1000);
    state.challenges.set(member.id, { role: 'mastermind', resolve, timer, msg, data: { scenario } });
  });
}

async function runDrillerChallenge(member, heistId, difficulty, channel) {
  return new Promise(async (resolve) => {
    const cfg = DRILLER_CONFIG[difficulty];
    const startTime = Date.now();
    const drillBtn = new ButtonBuilder()
      .setCustomId(`hc_drill.${heistId}.${member.id}`)
      .setLabel('\ud83d\udd27 DRILL!')
      .setStyle(ButtonStyle.Danger);
    const row = new ActionRowBuilder().addComponents(drillBtn);
    const buildEmbed = (pos, remaining) => new EmbedBuilder()
      .setColor('#c9a84c').setTitle('\ud83d\udd27 DRILLER CHALLENGE')
      .setDescription(
        `<@${member.id}> \u2014 Stop the indicator inside the target zone!\n\n` +
        `${renderDrillerBar(pos, cfg.targetStart, cfg.targetEnd, cfg.barWidth)}\n` +
        `*\u25cf = indicator \u2503 \u2593\u2593\u2593 = target zone \u2503 \u2605 = in zone!*\n\n` +
        `\u23f1\ufe0f **${remaining}s remaining**`
      )
      .setFooter({ text: 'Press DRILL! when \u25cf is inside the \u2593\u2593\u2593 zone.' });
    const initPos = calcDrillerPos(0, cfg.period, cfg.barWidth);
    const msg = await channel.send({ embeds: [buildEmbed(initPos, cfg.timeLimit)], components: [row] });
    const state = heistChallengeState.get(heistId);
    if (!state) { resolve(0); return; }
    const interval = setInterval(async () => {
      if (!heistChallengeState.get(heistId)?.challenges.has(member.id)) { clearInterval(interval); return; }
      const elapsed = Date.now() - startTime;
      const remaining = Math.max(0, Math.ceil((cfg.timeLimit * 1000 - elapsed) / 1000));
      const pos = calcDrillerPos(elapsed, cfg.period, cfg.barWidth);
      await msg.edit({ embeds: [buildEmbed(pos, remaining)], components: [row] }).catch(() => {});
    }, cfg.updateMs);
    const timer = setTimeout(async () => {
      clearInterval(interval);
      if (!heistChallengeState.get(heistId)?.challenges.has(member.id)) return;
      heistChallengeState.get(heistId)?.challenges.delete(member.id);
      await msg.edit({ embeds: [new EmbedBuilder().setColor('#888888').setTitle('\ud83d\udd27 DRILLER \u2014 TIME\'S UP').setDescription(`<@${member.id}> missed the window.\n\n\u274c **0 pts** \u2014 Failed`)], components: [] }).catch(() => {});
      resolve(0);
    }, cfg.timeLimit * 1000);
    state.challenges.set(member.id, { role: 'driller', resolve, timer, msg, data: { startTime, interval, cfg } });
  });
}

async function runLookoutChallenge(member, heistId, difficulty, channel) {
  return new Promise(async (resolve) => {
    const cfg = LOOKOUT_CONFIG[difficulty];
    const answerTimeLimitMs = 18000;
    const shuffled = [...LOOKOUT_EMOJI_POOL].sort(() => Math.random() - 0.5);
    const emojis = shuffled.slice(0, cfg.count);
    const showEmbed = new EmbedBuilder()
      .setColor('#c9a84c').setTitle('\ud83d\udc40 LOOKOUT CHALLENGE')
      .setDescription(`<@${member.id}> \u2014 **Memorize this sequence!**\n\n${emojis.join('  ')}\n\n*Disappears in ${Math.round(cfg.viewMs / 1000)} seconds...*`)
      .setFooter({ text: 'Watch carefully!' });
    const msg = await channel.send({ embeds: [showEmbed] });
    const state = heistChallengeState.get(heistId);
    if (!state) { resolve(0); return; }
    await new Promise(r => setTimeout(r, cfg.viewMs));
    if (!heistChallengeState.get(heistId)) { resolve(0); return; }
    let correctAnswer, questionText;
    if (cfg.type === 'position') {
      const posIdx = Math.floor(Math.random() * emojis.length);
      correctAnswer = emojis[posIdx];
      const wrong = shuffled.slice(cfg.count, cfg.count + 3);
      const choices = [correctAnswer, ...wrong].sort(() => Math.random() - 0.5);
      questionText = `Which emoji was in **position ${posIdx + 1}**?`;
      const buttons = choices.map(e => new ButtonBuilder()
        .setCustomId(`hc_look.${heistId}.${member.id}.${e === correctAnswer ? '1' : '0'}`)
        .setLabel(e).setStyle(ButtonStyle.Secondary));
      const row = new ActionRowBuilder().addComponents(buttons);
      const qEmbed = new EmbedBuilder().setColor('#4169E1').setTitle('\ud83d\udc40 LOOKOUT \u2014 IDENTIFY')
        .setDescription(`<@${member.id}>\n\n*[SEQUENCE HIDDEN]*\n\n**${questionText}**\n\n\u23f1\ufe0f **18s to answer**`)
        .setFooter({ text: 'What did you see?' });
      await msg.edit({ embeds: [qEmbed], components: [row] });
    } else {
      const missingIdx = Math.floor(Math.random() * emojis.length);
      correctAnswer = emojis[missingIdx];
      const remaining = emojis.filter((_, i) => i !== missingIdx);
      const wrong = shuffled.slice(cfg.count, cfg.count + 3);
      const choices = [correctAnswer, ...wrong].sort(() => Math.random() - 0.5);
      questionText = 'Which emoji **disappeared**?';
      const buttons = choices.map(e => new ButtonBuilder()
        .setCustomId(`hc_look.${heistId}.${member.id}.${e === correctAnswer ? '1' : '0'}`)
        .setLabel(e).setStyle(ButtonStyle.Secondary));
      const row = new ActionRowBuilder().addComponents(buttons);
      const qEmbed = new EmbedBuilder().setColor('#4169E1').setTitle('\ud83d\udc40 LOOKOUT \u2014 IDENTIFY')
        .setDescription(`<@${member.id}>\n\n*Remaining:* ${remaining.join('  ')}\n\n**${questionText}**\n\n\u23f1\ufe0f **18s to answer**`)
        .setFooter({ text: 'One emoji is missing from the original sequence.' });
      await msg.edit({ embeds: [qEmbed], components: [row] });
    }
    const timer = setTimeout(async () => {
      if (!heistChallengeState.get(heistId)?.challenges.has(member.id)) return;
      heistChallengeState.get(heistId)?.challenges.delete(member.id);
      await msg.edit({ embeds: [new EmbedBuilder().setColor('#888888').setTitle('\ud83d\udc40 LOOKOUT \u2014 TIME\'S UP').setDescription(`<@${member.id}> didn't identify the emoji in time.\n\n\u274c **0 pts** \u2014 Failed`)], components: [] }).catch(() => {});
      resolve(0);
    }, answerTimeLimitMs);
    state.challenges.set(member.id, { role: 'lookout', resolve, timer, msg, data: { correctAnswer } });
  });
}

async function runDistractionChallenge(member, heistId, difficulty, channel) {
  return new Promise(async (resolve) => {
    const pool = DISTRACTION_PHRASES[difficulty];
    const phrase = pool[Math.floor(Math.random() * pool.length)];
    const timeLimit = DISTRACTION_TIMERS[difficulty];
    const startTime = Date.now();
    const embed = new EmbedBuilder()
      .setColor('#c9a84c').setTitle('\ud83c\udfad DISTRACTION CHALLENGE')
      .setDescription(`<@${member.id}> \u2014 Type the following phrase in this channel!\n\n> **\u0060${phrase}\u0060**\n\n\u23f1\ufe0f **${timeLimit}s** \u00b7 Case-insensitive`)
      .setFooter({ text: 'Type it accurately and quickly!' });
    const msg = await channel.send({ embeds: [embed] });
    const state = heistChallengeState.get(heistId);
    if (!state) { resolve(0); return; }
    const distractKey = `${channel.id}.${member.id}`;
    const timer = setTimeout(async () => {
      heistDistractionListeners.delete(distractKey);
      if (!heistChallengeState.get(heistId)?.challenges.has(member.id)) return;
      heistChallengeState.get(heistId)?.challenges.delete(member.id);
      await msg.edit({ embeds: [new EmbedBuilder().setColor('#888888').setTitle('\ud83c\udfad DISTRACTION \u2014 TIME\'S UP').setDescription(`<@${member.id}> didn't type the phrase in time.\n\n\u274c **0 pts** \u2014 Failed`)] }).catch(() => {});
      resolve(0);
    }, timeLimit * 1000);
    state.challenges.set(member.id, { role: 'distraction', resolve, timer, msg, data: { phrase, startTime, timeLimit } });
    heistDistractionListeners.set(distractKey, {
      phrase,
      callback: async (typedMsg) => {
        clearTimeout(timer);
        heistChallengeState.get(heistId)?.challenges.delete(member.id);
        const elapsed = Date.now() - startTime;
        await typedMsg.delete().catch(() => {});
        const score = elapsed < timeLimit * 400 ? 2 : 1;
        const te = new EmbedBuilder().setColor(hcScoreColor(score)).setTitle('\ud83c\udfad DISTRACTION \u2014 COMPLETE')
          .setDescription(`<@${member.id}> typed: **\u0060${phrase}\u0060**\n\n${elapsed < timeLimit * 400 ? '\ud83d\udd25 Blazing fast!' : '\u2705 Got it!'}\n\n${hcScoreLabel(score)}`);
        await msg.edit({ embeds: [te] }).catch(() => {});
        resolve(score);
      }
    });
  });
}

async function runGetawayChallenge(member, heistId, difficulty, channel) {
  return new Promise(async (resolve) => {
    const pool = GETAWAY_SCENARIOS[difficulty];
    const scenario = pool[Math.floor(Math.random() * pool.length)];
    const timeLimit = { easy: 28, medium: 22, hard: 15 }[difficulty];
    const buttons = scenario.choices.map((c, i) =>
      new ButtonBuilder()
        .setCustomId(`hc_gw.${heistId}.${member.id}.${i}`)
        .setLabel(c.label.length > 80 ? c.label.slice(0, 79) + '\u2026' : c.label)
        .setStyle(ButtonStyle.Secondary)
    );
    const rows = [];
    for (let i = 0; i < buttons.length; i += 3)
      rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 3)));
    const embed = new EmbedBuilder()
      .setColor('#1E3A5F').setTitle('\ud83c\udfc3 GETAWAY CHALLENGE')
      .setDescription(`<@${member.id}> \u2014 **${timeLimit}s** to choose your escape route!\n\n> **${scenario.situation}**`)
      .setFooter({ text: 'One route is optimal. One is acceptable. Choose fast.' });
    const msg = await channel.send({ embeds: [embed], components: rows });
    const state = heistChallengeState.get(heistId);
    if (!state) { resolve(0); return; }
    const timer = setTimeout(async () => {
      if (!heistChallengeState.get(heistId)?.challenges.has(member.id)) return;
      heistChallengeState.get(heistId)?.challenges.delete(member.id);
      await msg.edit({ embeds: [new EmbedBuilder().setColor('#888888').setTitle('\ud83c\udfc3 GETAWAY \u2014 TIME\'S UP').setDescription(`<@${member.id}> couldn't decide on a route in time.\n\n\u274c **0 pts** \u2014 Failed`)], components: [] }).catch(() => {});
      resolve(0);
    }, timeLimit * 1000);
    state.challenges.set(member.id, { role: 'getaway', resolve, timer, msg, data: { scenario } });
  });
}

async function runRoleChallenge(member, heistId, difficulty, channel) {
  if (member.id.startsWith('0000')) { // test/fake crew members auto-succeed
    await new Promise(r => setTimeout(r, 1200));
    return 2;
  }
  const role = member.role || 'mastermind';
  if (role === 'mastermind')  return runMastermindChallenge(member, heistId, difficulty, channel);
  if (role === 'driller')     return runDrillerChallenge(member, heistId, difficulty, channel);
  if (role === 'lookout')     return runLookoutChallenge(member, heistId, difficulty, channel);
  if (role === 'distraction') return runDistractionChallenge(member, heistId, difficulty, channel);
  if (role === 'getaway')     return runGetawayChallenge(member, heistId, difficulty, channel);
  return 0;
}


async function cleanupHeistMessages(heistId) {
  const msgs = heistMessageMap.get(heistId) || [];
  await Promise.all(msgs.map(m => m.delete().catch(() => {})));
  heistMessageMap.delete(heistId);
}

async function executeHeist(heistId, channelArg) {
  const hData = activeHeists.get(heistId);
  if (!hData) return;
  const { heist, crew } = hData;
  const channel = hData.channel || channelArg || await client.channels.fetch(CONFIG.CHANNELS.GENERAL).catch(() => null);
  activeHeists.delete(heistId);
  heistTimers.delete(heistId);
  console.log(`[Heist] Executing: ${heist.name} with ${crew.length} crew members`);

  if (crew.length < 2) {
    crew.forEach(m => addBB(m.id, m.username, heist.entry, 'heist refund — not enough crew'));
    await channel.send(`🦹 **${heist.name}** was called off — not enough crew showed up. Entry fees refunded.`);
    return;
  }

  const difficulty  = getHeistDifficulty(heist.entry);
  const crewList    = crew.map(m => m.username).join(', ');
  const delay       = ms => new Promise(res => setTimeout(res, ms));

  // ── Leader briefing ───────────────────────────────────────────────────────────────────────────
  const leaderMember = crew[0];
  const leaderRole   = HEIST_ROLES[leaderMember.role] || HEIST_ROLES['mastermind'];
  const LEADER_BRIEFINGS = {
    'The Paint Heist': [
      `*"Alright listen up. Bully's color palette — the unreleased one, not the one she uses on stream — is sitting in the studio right now with zero security. I've clocked the window. We have maybe 12 minutes before anyone notices anything is off. ${leaderRole.emoji} I need everyone doing exactly what we planned. No improvising. Let's move."* — **${leaderMember.username}**`,
      `*"I've been watching this place for two weeks. Bully keeps the palette locked in the supply room during streams because she doesn't want anyone copying her colorwork. Tonight there's no stream. The room is unlocked. ${leaderRole.emoji} This is the job. In, grab it, out. Nobody panic."* — **${leaderMember.username}**`,
      `*"You think this is just about some paint? Nah. That palette is worth more in information than anything in this building. Every color she's working with for the next drop is in there. ${leaderRole.emoji} We take it, we know the next move before she makes it. Let's go."* — **${leaderMember.username}**`,
      `*"Short version: studio window is unlocked on the east side, security walks past every 8 minutes, and the palette is on the second shelf. ${leaderRole.emoji} I timed this down to the second. If we move clean we're out in six minutes. Everybody breathe. This is the easy one."* — **${leaderMember.username}**`,
      `*"I know some of you think this job is small. You're wrong. Bully's been building to something big and that palette tells us everything. ${leaderRole.emoji} We get it, we're a step ahead. Trust me. Trust each other. Let's make it clean."* — **${leaderMember.username}**`,
    ],
    'The Drip Raid': [
      `*"The new drop is sitting in the back of the warehouse right now. Tagged, boxed, and ready to ship — except it's not shipping tonight. ${leaderRole.emoji} The loading dock crew clocks out at 10. That gives us a window. I know the layout. We go in through the side entrance, grab what we need, and disappear before anyone even runs a count."* — **${leaderMember.username}**`,
      `*"Bully's Apparel just got a shipment of the new drop three days before the public release. That's not a coincidence — that's an opportunity. ${leaderRole.emoji} I've done the math. Two cameras, one guard, zero backup for the next 40 minutes. We move now, we're wearing the drop before it even drops."* — **${leaderMember.username}**`,
      `*"You want to know what's in that warehouse? The piece everyone's going to be hunting for next week. ${leaderRole.emoji} We can either wait in line like everyone else or we can walk out with it tonight. I'm not the waiting-in-line type. You in?"* — **${leaderMember.username}**`,
      `*"I pulled the warehouse layout from a contact. Loading dock is unwatched from 10:15 to 10:45. That's our window. ${leaderRole.emoji} The new drop is crated and labeled — we're not guessing, we know exactly what shelf it's on. Thirty minutes in and out. Let's not overthink this."* — **${leaderMember.username}**`,
      `*"Here's the thing about Bully's Apparel — they're so focused on the launch that security on the pre-stock is basically an afterthought. ${leaderRole.emoji} I've run three jobs like this. Clean entry, quick grab, clean exit. The only way it goes wrong is if someone freezes. Don't freeze."* — **${leaderMember.username}**`,
    ],
    "Bully's Kitchen": [
      `*"I know what you're thinking. It's a kitchen. How hard can it be. ${leaderRole.emoji} Let me stop you right there. Bully's kitchen is the most locked-down room in the whole building — she runs a tight operation in there and people have tried to get in before. None of them made it. We're doing this differently. I've got the layout, I've got the timing, and I've got an exit strategy. All I need is the crew."* — **${leaderMember.username}**`,
      `*"There's a plate in that kitchen that doesn't exist anywhere else. Made fresh, eaten same day, never photographed, never shared. ${leaderRole.emoji} We get in, we get a plate, we get out. Simple concept. The execution is where it gets interesting. Stick to your roles and we eat like royalty tonight."* — **${leaderMember.username}**`,
      `*"Every single person who's ever tried to get into Bully's kitchen uninvited has been caught. ${leaderRole.emoji} We are not every single person. I've mapped the blind spots on every camera. I know which door doesn't lock from the inside. I know when the kitchen is empty. Tonight we're the exception."* — **${leaderMember.username}**`,
      `*"The plate we're going after isn't even listed on any menu. It's something Bully makes when she's in a creative mood — limited run, never repeated. ${leaderRole.emoji} You want to tell your friends you had it? Then we go in tonight. I've rehearsed this twice. I'm not going in without the right crew."* — **${leaderMember.username}**`,
      `*"Two things I know for certain. One — nobody gets into Bully's kitchen. Two — we're about to be the exception. ${leaderRole.emoji} I'm not going to lie to you and say it's risk-free. It's not. But I've done the prep work and I believe in this crew. So here's what we're doing."* — **${leaderMember.username}**`,
    ],
    'The Canvas Caper': [
      `*"The painting is called 'No Cap, No Color.' It's the most expensive piece Bully's ever made and it's hanging on a wall right now with two guards, one motion sensor, and a very predictable shift rotation. ${leaderRole.emoji} I've been studying this for three weeks. I know when the sensor resets, I know when the guards switch, and I know which wall mount releases without triggering an alarm. Tonight we take it."* — **${leaderMember.username}**`,
      `*"Every collector in BULLYLAND has tried to get their hands on this piece through legitimate channels. Nobody's succeeded. ${leaderRole.emoji} We're not going through legitimate channels. I have the specs, I have the route, and I have this crew. The painting comes with us tonight or we don't come back at all."* — **${leaderMember.username}**`,
      `*"I want to be clear about what we're walking into. This isn't a smash-and-grab. This is a precision operation. ${leaderRole.emoji} The painting has to come off the wall clean — no damage, no alarm, no witnesses. That means everyone plays their role perfectly. I'm not exaggerating when I say the margin for error is basically zero."* — **${leaderMember.username}**`,
      `*"Bully doesn't know it yet but this painting is moving tonight. ${leaderRole.emoji} I've done the reconnaissance. Three visits to that gallery in the last month, all legitimate, all to clock the security patterns. I know this building better than the people who work in it. Trust the plan."* — **${leaderMember.username}**`,
      `*"The painting is worth more than anything else in this building combined. Which means security thinks they have it covered. ${leaderRole.emoji} They don't account for a crew like this. I've found the gap in their rotation — four minutes where nobody is watching that wall. Four minutes is all we need."* — **${leaderMember.username}**`,
    ],
    'The Fourthwall Hack': [
      `*"The shipment is on a truck right now. Six boxes, labeled as standard inventory, headed to the fulfillment center. ${leaderRole.emoji} What's inside those boxes is not standard inventory. I have the manifest, I have the route, and I have a 22-minute window between the warehouse exit and the first checkpoint. We intercept it there."* — **${leaderMember.username}**`,
      `*"Bully's Apparel uses the same route for every high-value shipment. I'm not judging — consistency is a virtue. ${leaderRole.emoji} Unless someone's been watching that route for six weeks and knows exactly where the blind spots are. Which I have. Which I do. Here's the plan."* — **${leaderMember.username}**`,
      `*"We're not stopping a truck. That's not what this is. ${leaderRole.emoji} This is a precision intercept — we redirect the shipment before it ever reaches the checkpoint. I have a contact at the logistics hub who's already moved the paperwork. By the time anyone notices the package is missing, we're long gone."* — **${leaderMember.username}**`,
      `*"Every luxury drop Bully ships goes through the same three hands before it reaches the customer. I've compromised one of those hands. ${leaderRole.emoji} That means we don't need to get within 100 feet of the truck. We just need to be in the right place when the handoff happens. Which is in 40 minutes. Move."* — **${leaderMember.username}**`,
      `*"The Fourthwall shipment is the most valuable thing moving through this city tonight. ${leaderRole.emoji} It's also guarded by people who have never once considered that someone like us would be watching. Complacency is the best security flaw there is. We exploit it tonight."* — **${leaderMember.username}**`,
    ],
    'The Bully Bucks Vault': [
      `*"I'm not going to pretend this is a normal job. The BULLYLAND treasury is the most secure room in the entire operation. ${leaderRole.emoji} Six-digit code, biometric backup, and a cooldown between attempts. I know all of that. I also know that the backup system has a 90-second lag during the hourly sync. That's our window. It's small. It's real. And we're taking it."* — **${leaderMember.username}**`,
      `*"Let me be straight with you. Three crews have tried to hit the Bully Bucks Vault before us. ${leaderRole.emoji} All three walked away with nothing. I know what they did wrong. I know because I talked to two of them. We're not making those mistakes. This crew is different and this plan is different. Tonight we make history."* — **${leaderMember.username}**`,
      `*"The vault holds every Bully Buck reserve in the BULLYLAND economy. We're not just talking about a big payday. ${leaderRole.emoji} We're talking about a complete shift in the power structure of this server. If we pull this off, every person in this crew goes from player to powerhouse. That's what's on the table. So nobody flinches."* — **${leaderMember.username}**`,
      `*"I spent four months mapping this vault. Four months of watching, waiting, and learning every pattern. ${leaderRole.emoji} I know the guard rotation, I know the code algorithm, and I know the one moment every night when every layer of security is transitioning at the same time. That moment is in 18 minutes. Get ready."* — **${leaderMember.username}**`,
      `*"This is the job everybody in BULLYLAND talks about and nobody has ever done. ${leaderRole.emoji} Tonight that changes. I need you sharp, I need you trusting each other, and I need you executing exactly what we planned. No hesitation. No deviation. We go in, we take everything, and we walk out like we own the place."* — **${leaderMember.username}**`,
    ],
  };
  const briefingOptions = LEADER_BRIEFINGS[heist.name] || [
    `*"You know the job. You know your role. ${leaderRole.emoji} Let's get this done."* — **${leaderMember.username}**`
  ];
  const briefingText = briefingOptions[Math.floor(Math.random() * briefingOptions.length)];
  const briefingEmbed = new EmbedBuilder().setColor('#FF4500')
    .setTitle(`🦹 ${leaderMember.username} addresses the crew`)
    .setDescription(briefingText)
    .setFooter({ text: "Bully's World • The job begins." }).setTimestamp();
  const briefMsg = await channel.send({ embeds: [briefingEmbed] });
  await delay(3500);

  // ── Challenge phase announcement ─────────────────────────────────────────────────────────────────
  const challengeEmbed = new EmbedBuilder()
    .setColor('#FF6B00')
    .setTitle(`🦹 ${heist.name} — CHALLENGE PHASE`)
    .setDescription(
      'Each crew member must complete their role challenge simultaneously.\n' +
      'Perform well \u2014 the crew\'s payout depends on everyone\'s combined score.\n\n' +
      crew.map(m => `${HEIST_ROLES[m.role]?.emoji || '🦹'} **${m.username}** — ${HEIST_ROLES[m.role]?.label || 'Mastermind'}`).join('\n') +
      `\n\n⚡ **Difficulty: ${difficulty.toUpperCase()}** | Challenges start now!`
    )
    .setFooter({ text: 'Complete your challenge before time runs out!' });
  await channel.send({ embeds: [challengeEmbed] });
  await delay(1200);

  // ── Initialize challenge state ────────────────────────────────────────────────────────────────────────
  heistChallengeState.set(heistId, { channel, heist, crew, difficulty, challenges: new Map() });

  // ── Run all role challenges in parallel ───────────────────────────────────────────────────────────
  const scoreResults = await Promise.all(crew.map(m => runRoleChallenge(m, heistId, difficulty, channel)));
  heistChallengeState.delete(heistId);

  const totalScore = scoreResults.reduce((a, b) => a + b, 0);
  const tier        = getOutcomeTier(totalScore, crew.length);
  const maxScore    = crew.length * 2;

  // ── Score breakdown ──────────────────────────────────────────────────────────────────────────────────
  const scoreLines = crew.map((m, i) => {
    const s = scoreResults[i];
    const tag = s >= 2 ? '+2 ✅' : s === 1 ? '+1 ⚠️' : s === 0 ? '0 ❌' : '−1 💥';
    return `${HEIST_ROLES[m.role]?.emoji || '🦹'} **${m.username}** (${HEIST_ROLES[m.role]?.label || '?'})— ${tag}`;
  }).join('\n');

  await delay(1500);

  // ── Outcome ─────────────────────────────────────────────────────────────────────────────────────────
  let embedColor, embedTitle, payoutLine;
  const completedIndex = HEISTS.findIndex(h => h.name === heist.name);

  if (tier === 'major') {
    const share = Math.floor(heist.payout * 2.5 / crew.length);
    crew.forEach(m => addBB(m.id, m.username, share, `heist win — ${heist.name}`));
    if (completedIndex >= 0 && crew[0]) db.prepare('INSERT OR IGNORE INTO heist_completions (user_id, heist_index) VALUES (?, ?)').run(crew[0].id, completedIndex);
    embedColor = '#FFD700'; embedTitle = `🏆 MAJOR SUCCESS — ${heist.name}`;
    payoutLine = `The crew executed **flawlessly**.\n\n**Payout: ${share.toLocaleString()} BB each** \u2014 ${(heist.payout * 2.5).toLocaleString()} BB total (2.5x)`;
  } else if (tier === 'success') {
    const share = Math.floor(heist.payout * 1.5 / crew.length);
    crew.forEach(m => addBB(m.id, m.username, share, `heist win — ${heist.name}`));
    if (completedIndex >= 0 && crew[0]) db.prepare('INSERT OR IGNORE INTO heist_completions (user_id, heist_index) VALUES (?, ?)').run(crew[0].id, completedIndex);
    embedColor = '#3B6D11'; embedTitle = `\u2705 SUCCESS — ${heist.name}`;
    payoutLine = `The crew pulled it off.\n\n**Payout: ${share.toLocaleString()} BB each** \u2014 ${(heist.payout * 1.5).toLocaleString()} BB total (1.5x)`;
  } else if (tier === 'partial') {
    const share = Math.floor(heist.payout * 0.5 / crew.length);
    crew.forEach(m => { if (share > 0) addBB(m.id, m.username, share, `heist partial — ${heist.name}`); });
    embedColor = '#FFA500'; embedTitle = `\u26a0\ufe0f PARTIAL SUCCESS — ${heist.name}`;
    payoutLine = `The crew got something, but not everything.\n\n**Partial payout: ${share.toLocaleString()} BB each**${share < heist.entry ? '\n*(Entry fees not fully recovered)*' : ''}`;
  } else if (tier === 'arrest') {
    embedColor = '#8B0000'; embedTitle = `\ud83d\udea8 ARRESTED — ${heist.name}`;
    payoutLine = `Critical failures cost the crew everything. Everyone was caught.\n\n**Entry fees lost: ${heist.entry} BB each**`;
  } else {
    embedColor = '#4a4a4a'; embedTitle = `\u274c HEIST FAILED — ${heist.name}`;
    payoutLine = `The crew couldn't pull it off.\n\n**Entry fees lost: ${heist.entry} BB each**`;
  }

  await cleanupHeistMessages(heistId);
  await briefMsg.delete().catch(() => {});

  const resultEmbed = new EmbedBuilder()
    .setColor(embedColor)
    .setTitle(embedTitle)
    .setDescription(`${payoutLine}\n\n**${heist.description}**`)
    .addFields(
      { name: '\ud83d\udcca Crew Score Breakdown', value: `${scoreLines}\n\n**Total: ${totalScore} / ${maxScore} pts**` },
      { name: '\ud83d\udc65 Crew', value: crewList }
    )
    .setFooter({ text: `Difficulty: ${difficulty} \u2022 Bully's World` })
    .setTimestamp();
  await channel.send({ embeds: [resultEmbed] });
}


// ─── MESSAGE HANDLER ───────────────────────────────────────────────────────
client.on('messageCreate', async(message) => {
  if (message.author.bot || !message.guild) return;

  // ── Daily Questionnaire ──────────────────────────────────────────────────
  await dailyQ.handleMessage(message).catch(() => {});
  const _dqHandled = await dailyQ.handleAdminCommand(message).catch(() => false);
  if (_dqHandled) return;
  // ────────────────────────────────────────────────────────────────────────

  // ── Testing mode gate ──
  if (TESTING_MODE && !hasAccess(message.member)) return;

  const userId = message.author.id, username = message.author.username;
  const content = message.content.trim().toLowerCase();

  // ── Heist distraction challenge ──────────────────────────────────────────────────────────────────
  const _dKey = `${message.channelId}.${message.author.id}`;
  if (heistDistractionListeners.has(_dKey)) {
    const _dl = heistDistractionListeners.get(_dKey);
    if (message.content.trim().toUpperCase() === _dl.phrase.toUpperCase()) {
      heistDistractionListeners.delete(_dKey);
      await _dl.callback(message);
      return;
    }
  }

  // ── Channel gate — restrict commands to designated channels ──
  const _isAdmin = message.member?.permissions.has(PermissionsBitField.Flags.Administrator);
  if (content.startsWith('!') && !_isAdmin) {
    const cid = message.channelId;
    const inGameChannel = cid === CONFIG.CHANNELS.GAMES || cid === CONFIG.CHANNELS.GAMES_2;
    const inLobby = cid === CONFIG.CHANNELS.GENERAL;
    const inMysteryDrops = cid === CONFIG.CHANNELS.MYSTERY_DROPS;
    if (inGameChannel) {
      // all commands allowed
    } else if (inLobby) {
      const cmd = content.split(' ')[0];
      if (!['!help', '!feedback', '!checkin'].includes(cmd)) {
        const r = await message.reply(`🎮 Head to <#${CONFIG.CHANNELS.GAMES}> or <#${CONFIG.CHANNELS.GAMES_2}> to use bot commands.`);
        setTimeout(() => r.delete().catch(() => {}), 5000);
        await message.delete().catch(() => {});
        return;
      }
    } else if (inMysteryDrops) {
      // pass through — !claim handles its own channel check
    } else {
      const r = await message.reply(`🎮 Head to <#${CONFIG.CHANNELS.GAMES}> or <#${CONFIG.CHANNELS.GAMES_2}> to use bot commands.`);
      setTimeout(() => r.delete().catch(() => {}), 5000);
      await message.delete().catch(() => {});
      return;
    }
  }

  // Passive BB
  const user = getUser(userId, username);
  const lastMsg = user.last_message ? new Date(user.last_message).getTime() : 0;
  if (Date.now() - lastMsg > CONFIG.MESSAGE_COOLDOWN_MS) {
    const jailRow = getJail(userId);
    const msgReward = jailRow ? Math.max(1, Math.floor(CONFIG.MESSAGE_BB * 0.40)) : CONFIG.MESSAGE_BB;
    addBB(userId, username, msgReward, jailRow ? 'message (jailed — 60% cut)' : 'message');
    db.prepare('UPDATE balances SET last_message = CURRENT_TIMESTAMP WHERE user_id = ?').run(userId);
  }

  // ── !checkin ──
  if (content === '!checkin') {
    if (message.channelId !== CONFIG.CHANNELS.CHECKIN) { const r = await message.reply(`Check-ins only count in <#${CONFIG.CHANNELS.CHECKIN}>.`); setTimeout(()=>r.delete().catch(()=>{}),5000); return; }
    if (!activeCheckin || activeCheckin.expired || Date.now() > activeCheckin.expiresAt) { const r = await message.reply('No active check-in right now. Stay on your notifications.'); setTimeout(()=>r.delete().catch(()=>{}),5000); await message.delete().catch(()=>{}); return; }
    if (activeCheckin.claimedUsers.has(userId)) { const r = await message.reply('You already checked in today!'); setTimeout(()=>r.delete().catch(()=>{}),5000); await message.delete().catch(()=>{}); return; }
    activeCheckin.claimedUsers.add(userId);
    await message.delete().catch(()=>{});
    const u = getUser(userId, username);
    const lastCI = u.last_checkin ? new Date(u.last_checkin).toISOString().slice(0,10) : null;
    const today = new Date().toISOString().slice(0,10);
    const yesterday = new Date(Date.now()-86400000).toISOString().slice(0,10);
    const newStreak = lastCI === yesterday ? (u.streak||0)+1 : 1;
    const baseReward = getStreakReward(newStreak);
    const jailRowCI = getJail(userId);
    const reward = jailRowCI ? Math.max(1, Math.floor(baseReward * 0.40)) : baseReward;
    addBB(userId, username, reward, jailRowCI ? `daily check-in (streak: ${newStreak}, jailed — 60% cut)` : `daily check-in (streak: ${newStreak})`);
    db.prepare('UPDATE balances SET streak = ?, last_checkin = ? WHERE user_id = ?').run(newStreak, today, userId);
    try {
      const jailNote = jailRowCI
        ? `\n⛓️ **Jailed** — earnings reduced 60%. Use \`!jail\` to check your status or pay bail.`
        : (newStreak >= 7 ? 'Your streak doubled your reward. Keep going.' : 'Hit a 7-day streak to double your daily reward.');
      const dmEmbed = new EmbedBuilder().setColor(jailRowCI ? '#8B0000' : '#c9a84c').setTitle('Check-in claimed!')
        .setDescription(`You got **${reward} BB**.\nStreak: **${newStreak} day${newStreak!==1?'s':''}**\n\n${jailNote}`)
        .setFooter({text:"Bully's World • Show up every day."}).setTimestamp();
      await message.author.send({ embeds: [dmEmbed] });
    } catch {}
    return;
  }

  // ── !claim ──
  if (content === '!claim') {
    if (message.channelId !== CONFIG.CHANNELS.MYSTERY_DROPS) return;
    if (!activeDrop || activeDrop.claimed || Date.now() > activeDrop.expiresAt) { const r = await message.reply('No active drop right now.'); setTimeout(()=>r.delete().catch(()=>{}),4000); await message.delete().catch(()=>{}); return; }
    activeDrop.claimed = true;
    const tier = activeDrop.tier;
    await message.delete().catch(()=>{});
    const isFreeGarment = tier.label === 'FREE GARMENT';
    const code = !isFreeGarment && tier.tierKey ? pickUniqueCode(tier.tierKey, userId) : null;
    try {
      const dmEmbed = new EmbedBuilder().setColor(isFreeGarment?'#8B0000':'#c9a84c')
        .setTitle(isFreeGarment?'FREE GARMENT — You got it.':`${tier.label} — You got it.`)
        .setDescription(isFreeGarment?`You claimed a free garment. DM the server admin within 24 hours.\n\nShop: ${CONFIG.SHOP_URL}`:`Your code: \`${code}\`\nShop: ${CONFIG.SHOP_URL}\n\nThis code is yours. Don't share it.`)
        .setFooter({text:"Bully's Apparel • You showed up first."}).setTimestamp();
      await message.author.send({ embeds: [dmEmbed] });
    } catch { const n = await message.channel.send(`<@${userId}> — you claimed it but I couldn't DM you. Open your DMs.`); setTimeout(()=>n.delete().catch(()=>{}),8000); }
    const dch = await client.channels.fetch(CONFIG.CHANNELS.MYSTERY_DROPS).catch(()=>null);
    const orig = dch ? await dch.messages.fetch(activeDrop.messageId).catch(()=>null) : null;
    if (orig) { const ce = new EmbedBuilder().setColor('#3B6D11').setTitle('🎰  MYSTERY DROP — CLAIMED').setDescription('Someone got it. Check your DMs if that was you.\n\nAnother drop is coming. Keep your notifications on.').setFooter({text:"Bully's World • First come, first served."}).setTimestamp(); await orig.edit({embeds:[ce]}).catch(()=>{}); }
    return;
  }

  // ── !notifications ──
  if (content === '!notifications') {
    const current = dmAllowed(userId);
    const embed = new EmbedBuilder().setColor('#2b2d31')
      .setTitle('🔔 Notification Settings')
      .setDescription(
        `Your bot DMs are currently **${current ? 'on' : 'off'}**.\n\n` +
        (current
          ? `To turn them off, type **\`!notifications off\`**`
          : `To turn them back on, type **\`!notifications on\`**`)
      )
      .setFooter({ text: "Bully's World" }).setTimestamp();
    await message.reply({ embeds: [embed] });
    return;
  }
  if (content === '!notifications off') {
    setDmOptOut(userId, true);
    await message.reply({ embeds: [new EmbedBuilder().setColor('#2b2d31').setDescription('🔕 Got it — bot DMs turned off.').setFooter({ text: "Bully's World" })] });
    return;
  }
  if (content === '!notifications on') {
    setDmOptOut(userId, false);
    await message.reply({ embeds: [new EmbedBuilder().setColor('#2b2d31').setDescription('🔔 Bot DMs turned back on.').setFooter({ text: "Bully's World" })] });
    return;
  }

  // ── !balance ──
  if (content === '!balance') {
    const u = getUser(userId, username);
    const bankBalance = u.bank_balance ?? 0;
    const { capacity, label } = getBankCapacity(message.member);
    const embed = new EmbedBuilder().setColor('#1a1a1a').setTitle('💰 Your Bully Bucks Balance')
      .addFields(
        { name: '👛 Wallet',       value: `${u.balance.toLocaleString()} BB`,      inline: true },
        { name: '📈 Total Earned', value: `${u.total_earned.toLocaleString()} BB`, inline: true },
        { name: '🔥 Streak',       value: `${u.streak||0} days`,  inline: true },
        { name: '🏦 Bank',         value: `${bankBalance.toLocaleString()} / ${capacity.toLocaleString()} BB  *(${label})*`, inline: false },
      )
      .addFields({ name: '📌 Tip', value: 'Use `!bank` to see all banking tiers and how to deposit/withdraw.', inline: false })
      .setFooter({ text: "Bully's World • Keep earning." }).setTimestamp();
    // Send privately — balance is personal info
    await message.delete().catch(() => {});
    try {
      await message.author.send({ embeds: [embed] });
    } catch (_) {
      // DMs closed — fall back to a channel reply that auto-deletes
      const r = await message.channel.send({ content: `<@${userId}>`, embeds: [embed] });
      setTimeout(() => r.delete().catch(() => {}), 15000);
    }
    return;
  }

  // ── BANK COMMANDS ──────────────────────────────────────────────────────────
  if (content.startsWith('!deposit') || content.startsWith('!withdraw')) {
    const u = getUser(userId, username);
    const { capacity, label } = getBankCapacity(message.member);
    const bankBalance = u.bank_balance ?? 0;

    const sendPrivate = async (text) => {
      await message.delete().catch(() => {});
      try { await message.author.send(text); }
      catch (_) { const r = await message.channel.send(`<@${userId}> ${text}`); setTimeout(() => r.delete().catch(() => {}), 15000); }
    };

    // !deposit [amount|all]
    if (content.startsWith('!deposit')) {
      const parts = content.split(' ');
      const amt = parts[1] === 'all' ? u.balance : parseInt(parts[1]);
      if (isNaN(amt) || amt < 1) { await sendPrivate('Usage: `!deposit [amount]` or `!deposit all`'); return; }
      if (u.balance < amt) { await sendPrivate(`You only have **${u.balance} BB** in your wallet.`); return; }
      const room = capacity - bankBalance;
      if (room <= 0) { await sendPrivate(`Your bank is full (**${bankBalance}/${capacity} BB** — ${label}). Level up to unlock more capacity.`); return; }
      const actual = Math.min(amt, room);
      depositBB(userId, actual);
      const skipped = amt - actual;
      let reply = `✅ Deposited **${actual} BB** into your bank.`;
      if (skipped > 0) reply += ` *(${skipped} BB couldn't fit — bank full)*`;
      reply += `\n\n🏦 Bank: **${bankBalance + actual}/${capacity} BB** · 👛 Wallet: **${u.balance - actual} BB**`;
      await sendPrivate(reply); return;
    }

    // !withdraw [amount|all]
    if (content.startsWith('!withdraw')) {
      const parts = content.split(' ');
      const amt = parts[1] === 'all' ? bankBalance : parseInt(parts[1]);
      if (isNaN(amt) || amt < 1) { await sendPrivate('Usage: `!withdraw [amount]` or `!withdraw all`'); return; }
      if (bankBalance < amt) { await sendPrivate(`You only have **${bankBalance} BB** in your bank.`); return; }
      withdrawBB(userId, amt);
      await sendPrivate(`✅ Withdrew **${amt} BB** from your bank.\n\n🏦 Bank: **${bankBalance - amt}/${capacity} BB** · 👛 Wallet: **${u.balance + amt} BB**`); return;
    }
  }

  // ── !bank — banking tier guide ──────────────────────────────────────────────
  if (content === '!bank') {
    const u = getUser(userId, username);
    const bankBalance = u.bank_balance ?? 0;
    const { capacity, label } = getBankCapacity(message.member);
    const tierLines = BANK_LEVEL_ROLES.map(t => {
      const isCurrent = label === t.label;
      return `${isCurrent ? '▶️' : '◾'} **${t.label}** — up to **${t.capacity.toLocaleString()} BB**${isCurrent ? '  ← *your tier*' : ''}`;
    }).join('\n');
    const embed = new EmbedBuilder()
      .setColor('#c9a84c')
      .setTitle('🏦 Bully Bucks Banking Guide')
      .setDescription(
        `The bank protects your BB from steals and lets you save up for big purchases. ` +
        `Your bank limit grows as your server level increases.\n\n` +
        `**Your Bank:** ${bankBalance.toLocaleString()} / ${capacity.toLocaleString()} BB  *(${label})*`
      )
      .addFields(
        {
          name: '📊 Banking Tiers (Level → Capacity)',
          value:
            `> *(No role yet)* — bank locked until you reach Rookie\n` +
            tierLines,
          inline: false
        },
        {
          name: '💡 How to Use It',
          value:
            '`!deposit [amount]` or `!deposit all` — move BB from wallet → bank\n' +
            '`!withdraw [amount]` or `!withdraw all` — move BB from bank → wallet\n' +
            '`!balance` — see your wallet + bank at a glance',
          inline: false
        },
        {
          name: '🔒 Why Bank?',
          value:
            '• BB in your **bank cannot be stolen**\n' +
            '• Your bank balance **counts toward the leaderboard**\n' +
            '• Level up in the server (just chat + check in) to unlock bigger tiers',
          inline: false
        }
      )
      .setFooter({ text: "Bully's World • Stack and protect your BB." })
      .setTimestamp();
    await message.delete().catch(() => {});
    try { await message.author.send({ embeds: [embed] }); }
    catch (_) { const r = await message.channel.send({ content: `<@${userId}>`, embeds: [embed] }); setTimeout(() => r.delete().catch(() => {}), 25000); }
    return;
  }

  // ── !blackmarket ──
  if (content === '!blackmarket') {
    const u = getUser(userId, username);
    const shieldRow = db.prepare('SELECT expires_at FROM shields WHERE user_id = ?').get(userId);
    const shieldActive = shieldRow && new Date(shieldRow.expires_at) > new Date();
    const embed = new EmbedBuilder().setColor('#1a1a1a').setTitle('🖤 Black Market')
      .setDescription(Object.values(ITEMS).map(item => {
        if (item.instant) {
          // Shield — show live status instead of uses/stack
          const statusStr = shieldActive
            ? ` · 🛡️ **Active** — expires <t:${Math.floor(new Date(shieldRow.expires_at).getTime()/1000)}:R>`
            : ' · _(inactive)_';
          return `${item.emoji} **${item.name}** — ${item.price.toLocaleString()} BB\n*${item.description}*${statusStr}`;
        }
        const uses = getItemUses(userId, item.id);
        const stacks = getItemStacks(userId, item.id);
        const cdMs = itemCooldownRemaining(userId, item.id);
        const cdStr = cdMs > 0 ? ` · ⏳ ${fmtCooldown(cdMs)}` : '';
        const ownedStr = uses > 0 ? ` · 🎒 ${uses} use${uses!==1?'s':''}${cdStr}` : '';
        return `${item.emoji} **${item.name}** — ${item.price.toLocaleString()} BB\n*${item.description}*\n${item.maxUses} use${item.maxUses>1?'s':''} · Stack: ${stacks}/${item.stackLimit}${ownedStr}`;
      }).join('\n\n'))
      .addFields({ name: '👛 Your Wallet', value: `${u.balance.toLocaleString()} BB`, inline: true })
      .setFooter({ text: "Bully's World • No refunds." }).setTimestamp();
    // Row 1: Buy buttons
    const buyRow = new ActionRowBuilder().addComponents(
      Object.values(ITEMS).map(item => {
        if (item.instant) {
          const canBuy = u.balance >= item.price && !shieldActive;
          return new ButtonBuilder().setCustomId(`bm_buy.${item.id}`).setLabel(shieldActive ? '🛡️ Shielded' : `Buy ${item.name}`).setEmoji(item.emoji).setStyle(ButtonStyle.Primary).setDisabled(!canBuy);
        }
        const stacks = getItemStacks(userId, item.id);
        const canBuy = u.balance >= item.price && stacks < item.stackLimit;
        return new ButtonBuilder().setCustomId(`bm_buy.${item.id}`).setLabel(`Buy ${item.name}`).setEmoji(item.emoji).setStyle(ButtonStyle.Primary).setDisabled(!canBuy);
      })
    );
    // Row 2: Use buttons (instant items show status, not a use button)
    const useRow = new ActionRowBuilder().addComponents(
      Object.values(ITEMS).map(item => {
        if (item.instant) {
          return new ButtonBuilder().setCustomId(`bm_status.${item.id}`).setLabel(shieldActive ? '🛡️ Active' : '🛡️ No Shield').setStyle(ButtonStyle.Secondary).setDisabled(true);
        }
        const uses = getItemUses(userId, item.id);
        return new ButtonBuilder().setCustomId(`bm_use.${item.id}`).setLabel(`Use ${item.name}`).setEmoji(item.emoji).setStyle(ButtonStyle.Secondary).setDisabled(uses < 1);
      })
    );
    await message.reply({ embeds: [embed], components: [buyRow, useRow] });
    return;
  }

  // ── !history ──
  if (content === '!history') {
    const txns = db.prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 5').all(userId);
    if (!txns.length) { await message.reply('No transactions yet.'); return; }
    const embed = new EmbedBuilder().setColor('#1a1a1a').setTitle('Your Last 5 Transactions')
      .setDescription(txns.map(t=>`${t.amount>0?'+':''}${t.amount} BB — ${t.reason}`).join('\n'))
      .setFooter({text:"Bully's World"}).setTimestamp();
    await message.reply({ embeds: [embed] }); return;
  }

  // ── !shop ──
  if (content === '!shop') {
    const r = await message.reply(`🛍️ Check out <#1490066033250406511> to see the current store!`);
    setTimeout(() => r.delete().catch(() => {}), 6000);
    await message.delete().catch(() => {});
    return;
  }

  // !heistrules
  if (content === '!heistrules') {
    const heistLines = HEISTS.map((h, i) => {
      const prev = i > 0 ? HEISTS[i - 1].name : null;
      const lock = prev ? `*(Lead requires completing ${prev} first)*` : '*(Available to all)*';
      return `**${i + 1}. ${h.name}**\n${h.description}\nEntry: **${h.entry} BB** · Base odds: **${Math.round(h.chance * 100)}%** · Payout: **${h.payout} BB** split\n${lock}`;
    }).join('\n\n');
    const embed = new EmbedBuilder().setColor('#FF4500').setTitle('🦹 Heist Rules & Info')
      .setDescription(
        `**How heists work:**\nOne member leads and picks the heist. Others join by clicking the button and choosing a role. Each member pays an entry fee. The crew has 2 minutes to fill before the heist launches automatically.\n\n` +
        `**Minimum crew:** 2 members (leader + 1). Max: 5.\n\n` +
        `**Odds improve with crew size:** +3% success chance per extra member, up to +20% total.\n\n` +
        `**Level bonus:** The higher your server level, the more you contribute to the crew's odds. Each high-level member adds +2% to the success chance.\n\n` +
        `**On success:** The payout is split evenly across all crew members.\n**On failure:** Entry fees are lost — no refunds for a busted heist.\n**On cancel:** All entry fees are refunded.\n\n` +
        `**Leader progression:** To lead a heist, you must have successfully led the one before it. Anyone can *join* any heist regardless of progression.\n\n` +
        `─────────────────────\n\n` +
        `**The Heists:**\n\n${heistLines}`
      )
      .setFooter({ text: "Bully's World • Plan the job. Work the crew. Don't get caught." }).setTimestamp();
    await message.reply({ embeds: [embed] });
    return;
  }

  // !feedback
  if (content === '!feedback') {
    const embed = new EmbedBuilder()
      .setColor('#c9a84c')
      .setTitle('💬 Leave Feedback')
      .setDescription('Got something to say? We want to hear it!\n\n**[Click here to fill out the feedback form](https://forms.gle/WKCQasR9yemQFzKW7)**\n\nYour feedback helps make BULLYLAND better for everyone.')
      .setFooter({ text: "Bully's World • Every response is read." })
      .setTimestamp();
    await message.reply({ embeds: [embed] });
    return;
  }

  // !buy redirect
  if (content.startsWith('!buy')) {
    const r = await message.reply(`🛍️ Head to <#1490066033250406511> to browse and buy!`);
    setTimeout(() => r.delete().catch(() => {}), 6000);
    await message.delete().catch(() => {});
    return;
  }

  // ── !leaderboard ──
  if (content === '!leaderboard') {
    await message.reply({ embeds: [buildLeaderboardEmbed()] }); return;
  }

  // ── !stats ──
  if (content === '!stats') {
    const totalBB = db.prepare('SELECT SUM(balance) as t FROM balances').get().t||0;
    const totalM = db.prepare('SELECT COUNT(*) as c FROM balances').get().c||0;
    const totalP = db.prepare('SELECT COUNT(*) as c FROM shop_purchases').get().c||0;
    const embed = new EmbedBuilder().setColor('#1a1a1a').setTitle("Bully's World Economy")
      .addFields({name:'BB in circulation',value:`${totalBB} BB`,inline:true},{name:'Active members',value:`${totalM}`,inline:true},{name:'Total purchases',value:`${totalP}`,inline:true})
      .setFooter({text:"Bully's World"}).setTimestamp();
    await message.reply({ embeds: [embed] }); return;
  }

  // ── !help ──
  if (content === '!help') {
    const embed = new EmbedBuilder()
      .setColor('#c9a84c')
      .setTitle("🏠 Bully's World — Quick Guide")
      .setDescription(
        `Welcome! Pick a topic below to learn more — no searching needed.\n\n` +
        `**Quick commands you can always use:**\n` +
        `\`!balance\` · \`!bank\` · \`!checkin\` · \`!bullygames\` · \`!shop\``
      )
      .setFooter({ text: "Bully's World • Tap a button to learn more." })
      .setTimestamp();
    const row1 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('help.earning').setLabel('💰 Earning BB').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('help.banking').setLabel('🏦 Banking').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('help.games').setLabel('🎮 Games').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('help.stealing').setLabel('🕵️ Stealing').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('help.shop').setLabel('🛒 Shop').setStyle(ButtonStyle.Secondary),
    );
    await message.reply({ embeds: [embed], components: [row1] }); return;
  }

  // ── !redeem ──
  if (content.startsWith('!redeem ')) {
    const code = content.split(' ')[1]?.toUpperCase();
    if (!code) return;
    const row = db.prepare('SELECT * FROM redeem_codes WHERE code = ?').get(code);
    if (!row) { await message.reply('Invalid code.'); return; }
    if (row.claimed) { await message.reply('This code has already been claimed.'); return; }
    db.prepare('UPDATE redeem_codes SET claimed = 1 WHERE code = ?').run(code);
    addBB(userId, username, row.amount, `stream event code: ${code}`);
    await message.reply(`Code claimed! **${row.amount} BB** added to your balance.`); return;
  }

  // ── !inventory / !inv ──
  if (content === '!inventory' || content === '!inv') {
    await sendInventoryEmbed(message.channel, userId, username, 0, message);
    return;
  }

  // ── !equip / !unequip — redirect to inventory ──
  if (content.startsWith('!equip') || content.startsWith('!unequip')) {
    const r = await message.reply('🎒 Equip and unequip your roles using the buttons in **!inventory**!');
    setTimeout(() => r.delete().catch(() => {}), 8000);
    setTimeout(() => message.delete().catch(() => {}), 8000);
    return;
  }

  // ── !lottery — redirected to !bullygames ──
  if (content.startsWith('!lottery')) {
    const r = await message.reply('🎟️ Buy lottery tickets through **!bullygames** → 🎟️ Lottery!');
    setTimeout(() => r.delete().catch(() => {}), 6000);
    await message.delete().catch(() => {});
    return;
  }

  // ── !shield ── (redirects to black market)
  if (content === '!shield') {
    const r = await message.reply('🛡️ Shields are now sold in **!blackmarket** — **5,000 BB** for 24 hours of steal protection.');
    setTimeout(() => r.delete().catch(() => {}), 8000);
    return;
  }

  // ── !rain ──
  if (content.startsWith('!rain ')) {
    if (!isEnabled('rain')) { await message.reply('🌧️ BB Rain is currently **disabled**. Check back later.'); return; }
    const amount = parseInt(content.split(' ')[1]);
    if (isNaN(amount) || amount < 1) { await message.reply('Usage: `!rain [amount]` — splits BB among active members. Example: `!rain 500`'); return; }
    const u = getUser(userId, username);
    if (u.balance < amount) { await message.reply(`Not enough BB. You have **${u.balance} BB**.`); return; }
    const guild = await client.guilds.fetch(CONFIG.GUILD_ID);
    const members = await guild.members.fetch();
    const cutoff = Date.now() - 30 * 60 * 1000;
    const active = [];
    members.forEach(m => {
      if (m.user.bot || m.id === userId) return;
      const row = db.prepare('SELECT last_message FROM balances WHERE user_id = ?').get(m.id);
      if (row && row.last_message && new Date(row.last_message).getTime() > cutoff) active.push(m);
    });
    if (!active.length) { await message.reply('No active members in the last 30 minutes to rain on.'); return; }
    spendBB(userId, amount);
    const share = Math.floor(amount / active.length);
    if (share < 1) { await message.reply(`Not enough to split between ${active.length} active members. Try a larger amount.`); db.prepare('UPDATE balances SET balance = balance + ? WHERE user_id = ?').run(amount, userId); return; }
    active.forEach(m => addBB(m.id, m.user.username, share, `BB rain from ${username}`));
    const embed = new EmbedBuilder().setColor('#00BFFF').setTitle('🌧️ BULLY BUCKS RAIN!')
      .setDescription(`**${username}** just made it rain **${amount} BB**!

**${active.length} active members** each received **${share} BB**.

Stay active to catch the next rain!`)
      .setFooter({ text: "Bully's World • Generosity hits different." }).setTimestamp();
    await message.channel.send({ embeds: [embed] });
    return;
  }

  // ── !bid ──
  if (content.startsWith('!bid ')) {
    if (!activeAuction) { await message.reply('There is no active auction right now.'); return; }
    const auction = db.prepare('SELECT * FROM auctions WHERE id = ? AND status = ?').get(activeAuction, 'active');
    if (!auction) { await message.reply('No active auction found.'); return; }

    // Check blacklist
    const warningRow = db.prepare('SELECT * FROM auction_warnings WHERE user_id = ?').get(userId);
    if (warningRow?.blacklisted) { await message.reply('🚫 You are banned from participating in auctions.'); return; }

    const amount = parseFloat(content.split(' ')[1]);
    if (isNaN(amount) || amount < auction.starting_bid) { await message.reply(`Minimum bid is **$${auction.starting_bid.toFixed(2)}**.`); return; }
    const minBid = auction.current_bid ? auction.current_bid + 1 : auction.starting_bid;
    if (amount < minBid) { await message.reply(`You need to bid at least **$${minBid.toFixed(2)}** to beat the current bid.`); return; }
    if (auction.current_bidder_id === userId) { await message.reply("You're already the highest bidder!"); return; }

    // Save previous bidder as runner up
    const prevBidderId = auction.current_bidder_id;
    const prevBidderUsername = auction.current_bidder_username;
    const prevBid = auction.current_bid;

    db.prepare('UPDATE auctions SET current_bid = ?, current_bidder_id = ?, current_bidder_username = ?, second_bid = ?, second_bidder_id = ?, second_bidder_username = ? WHERE id = ?')
      .run(amount, userId, username, prevBid, prevBidderId, prevBidderUsername, activeAuction);
    db.prepare('INSERT INTO auction_bids (auction_id, user_id, username, amount) VALUES (?, ?, ?, ?)').run(activeAuction, userId, username, amount);

    const updatedAuction = db.prepare('SELECT * FROM auctions WHERE id = ?').get(activeAuction);
    await updateAuctionEmbed(updatedAuction);
    await message.reply(`✅ Bid of **$${amount.toFixed(2)}** placed! You are now the leading bidder.`);

    // Notify previous bidder they were outbid
    if (prevBidderId) {
      try {
        const prevMember = await message.guild.members.fetch(prevBidderId).catch(()=>null);
        if (prevMember) await prevMember.send(`⚠️ You've been outbid on **${auction.title}**! The new leading bid is **$${amount.toFixed(2)}**. Head to the auction channel to bid again.`);
      } catch {}
    }
    return;
  }

  // ── ADMIN AUCTION COMMANDS ──
  if (content.startsWith('!auction ')) {
    if (!message.member?.permissions.has(PermissionsBitField.Flags.Administrator)) return;
    const parts = message.content.trim().split(' ');
    const subcommand = parts[1]?.toLowerCase();

    // !auction start — deprecated, use !auction instead
    if (subcommand === 'start') { await message.reply('Use `!auction` to set up a new auction interactively.'); return; }

    // !auction end
    if (subcommand === 'end') {
      if (!activeAuction) { await message.reply('No active auction to end.'); return; }
      await endAuction(activeAuction, false);
      await message.reply('Auction ended manually.');
      return;
    }

    // !auction status
    if (subcommand === 'status') {
      if (!activeAuction) { await message.reply('No active auction right now.'); return; }
      const auction = db.prepare('SELECT * FROM auctions WHERE id = ?').get(activeAuction);
      await message.reply(`**${auction.title}** — Current bid: $${auction.current_bid?.toFixed(2) || '0.00'} by ${auction.current_bidder_username || 'nobody'}. Ends <t:${Math.floor(new Date(auction.ends_at).getTime()/1000)}:R>`);
      return;
    }

    // !auction unban @user
    if (subcommand === 'unban') {
      const mention = message.mentions.users.first();
      if (!mention) { await message.reply('Usage: `!auction unban @user`'); return; }
      db.prepare('UPDATE auction_warnings SET blacklisted = 0, warnings = 0 WHERE user_id = ?').run(mention.id);
      await message.reply(`✅ ${mention.username} has been unbanned from auctions.`);
      return;
    }

    // !auction warnings @user
    if (subcommand === 'warnings') {
      const mention = message.mentions.users.first();
      if (!mention) { await message.reply('Usage: `!auction warnings @user`'); return; }
      const row = db.prepare('SELECT * FROM auction_warnings WHERE user_id = ?').get(mention.id);
      if (!row) { await message.reply(`${mention.username} has no auction warnings.`); return; }
      await message.reply(`${mention.username} — Warnings: ${row.warnings}/3 | Blacklisted: ${row.blacklisted ? 'Yes 🚫' : 'No ✅'}`);
      return;
    }

    // !auction schedule — deprecated, use !auction instead
    if (subcommand === 'schedule') { await message.reply('Use `!auction` to set up a new auction interactively.'); return; }
  }

  // ── !duel ──
  if (content.startsWith('!duel ')) {
    if (!isEnabled('duel')) { await message.reply('⚔️ Duels are currently **disabled**. Check back later.'); return; }
    const target = message.mentions.users.first();
    const amount = parseInt(message.content.trim().split(' ')[2]);
    if (!target) { await message.reply('Usage: `!duel @user [amount]`'); return; }
    if (target.id === userId) { await message.reply("You can't duel yourself."); return; }
    if (target.bot) { await message.reply("You can't duel a bot."); return; }
    if (isNaN(amount) || amount < 1) { await message.reply('You must specify a bet amount. Usage: `!duel @user [amount]`'); return; }
    const u = getUser(userId, username);
    if (u.balance < amount) { await message.reply(`Not enough BB. You have **${u.balance} BB**.`); return; }
    if (activeDuels.has(target.id)) { await message.reply(`**${target.username}** already has a pending duel.`); return; }

    activeDuels.set(target.id, { challengerId: userId, challengerUsername: username, amount, messageId: null });

    const embed = new EmbedBuilder().setColor('#FF4500').setTitle('⚔️ DUEL CHALLENGE!')
      .setDescription(`<@${userId}> has challenged <@${target.id}> to a duel!

**Bet:** ${amount} BB each
**Winner takes:** ${amount * 2} BB

<@${target.id}> type **!accept** to accept or **!decline** to back down.

This challenge expires in 60 seconds.`)
      .setFooter({text:"Bully's World • May the best lady win."}).setTimestamp();
    const duelMsg = await message.channel.send({ embeds: [embed] });
    activeDuels.get(target.id).messageId = duelMsg.id;

    // Auto expire after 60 seconds
    setTimeout(async () => {
      if (activeDuels.has(target.id) && activeDuels.get(target.id).challengerId === userId) {
        activeDuels.delete(target.id);
        const expEmbed = new EmbedBuilder().setColor('#444441').setTitle('⚔️ DUEL EXPIRED')
          .setDescription(`<@${target.id}> didn't respond in time. Challenge expired.`)
          .setFooter({text:"Bully's World"}).setTimestamp();
        await duelMsg.edit({ embeds: [expEmbed] }).catch(()=>{});
      }
    }, 60000);
    return;
  }

  // ── !accept (duel) ──
  if (content === '!accept') {
    const duel = activeDuels.get(userId);
    if (!duel) { await message.reply("You don't have a pending duel challenge."); return; }
    const { challengerId, challengerUsername, amount, messageId } = duel;
    const challenger = getUser(challengerId, challengerUsername);
    const challenged = getUser(userId, username);
    if (challenger.balance < amount) { await message.reply(`<@${challengerId}> no longer has enough BB to cover the bet.`); activeDuels.delete(userId); return; }
    if (challenged.balance < amount) { await message.reply(`You don't have enough BB. You need **${amount} BB** to accept.`); return; }

    activeDuels.delete(userId);

    // Deduct from both
    db.prepare('UPDATE balances SET balance = balance - ? WHERE user_id = ?').run(amount, challengerId);
    db.prepare('UPDATE balances SET balance = balance - ? WHERE user_id = ?').run(amount, userId);

    // 50/50 coin flip
    const challengerWins = Math.random() < 0.5;
    const winnerId = challengerWins ? challengerId : userId;
    const winnerUsername = challengerWins ? challengerUsername : username;
    const loserId = challengerWins ? userId : challengerId;
    const loserUsername = challengerWins ? username : challengerUsername;
    const prize = amount * 2;

    addBB(winnerId, winnerUsername, prize, `duel win vs ${loserUsername}`);

    const winnerBalance = getUser(winnerId, winnerUsername).balance;
    const loserBalance = getUser(loserId, loserUsername).balance;

    const embed = new EmbedBuilder().setColor('#c9a84c').setTitle('⚔️ DUEL RESULT!')
      .setDescription(`**${winnerUsername}** wins the duel!

🏆 **+${prize} BB** goes to **${winnerUsername}**
💀 **${loserUsername}** walks away empty handed.`)
      .addFields(
        { name: `${winnerUsername}'s balance`, value: `${winnerBalance} BB`, inline: true },
        { name: `${loserUsername}'s balance`, value: `${loserBalance} BB`, inline: true }
      )
      .setFooter({text:"Bully's World • Winner takes all."}).setTimestamp();

    // Edit original duel message if possible
    try {
      const ch = message.channel;
      const orig = await ch.messages.fetch(messageId).catch(()=>null);
      if (orig) await orig.edit({ embeds: [embed] });
      else await message.channel.send({ embeds: [embed] });
    } catch { await message.channel.send({ embeds: [embed] }); }
    return;
  }

  // ── !decline (duel) ──
  if (content === '!decline') {
    if (!activeDuels.has(userId)) { await message.reply("You don't have a pending duel challenge."); return; }
    const { challengerUsername } = activeDuels.get(userId);
    activeDuels.delete(userId);
    await message.reply(`You declined **${challengerUsername}'s** duel challenge. 🐔`);
    return;
  }

  // ── !heist / !join / !starthere / !startheist / !cancelheist — redirect to !bullygames ──
  if (['!heist', '!join', '!starthere', '!startheist', '!cancelheist'].includes(content)) {
    const r = await message.reply('🎮 Heists are now launched from **!bullygames** → 🦹 Heist. Use that to start, join, or manage a heist!');
    setTimeout(() => r.delete().catch(() => {}), 8000);
    setTimeout(() => message.delete().catch(() => {}), 8000);
    return;
  }

  // ── !steal — handled by the dedicated steal handler below (DM-block system) ──

  // ── !gift / !give ──
  if (content.startsWith('!gift ') || content.startsWith('!give ')) {
    if (!isEnabled('gift')) { await message.reply('💸 Gifts are currently **disabled**. Check back later.'); return; }
    const mention = message.mentions.users.first();
    const amount = parseInt(message.content.trim().split(' ')[2]);
    if (!mention) { await message.reply('Usage: `!give @user amount`'); return; }
    if (mention.id === userId) { await message.reply("You can't give BB to yourself."); return; }
    if (mention.bot) { await message.reply("You can't give BB to a bot."); return; }
    if (isNaN(amount) || amount < 1) { await message.reply('Please enter a valid amount. Example: `!give @user 100`'); return; }

    // Block gifts to inactive users (5+ days no activity) — permanent rule
    if (!isActive(mention.id)) {
      await message.reply(`❌ **${mention.username}** hasn't been active in the last 5 days and cannot receive gifts right now.\n_This is a permanent server rule to keep the economy healthy._`);
      return;
    }

    // Block gifts to jailed users
    if (isJailed(mention.id)) {
      await message.reply(`❌ **${mention.username}** is in jail and cannot receive gifts right now.`);
      return;
    }

    const fee      = Math.max(1, Math.ceil(amount * 0.10));
    const received = amount - fee;
    if (received < 1) { await message.reply(`Amount too small — after the 10% transfer fee, the recipient would receive nothing.`); return; }
    const u = getUser(userId, username);
    if (u.balance < amount) { await message.reply(`Not enough BB. You have **${u.balance} BB**.`); return; }

    // Sender pays the full amount; fee is burned; recipient gets amount − fee
    db.prepare('UPDATE balances SET balance = balance - ? WHERE user_id = ?').run(amount, userId);
    db.prepare('INSERT INTO transactions (user_id, amount, reason) VALUES (?, ?, ?)').run(userId, -amount, `sent to ${mention.username}`);
    addBB(mention.id, mention.username, received, `received from ${username}`);

    const embed = new EmbedBuilder().setColor('#c9a84c').setTitle('💸 Bully Bucks Sent!')
      .setDescription(`**${username}** sent **${amount} BB** to **${mention.username}**.\n**${mention.username}** received **${received} BB** after the 10% transfer fee (**${fee} BB** burned).`)
      .setFooter({text:"Bully's World • Spread the wealth."}).setTimestamp();
    await message.reply({ embeds: [embed] });
    if (dmAllowed(mention.id)) {
      try {
        const dmEmbed = new EmbedBuilder().setColor('#c9a84c').setTitle('💸 You received Bully Bucks!')
          .setDescription(`**${username}** sent you **${amount} BB**. After the 10% transfer fee, you received **${received} BB**.\n\nCheck your balance with \`!balance\`.`)
          .setFooter({text:"Bully's World • Someone's feeling generous."}).setTimestamp();
        await mention.send({ embeds: [dmEmbed] });
      } catch {}
    }
    return;
  }

  // ── !jail ──
  if (content === '!jail') {
    const jailRow = getJail(userId);
    if (!jailRow) {
      await message.reply({ embeds: [new EmbedBuilder()
        .setColor('#3B6D11')
        .setTitle('✅ You\'re Free')
        .setDescription('You are **not in jail**. Stay out of trouble.')
        .setFooter({ text: "Bully's World" }).setTimestamp()
      ] });
      return;
    }
    const releaseTs = Math.floor(new Date(jailRow.release_at).getTime() / 1000);
    const u = getUser(userId, username);
    const canAfford = u.balance >= jailRow.bail_amount;
    const bailBtn = new ButtonBuilder()
      .setCustomId(`jail_bail.${userId}`)
      .setLabel(`💰 Pay Bail — ${jailRow.bail_amount.toLocaleString()} BB`)
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!canAfford);
    await message.reply({ embeds: [new EmbedBuilder()
      .setColor('#8B0000')
      .setTitle('⛓️ You\'re in Jail')
      .setDescription(
        `**Released:** <t:${releaseTs}:F> (<t:${releaseTs}:R>)\n` +
        `**Bail:** ${jailRow.bail_amount.toLocaleString()} BB\n` +
        `**Your wallet:** ${u.balance.toLocaleString()} BB\n\n` +
        `_While jailed: no steals, no heists, no received gifts, earnings reduced 60%._` +
        (!canAfford ? `\n\n⚠️ You don't have enough BB to pay bail right now.` : '')
      )
      .setFooter({ text: "Bully's World • Do the time or pay the bail." }).setTimestamp()
    ], components: [new ActionRowBuilder().addComponents(bailBtn)] });
    return;
  }

  // ── !bet — redirect to !bullygames ──
  if (content.startsWith('!bet')) {
    const r = await message.reply('🎮 Casino games are now in **!bullygames** → 🎰 Casino. Head there to play Slots, Blackjack, Roulette, and Horse Racing!');
    setTimeout(() => r.delete().catch(() => {}), 8000);
    setTimeout(() => message.delete().catch(() => {}), 8000);
    return;
  }

  // ── ADMIN COMMANDS ──
  const isAdmin = message.member?.permissions.has(PermissionsBitField.Flags.Administrator);
  if (!isAdmin) return;

  if (content.startsWith('!gift ')) {
    const mention = message.mentions.users.first(); const amount = parseInt(message.content.trim().split(' ')[2]);
    if (!mention||isNaN(amount)) { await message.reply('Usage: !gift @user amount'); return; }
    addBB(mention.id, mention.username, amount, 'gifted by Bully');
    try { await mention.send(`You just received **${amount} BB** from Bully!`); } catch {}
    await message.reply(`Gifted **${amount} BB** to ${mention.username}.`); return;
  }
  if (content.startsWith('!disaster')) {
    if (!message.member?.permissions.has(PermissionsBitField.Flags.Administrator)) return;
    const disaster = DISASTERS[Math.floor(Math.random() * DISASTERS.length)];
    const guild = await client.guilds.fetch(CONFIG.GUILD_ID);
    const members = await guild.members.fetch();
    const targets = members.filter(m => !m.user.bot);
    const amount = 75;
    targets.forEach(m => {
      const u = getUser(m.id, m.user.username);
      const actualLoss = Math.min(amount, u.balance);
      if (actualLoss > 0) {
        db.prepare('UPDATE balances SET balance = balance - ? WHERE user_id = ?').run(actualLoss, m.id);
        db.prepare('INSERT INTO transactions (user_id, amount, reason) VALUES (?, ?, ?)').run(m.id, -actualLoss, `disaster: ${disaster.name}`);
      }
    });
    const embed = new EmbedBuilder().setColor('#8B0000').setTitle(`💥 DISASTER — ${disaster.name}`)
      .setDescription(`${disaster.description}\n\n**Everyone in the server just lost ${amount} BB.**\n\nThere is no escape. There is no refund. This is BULLYLAND.`)
      .setFooter({text:"Bully's World • Disasters happen."}).setTimestamp();
    await message.channel.send({ content: GAMER_PING, embeds: [embed] });
    return;
  }

  if (content.startsWith('!gifteveryone ')) {
    const amount = parseInt(message.content.trim().split(' ')[1]);
    if (isNaN(amount) || amount < 1) { await message.reply('Usage: !gifteveryone [amount]'); return; }
    const guild = await client.guilds.fetch(CONFIG.GUILD_ID);
    const members = await guild.members.fetch();
    const targets = members.filter(m => !m.user.bot);
    targets.forEach(m => addBB(m.id, m.user.username, amount, 'gifteveryone'));
    await message.reply(`✅ Gifted **${amount} BB** to **${targets.size}** members.`);
    return;
  }

  if (content.startsWith('!giftall ')) {
    const role = message.mentions.roles.first(); const amount = parseInt(message.content.trim().split(' ')[2]);
    if (!role||isNaN(amount)) { await message.reply('Usage: !giftall @role amount'); return; }
    const guild = await client.guilds.fetch(CONFIG.GUILD_ID);
    const members = await guild.members.fetch();
    const targets = members.filter(m=>m.roles.cache.has(role.id)&&!m.user.bot);
    targets.forEach(m=>addBB(m.id, m.user.username, amount, `mass gift to ${role.name}`));
    await message.reply(`Gifted **${amount} BB** to **${targets.size}** members with ${role.name}.`); return;
  }
  if (content.startsWith('!createcode ')) {
    const parts = message.content.trim().split(' '); const code = parts[1]?.toUpperCase(); const amount = parseInt(parts[2]);
    if (!code||isNaN(amount)) { await message.reply('Usage: !createcode CODE amount'); return; }
    db.prepare('INSERT OR REPLACE INTO redeem_codes (code, amount, claimed) VALUES (?, ?, 0)').run(code, amount);
    await message.reply(`Code **${code}** created — worth **${amount} BB**. Members redeem with !redeem ${code}`); return;
  }
  if (content.startsWith('!balancecheck ')) {
    const mention = message.mentions.users.first();
    if (!mention) { await message.reply('Usage: !balancecheck @user'); return; }
    const u = getUser(mention.id, mention.username);
    await message.reply(`${mention.username}: **${u.balance} BB** | Total earned: ${u.total_earned} BB | Streak: ${u.streak||0} days`); return;
  }

  // ── !balanceid <userId> — look up any user's balance by raw ID (no mention needed) ──
  if (content.startsWith('!balanceid ')) {
    const targetId = message.content.trim().split(/\s+/)[1];
    if (!targetId) { await message.reply('Usage: `!balanceid <userId>`'); return; }
    const u = db.prepare('SELECT * FROM balances WHERE user_id = ?').get(targetId);
    if (!u) { await message.reply(`No record found for user ID \`${targetId}\`.`); return; }
    const bank = u.bank_balance ?? 0;
    const total = u.balance + bank;
    const embed = new EmbedBuilder()
      .setColor('#1a1a1a')
      .setTitle(`🔍 Balance Lookup — ${u.username}`)
      .addFields(
        { name: '🆔 User ID',       value: `\`${targetId}\``,                    inline: false },
        { name: '👛 Wallet',        value: `**${u.balance.toLocaleString()} BB**`, inline: true  },
        { name: '🏦 Bank',          value: `**${bank.toLocaleString()} BB**`,      inline: true  },
        { name: '💰 Total',         value: `**${total.toLocaleString()} BB**`,     inline: true  },
        { name: '📈 Total Earned',  value: `${u.total_earned.toLocaleString()} BB`, inline: true },
        { name: '🔥 Streak',        value: `${u.streak || 0} days`,               inline: true  },
      )
      .setFooter({ text: "Admin View • Bully's World" }).setTimestamp();
    await message.reply({ embeds: [embed] }); return;
  }

  // ── !adminlb — full leaderboard with exact amounts, admin eyes only ──
  if (content === '!adminlb' || content.startsWith('!adminlb ')) {
    const page = parseInt(message.content.trim().split(/\s+/)[1]) || 1;
    const pageSize = 20;
    const offset = (page - 1) * pageSize;
    const rows = db.prepare(
      `SELECT user_id, username, balance, COALESCE(bank_balance, 0) as bank,
              (balance + COALESCE(bank_balance, 0)) as total, total_earned, streak
       FROM balances ORDER BY total DESC LIMIT ? OFFSET ?`
    ).all(pageSize, offset);
    const totalUsers = db.prepare('SELECT COUNT(*) as c FROM balances').get().c;
    const totalPages = Math.ceil(totalUsers / pageSize);
    if (!rows.length) { await message.reply(`No users found on page ${page}.`); return; }
    const lines = rows.map((u, i) => {
      const rank = offset + i + 1;
      const kingMark = u.user_id === CONFIG.OWNER_ID ? ' 👑' : '';
      return `**${rank}.** ${u.username}${kingMark} — 💰 ${u.total.toLocaleString()} BB *(👛 ${u.balance.toLocaleString()} · 🏦 ${u.bank.toLocaleString()})* · ID: \`${u.user_id}\``;
    });
    const embed = new EmbedBuilder()
      .setColor('#c9a84c')
      .setTitle(`📊 Admin Leaderboard — Page ${page}/${totalPages}`)
      .setDescription(lines.join('\n'))
      .setFooter({ text: `${totalUsers} total users · !adminlb [page] · !balanceid <userId>` })
      .setTimestamp();
    await message.reply({ embeds: [embed] }); return;
  }
  if (content.startsWith('!adjust ')) {
    const mention = message.mentions.users.first(); const amount = parseInt(message.content.trim().split(' ')[2]);
    if (!mention||isNaN(amount)) { await message.reply('Usage: !adjust @user amount'); return; }
    addBB(mention.id, mention.username, amount, 'admin adjustment');
    await message.reply(`Adjusted ${mention.username} by **${amount} BB**.`); return;
  }
  if (content.startsWith('!gifttickets ')) {
    const mention = message.mentions.users.first();
    const parts = message.content.trim().split(' ');
    const amount = parseInt(parts[2]);
    if (!mention || isNaN(amount) || amount < 1) { await message.reply('Usage: !gifttickets @user amount'); return; }
    const current = getGiveawayEntries(mention.id);
    const actual = Math.min(amount, CONFIG.GIVEAWAY_MAX_TICKETS - current);
    if (actual <= 0) { await message.reply(`${mention.username} already has the max ${CONFIG.GIVEAWAY_MAX_TICKETS} tickets this cycle.`); return; }
    addGiveawayEntries(mention.id, mention.username, actual);
    try {
      const dmEmbed = new EmbedBuilder().setColor('#c9a84c')
        .setTitle('🎰 Giveaway Tickets Received!')
        .setDescription(`You just received **${actual} giveaway ticket${actual!==1?'s':''}** from Bully!\n\nYou now have **${current + actual} of ${CONFIG.GIVEAWAY_MAX_TICKETS}** max tickets this cycle.\n\nGood luck! 🎉`)
        .setFooter({text:"Bully's World • May the best lady win."}).setTimestamp();
      await mention.send({ embeds: [dmEmbed] });
    } catch {}
    await message.reply(`Gifted **${actual} ticket${actual!==1?'s':''}** to ${mention.username}. They now have ${current + actual}/${CONFIG.GIVEAWAY_MAX_TICKETS} tickets this cycle.`);
    return;
  }

  if (content.startsWith('!resetuser ')) {
    const mention = message.mentions.users.first();
    if (!mention) { await message.reply('Usage: !resetuser @user'); return; }
    db.prepare('UPDATE balances SET balance = 0, streak = 0 WHERE user_id = ?').run(mention.id);
    await message.reply(`Reset ${mention.username}'s balance and streak.`); return;
  }


  // ── !gamecontroller ──
  if (content === '!gamecontroller') {
    await message.reply(buildGameController());
    return;
  }

  // ── !unjail @user ──
  if (content.startsWith('!unjail ')) {
    const mention = message.mentions.users.first();
    if (!mention) { await message.reply('Usage: `!unjail @user`'); return; }
    const jailRow = getJail(mention.id);
    if (!jailRow) { await message.reply(`${mention.username} is not in jail.`); return; }
    db.prepare('DELETE FROM jail WHERE user_id = ?').run(mention.id);
    await message.reply(`✅ **${mention.username}** has been released from jail.`);
    return;
  }

  // ── !crowntax [confirm] ──
  if (content === '!crowntax' || content === '!crowntax confirm') {
    const TAX_BRACKETS = [
      { min: 40000, rate: 0.15, label: '40k+',      pct: '15%' },
      { min: 15000, rate: 0.10, label: '15k–40k',   pct: '10%' },
      { min: 5000,  rate: 0.05, label: '5k–15k',    pct: '5%'  },
    ];
    const allUsers = db.prepare('SELECT user_id, username, balance FROM balances WHERE balance >= 5000 ORDER BY balance DESC').all();

    if (!allUsers.length) { await message.reply('No users meet the minimum threshold (5,000 BB). No tax applied.'); return; }

    const preview = allUsers.map(u => {
      const bracket = TAX_BRACKETS.find(b => u.balance >= b.min);
      const tax = Math.floor(u.balance * bracket.rate);
      return { ...u, tax, rate: bracket.rate, label: bracket.label, pct: bracket.pct };
    });

    const totalTaxed = preview.reduce((s, u) => s + u.tax, 0);

    if (content === '!crowntax') {
      const lines = preview.slice(0, 20).map(u =>
        `**${u.username}** — ${u.balance.toLocaleString()} BB → taxed **${u.tax.toLocaleString()} BB** *(${u.pct}, ${u.label})*`
      ).join('\n');
      const more = preview.length > 20 ? `\n_...and ${preview.length - 20} more_` : '';
      const previewEmbed = new EmbedBuilder()
        .setColor('#FFD700')
        .setTitle('👑 Emergency Crown Tax — Preview')
        .setDescription(
          `**${preview.length} users** will be taxed.\n**${totalTaxed.toLocaleString()} BB** total will be burned from circulation.\n\n` +
          `**Brackets:**\nUnder 5k → None\n5k–15k → 5%\n15k–40k → 10%\n40k+ → 15%\n\n` +
          `**Affected users:**\n${lines}${more}`
        )
        .setFooter({ text: 'Run !crowntax confirm to execute. This cannot be undone.' })
        .setTimestamp();
      await message.reply({ embeds: [previewEmbed] });
      return;
    }

    // Execute the tax
    let taxed = 0, totalBurned = 0;
    for (const u of preview) {
      db.prepare('UPDATE balances SET balance = balance - ? WHERE user_id = ?').run(u.tax, u.user_id);
      db.prepare('INSERT INTO transactions (user_id, amount, reason) VALUES (?, ?, ?)').run(u.user_id, -u.tax, `Emergency Crown Tax (${u.pct})`);
      taxed++;
      totalBurned += u.tax;
    }

    const resultEmbed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle('👑 Emergency Crown Tax — Executed')
      .setDescription(
        `**${taxed} users** taxed.\n**${totalBurned.toLocaleString()} BB** burned from circulation.\n\n` +
        `_Every member with 5,000+ BB has been taxed. The funds have been destroyed — not redistributed._`
      )
      .setFooter({ text: "Bully's World • Crown Tax complete." })
      .setTimestamp();
    await message.reply({ embeds: [resultEmbed] });

    // Post the decree to announcements
    const taxAnnounceChannel = client.channels.cache.get(ANNOUNCEMENT_CHANNEL_ID) ||
                               client.channels.cache.get(CONFIG.CHANNELS.GENERAL);
    if (taxAnnounceChannel) {
      await taxAnnounceChannel.send({ content: GAMER_PING, embeds: [new EmbedBuilder()
        .setColor('#FFD700')
        .setTitle('👑  BY DECREE OF THE CROWN')
        .setDescription(
          `*Let it be known throughout BULLYLAND —*\n\n` +
          `The economy has grown unstable. Wealth has accumulated beyond what the land can sustain. ` +
          `In the interest of balance, fairness, and the future of this community, ` +
          `**an Emergency Crown Tax has been levied.**\n\n` +
          `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
          `**📜 THE CROWN TAX — COLLECTED**\n\n` +
          `All members carrying significant wealth were taxed according to the following brackets:\n\n` +
          `> 🪙 **Under 5,000 BB** — exempt\n` +
          `> 💰 **5,000 – 14,999 BB** — 5% levied\n` +
          `> 💎 **15,000 – 39,999 BB** — 10% levied\n` +
          `> 👑 **40,000 BB and above** — 15% levied\n\n` +
          `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
          `**${taxed} member${taxed !== 1 ? 's' : ''}** were taxed.\n` +
          `**${totalBurned.toLocaleString()} BB** has been permanently destroyed — not redistributed.\n\n` +
          `_This was a one-time measure. The books are balanced. The economy moves forward from here._\n\n` +
          `*There was no appeal. There was no exception. The crown has spoken.*`
        )
        .setFooter({ text: "Bully's World • Emergency Economic Decree" })
        .setTimestamp()
      ] });
    }
    return;
  }

  if (content === '!analytics' || content.startsWith('!analytics ')) {
    // ── Parse optional date range ─────────────────────────────────────────────
    const args = content.slice('!analytics'.length).trim().split(/\s+/).filter(Boolean);
    let startDate = null, endDate = null, rangeLabel = 'All Time';

    if (args.length > 0) {
      const a1 = args[0];
      const relMatch = a1.match(/^(\d+)(d|m|y)$/i);
      const absMatch = a1.match(/^\d{4}-\d{2}-\d{2}$/);

      if (relMatch) {
        const n = parseInt(relMatch[1]), u = relMatch[2].toLowerCase();
        const d = new Date();
        if      (u === 'd') { d.setDate(d.getDate() - n);         rangeLabel = `Last ${n} day${n !== 1 ? 's' : ''}`; }
        else if (u === 'm') { d.setMonth(d.getMonth() - n);       rangeLabel = `Last ${n} month${n !== 1 ? 's' : ''}`; }
        else if (u === 'y') { d.setFullYear(d.getFullYear() - n); rangeLabel = `Last ${n} year${n !== 1 ? 's' : ''}`; }
        startDate = d.toISOString().slice(0, 10);
      } else if (absMatch) {
        startDate = a1;
        rangeLabel = `Since ${startDate}`;
        if (args[1]?.match(/^\d{4}-\d{2}-\d{2}$/)) {
          endDate = args[1];
          rangeLabel = `${startDate} \u2192 ${endDate}`;
        }
      } else {
        await message.reply(
          '\u274c Invalid format. Examples:\n' +
          '`!analytics` \u2014 all time\n' +
          '`!analytics 7d` \u2014 last 7 days\n' +
          '`!analytics 30d` \u2014 last 30 days\n' +
          '`!analytics 3m` \u2014 last 3 months\n' +
          '`!analytics 2026-05-01` \u2014 from a date to now\n' +
          '`!analytics 2026-04-01 2026-04-30` \u2014 specific range'
        );
        return;
      }
    }

    // Build SQL date filters (dates validated by regex — safe to interpolate)
    const endTs   = endDate ? `${endDate} 23:59:59` : null;
    const whereTx = startDate
      ? (endTs ? `WHERE created_at >= '${startDate}' AND created_at <= '${endTs}'`
               : `WHERE created_at >= '${startDate}'`)
      : '';
    const andTx      = whereTx ? whereTx.replace('WHERE', 'AND') : '';
    const dailyLimit = (startDate && !endDate) ? 'LIMIT 30' : '';

    // ── Economy totals (always current snapshot) ──────────────────────────────
    const totals = db.prepare(`
      SELECT SUM(balance) as wallet_total, SUM(total_earned) as all_time_earned, COUNT(*) as user_count
      FROM balances
    `).get();

    // ── BB issued by feature, bucketed ───────────────────────────────────────
    const sources = db.prepare(`
      SELECT
        CASE
          WHEN reason LIKE '%check-in%'        THEN '\ud83d\udcc5 Daily Check-In'
          WHEN reason = 'message'              THEN '\ud83d\udcac Message Reward'
          WHEN reason LIKE 'heist win%'        THEN '\ud83e\uddb9 Heist Win'
          WHEN reason LIKE 'stolen from%'      THEN '\ud83c\udfa0 Steal Win'
          WHEN reason LIKE '%treasure%'        THEN '\ud83c\udf81 Treasure Chest'
          WHEN reason LIKE 'Booster%'          THEN '\ud83d\udcb4 Booster Paycheck'
          WHEN reason LIKE 'Superfan%'         THEN '\u2b50 Superfan Paycheck'
          WHEN reason LIKE '%stream event%'    THEN '\ud83c\udfab Redeem Code'
          WHEN reason = 'gifted by Bully'      THEN '\ud83c\udf80 Admin Gift (single)'
          WHEN reason LIKE 'gifteveryone%'     THEN '\ud83c\udf80 Admin Gift (everyone)'
          WHEN reason LIKE 'mass gift%'        THEN '\ud83c\udf80 Admin Mass Gift'
          WHEN reason LIKE 'admin adjustment%' THEN '\ud83d\udd27 Admin Adjustment'
          WHEN reason LIKE '%rain%'            THEN '\ud83c\udf27\ufe0f BB Rain'
          WHEN reason LIKE 'duel win%'         THEN '\u2694\ufe0f Duel Win'
          WHEN reason LIKE '%leaderboard%'     THEN '\ud83c\udfc6 Leaderboard Winner'
          WHEN reason LIKE 'received from%'    THEN '\u2194\ufe0f P2P Transfer'
          WHEN reason LIKE '%Casino%'          THEN '\ud83c\udfb0 Casino Win'
          ELSE '\u2753 Other'
        END as feature,
        SUM(amount) as total_bb,
        COUNT(*) as tx_count
      FROM transactions
      WHERE amount > 0 ${andTx}
      GROUP BY feature
      ORDER BY total_bb DESC
    `).all();

    const grandTotal = sources.reduce((s, r) => s + r.total_bb, 0);

    // ── Daily flow ────────────────────────────────────────────────────────────
    const daily = db.prepare(`
      SELECT
        DATE(created_at) as day,
        SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) as issued,
        SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END) as spent
      FROM transactions
      ${whereTx}
      GROUP BY day
      ORDER BY day DESC
      ${dailyLimit}
    `).all();

    // ── Top 10 richest (always current) ──────────────────────────────────────
    const rich = db.prepare('SELECT username, balance FROM balances ORDER BY balance DESC LIMIT 10').all();

    // ── Last transaction in range ─────────────────────────────────────────────
    const lastTx = db.prepare(`SELECT MAX(created_at) as ts FROM transactions ${whereTx}`).get();

    // ── Build embeds ──────────────────────────────────────────────────────────
    const sourceLines = sources.map(r => {
      const pct = grandTotal > 0 ? ((r.total_bb / grandTotal) * 100).toFixed(1) : '0.0';
      return `\`${String(r.total_bb.toLocaleString()).padStart(7)} BB\` **${pct}%** \u2014 ${r.feature} *(${r.tx_count} txns)*`;
    }).join('\n');

    const dailyLines = daily.length
      ? daily.map(r => {
          const net = r.issued - r.spent;
          const sign = net >= 0 ? '+' : '';
          return `\`${r.day}\`  +${r.issued.toLocaleString()} issued  \u2212${r.spent.toLocaleString()} spent  **${sign}${net.toLocaleString()} net**`;
        }).join('\n')
      : '_No transactions in this range._';

    const richLines = rich.map((r, i) =>
      `**#${i + 1}** ${r.username} \u2014 \`${r.balance.toLocaleString()} BB\``
    ).join('\n');

    const embed1 = new EmbedBuilder()
      .setColor('#c9a84c')
      .setTitle(`\ud83d\udcca Economy Analytics \u2014 ${rangeLabel}`)
      .addFields(
        { name: '\ud83d\udcb0 Total Wallet Supply', value: `${(totals.wallet_total || 0).toLocaleString()} BB`, inline: true },
        { name: '\ud83d\udcc8 All-Time Issued',     value: `${(totals.all_time_earned || 0).toLocaleString()} BB`, inline: true },
        { name: '\ud83d\udc65 Users Tracked',       value: `${totals.user_count}`, inline: true },
        { name: `\ud83c\udfe6 BB Issued by Source \u2014 ${grandTotal.toLocaleString()} BB total`, value: sourceLines || '_No data._' },
        { name: '\ud83c\udfc6 Top 10 Richest Members', value: richLines || '_No data._' }
      )
      .setFooter({ text: `Last transaction: ${lastTx?.ts || 'none in range'} \u2022 Bully's World Admin` })
      .setTimestamp();

    const embed2 = new EmbedBuilder()
      .setColor('#1E3A5F')
      .setTitle(`\ud83d\udcc6 Daily BB Flow \u2014 ${rangeLabel}`)
      .setDescription(dailyLines)
      .setFooter({ text: "issued = new BB created  \u2022  spent = BB removed from supply" });

    await message.reply({ embeds: [embed1, embed2] });
    return;
  }

  // ── !ecorollback YYYY-MM-DD [confirm] ───────────────────────────────────────────────────────────────────
  if (content.startsWith('!ecorollback')) {
    const ercParts = content.split(/\s+/);
    const ercDate = ercParts[1];
    const ercConfirm = ercParts[2] === 'confirm';
    if (!ercDate || !/^\d{4}-\d{2}-\d{2}$/.test(ercDate)) {
      await message.reply('`!ecorollback YYYY-MM-DD` (preview) or `!ecorollback YYYY-MM-DD confirm` (execute)');
      return;
    }
    const ercCutoff = ercDate + 'T00:00:00.000Z';
    const ercRows = db.prepare(`
      SELECT user_id, SUM(amount) as earned
      FROM transactions
      WHERE amount > 0 AND created_at >= ?
      GROUP BY user_id
      HAVING earned > 0
    `).all(ercCutoff);
    if (ercRows.length === 0) {
      await message.reply(`No positive transactions found since **${ercDate}**. Nothing to rollback.`);
      return;
    }
    const ercTotal = ercRows.reduce((s, r) => s + r.earned, 0);
    if (!ercConfirm) {
      const ercLines = ercRows.slice(0, 20).map(r => {
        const cur = db.prepare('SELECT balance FROM balances WHERE user_id = ?').get(r.user_id)?.balance ?? 0;
        const deduct = Math.min(r.earned, Math.max(0, cur));
        return `<@${r.user_id}> earned **${r.earned.toLocaleString()} BB** → confiscate **${deduct.toLocaleString()} BB** (has ${cur.toLocaleString()} BB)`;
      }).join('\n');
      const ercMore = ercRows.length > 20 ? `\n_...and ${ercRows.length - 20} more users_` : '';
      await message.reply({ embeds: [new EmbedBuilder()
        .setColor('#FF6600')
        .setTitle(`💸 Economy Rollback Preview — Since ${ercDate}`)
        .setDescription(
          `**${ercRows.length} users** earned BB since this date.\n` +
          `**Total earned (to confiscate):** ${ercTotal.toLocaleString()} BB\n\n` +
          ercLines + ercMore + `\n\n` +
          `⚠️ Run \`!ecorollback ${ercDate} confirm\` to execute. This cannot be undone.`
        )
        .setFooter({ text: "Bully's World Admin • Preview Only" })
        .setTimestamp()] });
      return;
    }
    // Execute
    let ercConfiscated = 0;
    const ercConfStmt = db.prepare('UPDATE balances SET balance = balance - ? WHERE user_id = ?');
    const ercTxStmt   = db.prepare('INSERT INTO transactions (user_id, amount, reason) VALUES (?, ?, ?)');
    db.transaction(() => {
      for (const row of ercRows) {
        const cur = db.prepare('SELECT balance FROM balances WHERE user_id = ?').get(row.user_id)?.balance ?? 0;
        const deduct = Math.min(row.earned, Math.max(0, cur));
        if (deduct > 0) {
          ercConfStmt.run(deduct, row.user_id);
          ercTxStmt.run(row.user_id, -deduct, `economy rollback — BB earned since ${ercDate} confiscated`);
          ercConfiscated += deduct;
        }
      }
    })();
    await message.reply({ embeds: [new EmbedBuilder()
      .setColor('#8B0000')
      .setTitle(`🔥 Economy Rollback Executed — Since ${ercDate}`)
      .setDescription(
        `**${ercRows.length} users** processed.\n` +
        `**Total confiscated:** ${ercConfiscated.toLocaleString()} BB removed from circulation.\n\n` +
        `_Transaction records updated. The books are balanced._`
      )
      .setFooter({ text: "Bully's World Admin • Rollback Complete" })
      .setTimestamp()] });
    return;
  }

  // ── !rolerollback YYYY-MM-DD [confirm] ──────────────────────────────────────────────────────────────────
  if (content.startsWith('!rolerollback')) {
    const rrbParts = content.split(/\s+/);
    const rrbDate = rrbParts[1];
    const rrbConfirm = rrbParts[2] === 'confirm';
    if (!rrbDate || !/^\d{4}-\d{2}-\d{2}$/.test(rrbDate)) {
      await message.reply('`!rolerollback YYYY-MM-DD` (preview) or `!rolerollback YYYY-MM-DD confirm` (execute)');
      return;
    }
    const rrbCutoff = rrbDate + 'T00:00:00.000Z';
    const rrbRows = db.prepare(`
      SELECT id, user_id, item_name, cost, created_at
      FROM shop_purchases
      WHERE created_at >= ?
      ORDER BY created_at ASC
    `).all(rrbCutoff);
    if (rrbRows.length === 0) {
      await message.reply(`No shop purchases found since **${rrbDate}**. Nothing to rollback.`);
      return;
    }
    const rrbTotalCost = rrbRows.reduce((s, r) => s + r.cost, 0);
    if (!rrbConfirm) {
      const rrbLines = rrbRows.slice(0, 20).map(p =>
        `<@${p.user_id}> — **${p.item_name}** (${p.cost.toLocaleString()} BB) on ${p.created_at.slice(0, 10)}`
      ).join('\n');
      const rrbMore = rrbRows.length > 20 ? `\n_...and ${rrbRows.length - 20} more_` : '';
      await message.reply({ embeds: [new EmbedBuilder()
        .setColor('#FF6600')
        .setTitle(`🎭 Role Rollback Preview — Since ${rrbDate}`)
        .setDescription(
          `**${rrbRows.length} purchases** found since this date.\n` +
          `**Total to refund:** ${rrbTotalCost.toLocaleString()} BB\n\n` +
          rrbLines + rrbMore + `\n\n` +
          `This will:\n` +
          `• Remove roles from members' Discord profiles (if equipped)\n` +
          `• Delete all matching entries from role inventories\n` +
          `• Refund the BB cost to each account\n\n` +
          `⚠️ Run \`!rolerollback ${rrbDate} confirm\` to execute. This cannot be undone.`
        )
        .setFooter({ text: "Bully's World Admin • Preview Only" })
        .setTimestamp()] });
      return;
    }
    // Execute — send immediate ack so it doesn't look frozen
    const rrbGuild = message.guild;
    const rrbAck = await message.reply(`⏳ Processing **${rrbRows.length} purchases**... stripping roles and refunding BB.`);
    let rrbRemoved = 0, rrbDiscordStripped = 0, rrbFailed = 0, rrbRefunded = 0;

    // ── Step 1: all DB work in one atomic transaction ──
    try {
      const rrbDelInv   = db.prepare('DELETE FROM role_inventory WHERE user_id = ? AND role_name = ?');
      const rrbDelPurch = db.prepare('DELETE FROM shop_purchases WHERE id = ?');
      const rrbRefund   = db.prepare('UPDATE balances SET balance = balance + ? WHERE user_id = ?');
      const rrbTxStmt   = db.prepare('INSERT INTO transactions (user_id, amount, reason) VALUES (?, ?, ?)');
      db.transaction(() => {
        for (const p of rrbRows) {
          rrbDelInv.run(p.user_id, p.item_name);   // wipe inventory entry (equipped or not)
          rrbDelPurch.run(p.id);                    // remove purchase record
          rrbRefund.run(p.cost, p.user_id);         // refund BB
          rrbTxStmt.run(p.user_id, p.cost, `role rollback refund — ${p.item_name} (purchased ${p.created_at.slice(0, 10)})`);
          rrbRefunded += p.cost;
          rrbRemoved++;
        }
      })();
    } catch (e) {
      console.error('[rolerollback] DB transaction failed:', e.message);
      rrbFailed++;
    }

    // ── Step 2: batch-fetch all unique members + refresh role cache in parallel ──
    const rrbUniqueIds = [...new Set(rrbRows.map(p => p.user_id))];
    let rrbMemberMap = new Map(); // userId → GuildMember
    try {
      // Fetch all members in one API call; falls back gracefully if intent missing
      const fetched = await rrbGuild.members.fetch({ user: rrbUniqueIds }).catch(() => null);
      if (fetched) fetched.forEach(m => rrbMemberMap.set(m.id, m));
    } catch (_) {}

    // Refresh role cache with one API call so we don't rely on stale data
    try { await rrbGuild.roles.fetch(); } catch (_) {}

    // ── Step 3: strip Discord roles from equipped members ──
    for (const p of rrbRows) {
      try {
        const member = rrbMemberMap.get(p.user_id);
        if (!member) continue; // left the server
        // Match role by exact name (shop item_name == Discord role name)
        const discordRole = rrbGuild.roles.cache.find(r => r.name === p.item_name);
        if (discordRole && member.roles.cache.has(discordRole.id)) {
          await member.roles.remove(discordRole, `role rollback — purchased ${p.created_at.slice(0, 10)}`);
          rrbDiscordStripped++;
        }
      } catch (e) {
        console.error(`[rolerollback] Could not strip role for ${p.user_id}/${p.item_name}:`, e.message);
      }
    }

    await rrbAck.edit({ content: '', embeds: [new EmbedBuilder()
      .setColor('#8B0000')
      .setTitle(`🎭 Role Rollback Executed — Since ${rrbDate}`)
      .setDescription(
        `**${rrbRemoved} inventory entries** purged from the database.\n` +
        `**${rrbDiscordStripped} Discord roles** stripped from equipped profiles.\n` +
        (rrbFailed > 0 ? `⚠️ **${rrbFailed} DB failures** — check console logs.\n` : '') +
        `**Total refunded:** ${rrbRefunded.toLocaleString()} BB returned to members.\n\n` +
        `_Purchase history cleared, inventories wiped, Discord roles removed._`
      )
      .setFooter({ text: "Bully's World Admin • Rollback Complete" })
      .setTimestamp()] });
    return;
  }

  // ── !restorestripped [confirm] ──────────────────────────────────────────────
  // Emergency restore: re-adds all roles that !fixroles stripped, using the
  // same transaction log source. Run this to undo the accidental strip.
  if (content === '!restorestripped' || content === '!restorestripped confirm') {
    const isRsConfirm = content === '!restorestripped confirm';
    const rsRows = db.prepare(`
      SELECT DISTINCT user_id, reason FROM transactions
      WHERE reason LIKE 'role rollback refund — %'
      ORDER BY created_at DESC
    `).all();
    if (rsRows.length === 0) {
      await message.reply('No rollback refund transactions found. Nothing to restore.');
      return;
    }
    const rsPairs = rsRows.map(r => {
      const afterDash = r.reason.split(' — ')[1] || '';
      const roleName  = afterDash.split(' (purchased')[0].trim();
      return { userId: r.user_id, roleName };
    }).filter(p => p.roleName);

    if (!isRsConfirm) {
      const lines = rsPairs.slice(0, 20).map(p => `<@${p.userId}> — **${p.roleName}**`).join('\n');
      const more  = rsPairs.length > 20 ? `\n_...and ${rsPairs.length - 20} more_` : '';
      await message.reply({ embeds: [new EmbedBuilder()
        .setColor('#2ECC71')
        .setTitle('🔁 Restore Stripped Roles — Preview')
        .setDescription(
          `**${rsPairs.length} roles** will be re-added to members.\n\n` +
          lines + more + `\n\n` +
          `⚠️ Run \`!restorestripped confirm\` to execute.`
        )
        .setFooter({ text: "Bully's World Admin • Preview Only" })
        .setTimestamp()] });
      return;
    }

    const rsGuild = message.guild;
    const rsAck = await message.reply(`⏳ Restoring **${rsPairs.length}** roles...`);
    try { await rsGuild.roles.fetch(); } catch (_) {}
    const rsIds = [...new Set(rsPairs.map(p => p.userId))];
    let rsMemberMap = new Map();
    try {
      const fetched = await rsGuild.members.fetch({ user: rsIds }).catch(() => null);
      if (fetched) fetched.forEach(m => rsMemberMap.set(m.id, m));
    } catch (_) {}

    let rsRestored = 0, rsSkipped = 0;
    for (const p of rsPairs) {
      try {
        const member = rsMemberMap.get(p.userId);
        if (!member) { rsSkipped++; continue; }
        const discordRole = rsGuild.roles.cache.find(r => r.name === p.roleName);
        if (!discordRole) { rsSkipped++; continue; }
        if (!member.roles.cache.has(discordRole.id)) {
          await member.roles.add(discordRole, 'restorestripped — emergency role restore');
          rsRestored++;
        } else {
          rsSkipped++; // already has it
        }
      } catch (e) {
        console.error(`[restorestripped] Failed for ${p.userId}/${p.roleName}:`, e.message);
        rsSkipped++;
      }
    }

    await rsAck.edit({ content: '', embeds: [new EmbedBuilder()
      .setColor('#2ECC71')
      .setTitle('🔁 Roles Restored')
      .setDescription(
        `**${rsRestored} roles** re-added to members.\n` +
        `**${rsSkipped} skipped** (already had role, member left, or role not found).\n\n` +
        `_All members should now have their roles back._`
      )
      .setFooter({ text: "Bully's World Admin • Restore Complete" })
      .setTimestamp()] });
    return;
  }

  // ── !fixroles [confirm] ─────────────────────────────────────────────────────
  // Strips shop-bought roles from members after a rolerollback that cleared the
  // DB but left Discord roles intact. ONLY strips roles that exist in SHOP_ROLES
  // (the Google Sheet source list) — reaction/interest roles are never touched.
  // Usage: !fixroles YYYY-MM-DD [confirm]
  if (content.startsWith('!fixroles')) {
    const fixParts   = content.split(/\s+/);
    const fixDate    = fixParts[1];
    const isFixConfirm = fixParts[2] === 'confirm' || fixParts[1] === 'confirm';

    if (!fixDate || fixDate === 'confirm' || !/^\d{4}-\d{2}-\d{2}$/.test(fixDate)) {
      await message.reply('Usage: `!fixroles YYYY-MM-DD` (preview) or `!fixroles YYYY-MM-DD confirm` (execute)\nOnly strips roles purchased on or after that date that exist in the shop master list.');
      return;
    }

    if (!SHOP_ROLES.length) {
      await message.reply('⚠️ SHOP_ROLES is empty — sheet may not have loaded yet. Try again in a moment.');
      return;
    }

    // Build a Set of all known shop role names for fast lookup
    const shopRoleNames = new Set(SHOP_ROLES.map(r => r.name));

    // Read all rollback refund transactions from last 7 days
    const fixCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const fixRows = db.prepare(`
      SELECT DISTINCT user_id, reason FROM transactions
      WHERE reason LIKE 'role rollback refund — %'
      AND created_at >= ?
      ORDER BY created_at DESC
    `).all(fixCutoff);

    if (fixRows.length === 0) {
      await message.reply('No role rollback refund transactions found in the last 7 days. Nothing to fix.');
      return;
    }

    // Parse reason string: "role rollback refund — ROLE_NAME (purchased YYYY-MM-DD)"
    // Filter: must be a shop role AND purchased on/after the specified date
    const fixPairs = fixRows.map(r => {
      const afterDash    = r.reason.split(' — ')[1] || '';
      const roleName     = afterDash.split(' (purchased')[0].trim();
      const purchasedRaw = (afterDash.match(/\(purchased (\d{4}-\d{2}-\d{2})\)/) || [])[1] || '';
      return { userId: r.user_id, roleName, purchasedDate: purchasedRaw };
    }).filter(p =>
      p.roleName &&
      shopRoleNames.has(p.roleName) &&       // shop roles only
      p.purchasedDate >= fixDate             // on or after the specified date
    );

    const skippedNonShop = fixRows.length - fixPairs.length;

    if (fixPairs.length === 0) {
      await message.reply('No shop role transactions found in the last 7 days (all entries were filtered as non-shop roles).');
      return;
    }

    if (!isFixConfirm) {
      const lines = fixPairs.slice(0, 20).map(p => `<@${p.userId}> — **${p.roleName}** (bought ${p.purchasedDate})`).join('\n');
      const more  = fixPairs.length > 20 ? `\n_...and ${fixPairs.length - 20} more_` : '';
      await message.reply({ embeds: [new EmbedBuilder()
        .setColor('#FF6600')
        .setTitle(`🔧 Fix Roles Preview — Purchased Since ${fixDate}`)
        .setDescription(
          `**${fixPairs.length} shop role assignments** to strip.\n` +
          (skippedNonShop > 0 ? `**${skippedNonShop} entries ignored** (non-shop or before cutoff date — safe).\n` : '') +
          `\n` + lines + more + `\n\n` +
          `Only roles from the shop's master list purchased on/after **${fixDate}** will be stripped.\n` +
          `⚠️ Run \`!fixroles ${fixDate} confirm\` to execute.`
        )
        .setFooter({ text: "Bully's World Admin • Preview Only" })
        .setTimestamp()] });
      return;
    }

    // Execute
    const fixGuild = message.guild;
    const fixAck = await message.reply(`⏳ Stripping **${fixPairs.length}** shop roles purchased since **${fixDate}**...`);
    try { await fixGuild.roles.fetch(); } catch (_) {}
    const fixUniqueIds = [...new Set(fixPairs.map(p => p.userId))];
    let fixMemberMap = new Map();
    try {
      const fetched = await fixGuild.members.fetch({ user: fixUniqueIds }).catch(() => null);
      if (fetched) fetched.forEach(m => fixMemberMap.set(m.id, m));
    } catch (_) {}

    let fixStripped = 0, fixSkipped = 0;
    for (const p of fixPairs) {
      try {
        const member = fixMemberMap.get(p.userId);
        if (!member) { fixSkipped++; continue; }
        const discordRole = fixGuild.roles.cache.find(r => r.name === p.roleName);
        if (discordRole && member.roles.cache.has(discordRole.id)) {
          await member.roles.remove(discordRole, 'fixroles — shop role rollback cleanup');
          fixStripped++;
        } else {
          fixSkipped++;
        }
      } catch (e) {
        console.error(`[fixroles] Failed for ${p.userId}/${p.roleName}:`, e.message);
        fixSkipped++;
      }
    }

    await fixAck.edit({ content: '', embeds: [new EmbedBuilder()
      .setColor('#8B0000')
      .setTitle(`🔧 Fix Roles Complete — Since ${fixDate}`)
      .setDescription(
        `**${fixStripped} shop roles** stripped from member profiles.\n` +
        `**${fixSkipped} skipped** (already removed, member left, or role not found).\n` +
        (skippedNonShop > 0 ? `**${skippedNonShop} entries untouched** (non-shop or before cutoff — reaction/interest roles preserved).\n` : '') +
        `\n_Only shop roles purchased on/after **${fixDate}** were affected._`
      )
      .setFooter({ text: "Bully's World Admin • Recovery Complete" })
      .setTimestamp()] });
    return;
  }

  // Test commands
  if (content==='!testspotlight') {
    await postMemberSpotlight();
    await message.reply('Member spotlight posted! Check <#' + CONFIG.CHANNELS.MEMBER_SPOTLIGHT + '>');
    return;
  }
  if (content==='!pausedrops') {
    dropsEnabled = false;
    await message.reply('🚫 Mystery drops are now **paused**. Type `!resumedrops` to turn them back on.');
    return;
  }
  if (content==='!resumedrops') {
    dropsEnabled = true;
    await message.reply('✅ Mystery drops are now **active** again.');
    return;
  }
  if (content==='!dropstatus') {
    await message.reply(`Mystery drops are currently **${dropsEnabled ? 'active ✅' : 'paused 🚫'}**.`);
    return;
  }
  if (content==='!testdrop')      await postMysteryDrop();
  if (content==='!testcheckin')   await postCheckin();
  if (content==='!testshop')      await refreshShop();
  if (content==='!testreset')     await doMonthlyReset();
  if (content==='!testgiveaway')  await runGiveaway();
  if (content==='!testgiveawayopen') await postGiveawayOpening();
  if (content==='!testgiveawayhide') await setGiveawayChannelVisible(false);
  if (content==='!testcasino')      await openCasino();
  if (content==='!testchest') { await spawnTreasureChest(); return; }
  if (content.startsWith('!testheist')) {
    if (activeHeists.size >= 3) { await message.reply('3 heists are already running.'); return; }
    const heistNum = parseInt(content.split(' ')[1]);
    let testHeist;
    if (!isNaN(heistNum) && heistNum >= 1 && heistNum <= HEISTS.length) {
      testHeist = HEISTS[heistNum - 1];
    } else {
      const list = HEISTS.map((h, i) => `**${i+1}.** ${h.name}`).join('\n');
      await message.reply(`Choose a heist to test:\n${list}\n\nUsage: \`!testheist [number]\``);
      return;
    }
    const testId = ++_heistIdCounter;
    activeHeists.set(testId, {
      id: testId,
      heist: testHeist,
      crew: [{ id: userId, username, role: 'mastermind' }, { id: '000000000000000001', username: 'TestCrewmate', role: 'driller' }],
      expiresAt: Date.now() + 5000,
      channel: message.channel,
    });
    await message.reply(`🧪 Test heist starting: **${testHeist.name}** with dummy crew...`);
    await executeHeist(testId, message.channel);
    return;
  }
  if (content==='!testlottery')     await runLottery();
});

// ─── SCHEDULER ─────────────────────────────────────────────────────────────
// ─── AUCTION SYSTEM ───────────────────────────────────────────────────────
// Heist definitions
const HEISTS = [
  { name: 'The Paint Heist',      description: "Steal Bully's secret color palette before the next live",                    entry: 5,  chance: 0.40, payout: 150,  penaltyMin: 0,  penaltyMax: 10  },
  { name: 'The Drip Raid',        description: "Sneak into Bully's Apparel warehouse and walk out with the new drop early",  entry: 8,  chance: 0.35, payout: 200,  penaltyMin: 0,  penaltyMax: 10  },
  { name: "Bully's Kitchen",      description: "Sneak into Bully's kitchen and steal a plate",                               entry: 10, chance: 0.30, payout: 250,  penaltyMin: 5,  penaltyMax: 15  },
  { name: 'The Canvas Caper',     description: "Lift Bully's most expensive original painting right off the wall",           entry: 15, chance: 0.25, payout: 400,  penaltyMin: 10, penaltyMax: 20  },
  { name: 'The Fourthwall Hack',  description: "Intercept a Bully's Apparel shipment before it reaches the customer",        entry: 20, chance: 0.20, payout: 500,  penaltyMin: 15, penaltyMax: 25  },
  { name: 'The Bully Bucks Vault',description: "Break into the BULLYLAND treasury and walk out with everything",             entry: 25, chance: 0.15, payout: 850,  penaltyMin: 25, penaltyMax: 35  },
];

const DISASTERS = [
  { name: 'The Great Paint Spill', description: "Bully knocked over every paint bucket in the studio. Cleanup costs hit the whole server." },
  { name: 'Apparel Recall', description: "A defective batch of Bully's Apparel had to be pulled from shelves. Everyone chips in to cover the losses." },
  { name: 'TikTok Outage', description: "The live stream crashed mid-auction and took the whole server economy down with it." },
  { name: 'The Kitchen Incident', description: "Something went very wrong in Bully's kitchen. Nobody is talking about it but everyone is paying for it." },
  { name: 'Canvas Catastrophe', description: "Three original paintings were accidentally destroyed at the gallery. The server is footing the bill." },
  { name: 'Shipping Crisis', description: "A major Bully's Apparel shipment went missing. Recovery costs hit everyone in BULLYLAND." },
  { name: 'Studio Flood', description: "A burst pipe flooded the entire studio. Equipment damage costs are being split across the server." },
];

// ─── TREASURE CHEST ───────────────────────────────────────────────────────
const TREASURE_CHANNELS = [
  '1353947995904671774', '1353947667306250300', '1353947367950258327',
  '1363400509267902705', '1458879814059430000', '1357504503317925959',
  '1353951732530417675', '1441184032447795200', '1490066670100811987',
  '1492571851178901706', '1380408131049361469',
];
const CHEST_TIERS = [
  { name: 'Common',    emoji: '📦', color: '#8B4513', prob: 0.50, min: 15,  max: 25  },
  { name: 'Rare',      emoji: '💎', color: '#4169E1', prob: 0.35, min: 30,  max: 45  },
  { name: 'Legendary', emoji: '👑', color: '#FFD700', prob: 0.15, min: 50,  max: 65  },
];
let activeChest = null; // { messageId, channelId, tier, expiresAt }

function rollChestTier() {
  const roll = Math.random();
  let cum = 0;
  for (const tier of CHEST_TIERS) {
    cum += tier.prob;
    if (roll < cum) return tier;
  }
  return CHEST_TIERS[0];
}

async function spawnTreasureChest() {
  if (activeChest) return;
  const tier = rollChestTier();
  const channelId = TREASURE_CHANNELS[Math.floor(Math.random() * TREASURE_CHANNELS.length)];
  const channel = await client.channels.fetch(channelId).catch(()=>null);
  if (!channel) return;

  const expiresAt = Date.now() + 30 * 60 * 1000;

  // Announce in general chat — track message for cleanup on claim
  const general = await client.channels.fetch(CONFIG.CHANNELS.GENERAL).catch(()=>null);
  let generalAnnouncementMsgId = null;
  if (general) {
    const generalMsg = await general.send({
      embeds: [new EmbedBuilder().setColor(tier.color)
        .setTitle('📦 A treasure chest has appeared in BULLYLAND!')
        .setDescription(`A **${tier.name}** treasure chest has been hidden somewhere in the server...

Find it and react with 🧡 to claim the riches!

⏰ It disappears <t:${Math.floor(expiresAt/1000)}:R>`)
        .setFooter({text:"Bully's World • Explore the server to find it."}).setTimestamp()
      ]
    });
    generalAnnouncementMsgId = generalMsg.id;
  }

  // Post chest in the hidden channel
  const chestEmbed = new EmbedBuilder().setColor(tier.color)
    .setTitle(`${tier.tier?.emoji || tier.emoji} ${tier.name} Treasure Chest`)
    .setDescription(`You found a **${tier.name}** treasure chest!

React with 🧡 to claim it!

⏰ Disappears <t:${Math.floor(expiresAt/1000)}:R>`)
    .setFooter({text:"Bully's World • First to react wins!"}).setTimestamp();

  const chestMsg = await channel.send({ embeds: [chestEmbed] });
  await chestMsg.react('🧡').catch(()=>{});

  activeChest = { messageId: chestMsg.id, channelId, tier, expiresAt, generalChannelId: CONFIG.CHANNELS.GENERAL, generalAnnouncementMsgId };

  // Auto expire after 30 minutes
  setTimeout(async () => {
    if (activeChest && activeChest.messageId === chestMsg.id) {
      activeChest = null;
      const expiredEmbed = new EmbedBuilder().setColor('#444441')
        .setTitle('📦 The treasure chest disappeared...')
        .setDescription('Nobody claimed it in time. Better luck next time.')
        .setFooter({text:"Bully's World"}).setTimestamp();
      await chestMsg.edit({ embeds: [expiredEmbed] }).catch(()=>{});
      await chestMsg.reactions.removeAll().catch(()=>{});
    }
  }, 30 * 60 * 1000);

  console.log(`[Treasure Chest] Spawned ${tier.name} chest in channel ${channelId}`);
}

const activeHeists = new Map();          // heistId → { id, heist, crew, expiresAt, channel }
const heistTimers = new Map();           // heistId → timer
const heistMessageMap = new Map();       // heistId → [messages]
const heistSelectionPending = new Map(); // userId → { username, channel, availableHeists }
let _heistIdCounter = 0;
const heistChallengeState        = new Map(); // heistId → challenge phase state
const heistDistractionListeners  = new Map(); // `channelId.userId` → listener
const activeStealTargets         = new Set(); // target user IDs currently being stolen from (mutex)
const activeShopBuyers           = new Set(); // user IDs mid-purchase (prevents concurrent buy race)
let shopSelectionPending = new Map(); // userId -> waiting for shop item number
let lotterySelectionPending = new Map(); // userId -> waiting for ticket count
let activeDuels = new Map(); // challenged_id -> duel info

let activeAuction = null;
let auctionTimer  = null;
const auctionSetupSessions = new Map(); // userId → true (setup in progress)

// ── Parse "MM/DD/YYYY HH:MM" as Central Time → UTC Date ───────────────────────
function parseCTString(str) {
  const match = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const [, month, day, year, hour, minute] = match.map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  // Determine CT offset: CDT (UTC-5) Mar 2nd Sun → Nov 1st Sun, else CST (UTC-6)
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute));
  const ctOffset = isCDT(utcGuess) ? 5 : 6;
  return new Date(Date.UTC(year, month - 1, day, hour + ctOffset, minute));
}
function isCDT(utcDate) {
  const m = utcDate.getUTCMonth(); // 0-indexed
  if (m < 2 || m > 10) return false;
  if (m > 2 && m < 10) return true;
  const d = utcDate.getUTCDate(), y = utcDate.getUTCFullYear();
  if (m === 2)  { const firstSun = (7 - new Date(Date.UTC(y, 2, 1)).getUTCDay()) % 7 + 1; const secondSun = firstSun + 7; return d >= secondSun; }
  if (m === 10) { const firstSun = (7 - new Date(Date.UTC(y, 10, 1)).getUTCDay()) % 7 + 1; return d < firstSun; }
  return false;
}
// ── Parse duration string → minutes ───────────────────────────────────────────
function parseDuration(str) {
  const match = str.trim().match(/^(\d+)\s*(minute|minutes|hour|hours|day|days)$/i);
  if (!match) return null;
  const n = parseInt(match[1]), unit = match[2].toLowerCase();
  if (unit.startsWith('day'))    return n * 24 * 60;
  if (unit.startsWith('hour'))   return n * 60;
  if (unit.startsWith('minute')) return n;
  return null;
}

// ── Start a scheduled auction (used both for scheduled and immediate launches) ─
async function setAuctionChannelVisible(visible) {
  try {
    const channel = await client.channels.fetch(CONFIG.CHANNELS.AUCTION).catch(() => null);
    if (!channel) return;
    const everyoneRole = channel.guild.roles.everyone;
    await channel.permissionOverwrites.edit(everyoneRole, { ViewChannel: visible });
    console.log(`[Auction] Channel ${visible ? 'revealed' : 'hidden'}.`);
  } catch (e) { console.error('[Auction] Failed to set channel visibility:', e.message); }
}

async function purgeAuctionChannel() {
  try {
    const channel = await client.channels.fetch(CONFIG.CHANNELS.AUCTION).catch(() => null);
    if (!channel) return;
    let deleted = 0;
    // Bulk delete in batches (only works for messages < 14 days old)
    let fetched;
    do {
      fetched = await channel.messages.fetch({ limit: 100 });
      if (fetched.size === 0) break;
      const eligible = fetched.filter(m => !BANNER_MESSAGE_IDS.has(m.id));
      const deletable = eligible.filter(m => Date.now() - m.createdTimestamp < 14 * 24 * 60 * 60 * 1000);
      if (deletable.size > 0) {
        await channel.bulkDelete(deletable, true).catch(() => {});
        deleted += deletable.size;
      }
      // Delete any older messages one by one
      const older = eligible.filter(m => Date.now() - m.createdTimestamp >= 14 * 24 * 60 * 60 * 1000);
      for (const m of older.values()) { await m.delete().catch(() => {}); deleted++; }
    } while (fetched.size >= 100);
    console.log(`[Auction] Purged ${deleted} messages from auction channel.`);
  } catch (e) { console.error('[Auction] Failed to purge channel:', e.message); }
}

async function startScheduledAuction(auctionId) {
  const auction = db.prepare('SELECT * FROM auctions WHERE id = ?').get(auctionId);
  if (!auction || auction.status !== 'scheduled') return;
  if (activeAuction) {
    console.warn(`[Auction] Cannot start #${auctionId} — another auction is active. Retrying in 30 min.`);
    setTimeout(() => startScheduledAuction(auctionId), 30 * 60 * 1000);
    return;
  }
  const channel = await client.channels.fetch(CONFIG.CHANNELS.AUCTION).catch(() => null);
  if (!channel) { console.error('[Auction] Auction channel not found for scheduled auction.'); return; }

  // Reveal the channel 15 seconds before posting so the @everyone ping notification fires
  await setAuctionChannelVisible(true);
  await new Promise(r => setTimeout(r, 15000));

  const durationMs  = (auction.duration_minutes || 240) * 60 * 1000;
  const endsAt      = new Date(Date.now() + durationMs).toISOString();
  const endsAtTs    = Math.floor(new Date(endsAt).getTime() / 1000);

  db.prepare("UPDATE auctions SET status = 'active', ends_at = ? WHERE id = ?").run(endsAt, auctionId);
  activeAuction = auctionId;

  const embed = new EmbedBuilder().setColor('#c9a84c').setTitle(`🎨 AUCTION — ${auction.title}`)
    .setDescription(
      `${auction.description || ''}\n\n` +
      `**Starting Bid:** $${(auction.starting_bid || 50).toFixed(2)}\n` +
      `**Leading Bidder:** No bids yet\n\n` +
      `⏰ Ends <t:${endsAtTs}:R>`
    )
    .setFooter({ text: "Bully's World • Highest bid wins." }).setTimestamp();
  if (auction.image_url) embed.setImage(auction.image_url);
  const bidRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('auction.bid').setLabel(`🔨 Place Bid — $${(auction.starting_bid || 50).toFixed(2)}`).setStyle(ButtonStyle.Success)
  );
  const auctionMsg = await channel.send({ content: `${GAMER_PING} 🎨 A new auction is live — **${auction.title}**! Place your bids below.`, embeds: [embed], components: [bidRow] });
  db.prepare('UPDATE auctions SET message_id = ? WHERE id = ?').run(auctionMsg.id, auctionId);
  auctionTimer = setTimeout(() => endAuction(auctionId, true), durationMs);
  console.log(`[Auction] Scheduled auction #${auctionId} "${auction.title}" is now live.`);
}

async function endAuction(auctionId, expired = true) {
  const auction = db.prepare('SELECT * FROM auctions WHERE id = ?').get(auctionId);
  if (!auction || auction.status !== 'active') return;
  db.prepare('UPDATE auctions SET status = ? WHERE id = ?').run('ended', auctionId);
  if (auctionTimer) { clearTimeout(auctionTimer); auctionTimer = null; }
  const channel = await client.channels.fetch(CONFIG.CHANNELS.AUCTION).catch(()=>null);

  if (!auction.current_bidder_id) {
    if (channel) {
      const embed = new EmbedBuilder().setColor('#444441').setTitle(`🖼️ AUCTION ENDED — NO BIDS`)
        .setDescription(`**${auction.title}**

No bids were placed. The auction has ended.`)
        .setFooter({text:"Bully's World • Better luck next time."}).setTimestamp();
      await channel.send({ embeds: [embed] });
    }
    // DM the owner with full auction details since channel gets purged
    try {
      const owner = await client.users.fetch(CONFIG.OWNER_ID);
      const startedAt = auction.scheduled_start ? `<t:${Math.floor(new Date(auction.scheduled_start).getTime()/1000)}:F>` : 'N/A';
      const endsAt = `<t:${Math.floor(new Date(auction.ends_at).getTime()/1000)}:F>`;
      const ownerEmbed = new EmbedBuilder().setColor('#ff4444')
        .setTitle(`🔔 Auction Ended With No Bids`)
        .addFields(
          { name: 'Item', value: auction.title, inline: true },
          { name: 'Starting Bid', value: `$${(auction.starting_bid || 50).toFixed(2)}`, inline: true },
          { name: 'Duration', value: `${auction.duration_minutes || 240} minutes`, inline: true },
          { name: 'Started', value: startedAt, inline: true },
          { name: 'Ended', value: endsAt, inline: true },
          { name: 'Auction ID', value: `#${auction.id}`, inline: true },
        )
        .setFooter({ text: 'No action needed — channel has been cleared.' }).setTimestamp();
      if (auction.image_url) ownerEmbed.setImage(auction.image_url);
      await owner.send({ embeds: [ownerEmbed] });
    } catch(e) { console.error('[Auction] Failed to DM owner about no-bid auction:', e.message); }
    activeAuction = null;
    await setAuctionChannelVisible(false);
    await purgeAuctionChannel();
    return;
  }

  // Announce winner
  if (channel) {
    const embed = new EmbedBuilder().setColor('#c9a84c').setTitle(`🎨 AUCTION WINNER — ${auction.title}`)
      .setDescription(`<@${auction.current_bidder_id}> won with a bid of **$${auction.current_bid.toFixed(2)}**!

Check your DMs to complete your purchase.`)
      .setFooter({text:"Bully's World • Congratulations!"}).setTimestamp();
    await channel.send({ content: '@everyone', embeds: [embed] });
  }

  await processAuctionWinner(auction, auction.current_bidder_id, auction.current_bidder_username, auction.current_bid);
  activeAuction = null;
  await setAuctionChannelVisible(false);
  await purgeAuctionChannel();
}

// Holds state for winners waiting on payment confirmation { stripeSessionId → { auction, winnerId, winnerUsername, winningBid, forfeitTimer } }
const pendingAuctionPayments = new Map();

async function processAuctionWinner(auction, winnerId, winnerUsername, winningBid) {
  try {
    const guild = await client.guilds.fetch(CONFIG.GUILD_ID);
    const winMember = await guild.members.fetch(winnerId).catch(()=>null);
    if (!winMember) return;

    // ── Create Stripe payment session ──────────────────────────────────────────
    let paymentUrl = null;
    let stripeSessionId = null;
    if (stripe) {
      try {
        const session = await stripe.checkout.sessions.create({
          payment_method_types: ['card'],
          line_items: [{
            price_data: {
              currency: 'usd',
              product_data: {
                name: auction.title,
                description: `Original artwork by Bully — auction winning bid`,
              },
              unit_amount: Math.round(winningBid * 100),
            },
            quantity: 1,
          }],
          mode: 'payment',
          success_url: 'https://bullysapparel.fourthwall.com',
          cancel_url:  'https://bullysapparel.fourthwall.com',
          metadata: { auction_id: String(auction.id), winner_id: winnerId },
        });
        paymentUrl     = session.url;
        stripeSessionId = session.id;
        // Record pending payment in DB
        db.prepare(
          `INSERT OR IGNORE INTO auction_payments (auction_id, stripe_session_id, winner_id, winner_username, amount, status)
           VALUES (?, ?, ?, ?, ?, 'pending')`
        ).run(auction.id, stripeSessionId, winnerId, winnerUsername, winningBid);
      } catch(e) { console.error('[Auction] Stripe error:', e.message); }
    }

    // ── DM winner — payment step only ─────────────────────────────────────────
    const paymentEmbed = new EmbedBuilder().setColor('#c9a84c')
      .setTitle(`🎨 You won the auction — ${auction.title}!`)
      .setDescription(
        `Congratulations! Your winning bid was **$${winningBid.toFixed(2)}**.\n\n` +
        `─────────────────────\n\n` +
        `**Step 1 — Complete your payment:**\n` +
        (paymentUrl
          ? `[👉 Click here to pay securely via Stripe](${paymentUrl})\n\n`
          : `A payment link will be sent to you shortly.\n\n`) +
        `─────────────────────\n\n` +
        `Once your payment is confirmed, you'll receive a follow-up DM to submit your shipping address.\n\n` +
        `⏳ You have **48 hours** to complete payment or your win will be forfeited and the next highest bidder will be contacted.`
      )
      .setFooter({ text: "Bully's Apparel • You earned this." }).setTimestamp();
    if (auction.image_url) paymentEmbed.setImage(auction.image_url);
    await winMember.send({ embeds: [paymentEmbed] }).catch(()=>{});

    // ── Set 48-hour forfeit timer for non-payment ──────────────────────────────
    const forfeitTimer = setTimeout(async () => {
      // Only forfeit if payment still pending
      const payRec = stripeSessionId
        ? db.prepare('SELECT status FROM auction_payments WHERE stripe_session_id = ?').get(stripeSessionId)
        : null;
      if (payRec && payRec.status === 'paid') return; // already paid — skip
      pendingAuctionPayments.delete(stripeSessionId || winnerId);
      await applyAuctionWarning(winnerId, winnerUsername, winMember);
      await winMember.send('⏰ Your auction win has been forfeited — payment was not received within 48 hours.').catch(()=>{});
      if (auction.second_bidder_id) {
        const ch = await client.channels.fetch(CONFIG.CHANNELS.AUCTION).catch(()=>null);
        if (ch) {
          await ch.send({ embeds: [new EmbedBuilder().setColor('#FF4500')
            .setTitle(`🎨 RUNNER UP CONTACTED — ${auction.title}`)
            .setDescription(`The original winner did not complete payment. <@${auction.second_bidder_id}> is now being contacted as the runner-up.`)
            .setFooter({ text: "Bully's World • Second chance!" }).setTimestamp()] });
        }
        const runnerUpAuction = { ...auction, current_bidder_id: auction.second_bidder_id, current_bidder_username: auction.second_bidder_username, current_bid: auction.second_bid };
        await processAuctionWinner(runnerUpAuction, auction.second_bidder_id, auction.second_bidder_username, auction.second_bid);
      }
    }, 48 * 60 * 60 * 1000);

    // Store state so the Stripe webhook can pick it up
    pendingAuctionPayments.set(stripeSessionId || winnerId, { auction, winnerId, winnerUsername, winningBid, winMember, forfeitTimer });

  } catch(e) { console.error('[Auction] Error processing winner:', e); }
}

// ── Called when Stripe webhook confirms payment ────────────────────────────────
async function startShippingCollection(auction, winnerId, winnerUsername, winningBid, winMember) {
  try {
    const owner = await client.users.fetch(CONFIG.OWNER_ID).catch(()=>null);
    const dmChannel = await winMember.createDM().catch(()=>null);
    if (!dmChannel) return;

    // Notify winner — payment confirmed, now need shipping info
    const shippingEmbed = new EmbedBuilder().setColor('#2ecc71')
      .setTitle('✅ Payment Confirmed — Shipping Info Needed')
      .setDescription(
        `Your payment of **$${winningBid.toFixed(2)}** for **${auction.title}** has been received!\n\n` +
        `─────────────────────\n\n` +
        `**Please reply to this DM with your shipping info:**\n\n` +
        `**Full Name:**\n\n` +
        `**Address Line 1:**\n\n` +
        `**Address Line 2** *(type N/A if none)*:\n\n` +
        `**City:**\n\n` +
        `**State/Province:**\n\n` +
        `**ZIP/Postal Code:**\n\n` +
        `**Country:**\n\n` +
        `**Phone Number:**\n\n` +
        `─────────────────────\n\n` +
        `⏳ Please submit within **24 hours**.`
      )
      .setFooter({ text: "Bully's Apparel • Almost there!" }).setTimestamp();
    await winMember.send({ embeds: [shippingEmbed] }).catch(()=>{});

    // Store session for owner !confirm flow
    activeGiveawaySessions.set(CONFIG.OWNER_ID, { winnerMember: winMember, cycle: `auction-${auction.id}` });

    const shippingCollector = dmChannel.createMessageCollector({
      filter: m => m.author.id === winnerId,
      time: 24 * 60 * 60 * 1000,
    });

    shippingCollector.on('collect', async (msg) => {
      if (!owner) return;
      const ownerEmbed = new EmbedBuilder().setColor('#1a1a1a')
        .setTitle(`📦 Auction Shipping Info — ${auction.title}`)
        .setDescription(
          `**Winner:** ${winnerUsername} (<@${winnerId}>)\n` +
          `**Winning bid:** $${winningBid.toFixed(2)}\n` +
          `**Payment:** ✅ Confirmed\n\n` +
          `─────────────────────\n\n` +
          `${msg.content}\n\n` +
          `─────────────────────\n\n` +
          `Type **!confirm** to confirm or reply with corrections to forward back to the winner.`
        )
        .setFooter({ text: "Bully's World — Auction System" }).setTimestamp();
      await owner.send({ embeds: [ownerEmbed] }).catch(()=>{});
    });

    shippingCollector.on('end', async (col) => {
      if (!col.size) {
        await applyAuctionWarning(winnerId, winnerUsername, winMember);
        await winMember.send('⏰ Shipping info was not received within 24 hours — your win has been forfeited.').catch(()=>{});
        activeGiveawaySessions.delete(CONFIG.OWNER_ID);
      }
    });

  } catch(e) { console.error('[Auction] Error starting shipping collection:', e); }
}

async function applyAuctionWarning(userId, username, member) {
  const row = db.prepare('SELECT * FROM auction_warnings WHERE user_id = ?').get(userId);
  if (!row) {
    db.prepare('INSERT INTO auction_warnings (user_id, username, warnings) VALUES (?, ?, 1)').run(userId, username);
    try { await member.send("⚠️ **Warning 1/3** — You forfeited your auction win. Two more forfeitures will result in a permanent auction ban."); } catch {}
  } else if (row.warnings === 1) {
    db.prepare('UPDATE auction_warnings SET warnings = 2 WHERE user_id = ?').run(userId);
    try { await member.send("⚠️ **Warning 2/3** — You forfeited another auction win. One more will result in a permanent auction ban."); } catch {}
  } else if (row.warnings >= 2) {
    db.prepare('UPDATE auction_warnings SET warnings = 3, blacklisted = 1 WHERE user_id = ?').run(userId);
    try { await member.send("🚫 You have been **permanently banned from auctions** in Bully's World due to repeated forfeitures."); } catch {}
    const channel = await client.channels.fetch(CONFIG.CHANNELS.AUCTION).catch(()=>null);
    if (channel) await channel.send(`🚫 **${username}** has been banned from auctions after 3 forfeitures.`);
  }
}

async function updateAuctionEmbed(auction) {
  try {
    const channel = await client.channels.fetch(CONFIG.CHANNELS.AUCTION).catch(()=>null);
    if (!channel || !auction.message_id) return;
    const msg = await channel.messages.fetch(auction.message_id).catch(()=>null);
    if (!msg) return;
    const endsAt = Math.floor(new Date(auction.ends_at).getTime() / 1000);
    const currentBid = auction.current_bid ?? auction.starting_bid;
    const nextBid = auction.current_bid === null || auction.current_bid === undefined
      ? (auction.starting_bid || 50).toFixed(2)
      : (auction.current_bid + 5).toFixed(2);
    const embed = new EmbedBuilder().setColor('#c9a84c').setTitle(`🎨 AUCTION — ${auction.title}`)
      .setDescription(
        `${auction.description || ''}\n\n` +
        `**Current Bid:** $${currentBid.toFixed(2)}\n` +
        `**Leading Bidder:** ${auction.current_bidder_username || 'No bids yet'}\n\n` +
        `⏰ Ends <t:${endsAt}:R>`
      )
      .setFooter({text:"Bully's World • Highest bid wins."}).setTimestamp();
    if (auction.image_url) embed.setImage(auction.image_url);
    const bidRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('auction.bid').setLabel(`🔨 Bid $${nextBid}`).setStyle(ButtonStyle.Success)
    );
    await msg.edit({ embeds: [embed], components: [bidRow] });
  } catch(e) { console.error('[Auction] Error updating embed:', e); }
}

// ─── FEATURE HELPERS ──────────────────────────────────────────────────────
function getCurrentLotteryWeek() {
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 1);
  const week = Math.ceil(((now - start) / 86400000 + start.getDay() + 1) / 7);
  return `${now.getFullYear()}-W${week}`;
}
function hasShield(userId) {
  const row = db.prepare('SELECT expires_at FROM shields WHERE user_id = ?').get(userId);
  if (!row) return false;
  return new Date(row.expires_at) > new Date();
}
// ─── BULLY'S CASINO ───────────────────────────────────────────────────────
async function openCasino() {
  const channel = await client.channels.fetch(CONFIG.CHANNELS.GENERAL).catch(()=>null);
  if (!channel) return;
  if (activeCasino) return;
  activeCasino = true;
  const expiresAt = Date.now() + 15 * 60 * 1000;
  const embed = new EmbedBuilder().setColor('#FFD700').setTitle(`🎰  BULLY'S CASINO IS OPEN!`)
    .setDescription(
      `The casino just opened. You have **15 minutes** to place your bets.\n\n` +
      `**How it works:**\n` +
      `• Bet any amount of Bully Bucks — max **500 BB** per bet\n` +
      `• 50/50 chance to **double your bet** or **lose it all**\n` +
      `• You can bet as many times as you want during the window\n\n` +
      `**To play:** Type **!bet [amount]** in this channel\n` +
      `Example: \`!bet 200\`\n\n` +
      `⏰ Closes <t:${Math.floor(expiresAt/1000)}:R>`
    )
    .setFooter({text:"Bully's Casino • High risk. High reward."}).setTimestamp();
  await channel.send({ content: '@everyone', embeds: [embed] });

}

async function runLottery() {
  const week = getCurrentLotteryWeek();
  const entries = db.prepare('SELECT * FROM lottery_tickets WHERE week = ?').all(week);
  if (!entries.length) {
    const channel = await client.channels.fetch(CONFIG.CHANNELS.GENERAL).catch(()=>null);
    if (channel) await channel.send('🎟️ No lottery entries this week. The pot rolls over to next week!');
    return;
  }
  const pool = [];
  entries.forEach(e => { for (let i = 0; i < e.tickets; i++) pool.push({ userId: e.user_id, username: e.username }); });
  const winner = pool[Math.floor(Math.random() * pool.length)];
  const totalPot = entries.reduce((sum, e) => sum + e.tickets * 30, 0);
  addBB(winner.userId, winner.username, totalPot, 'lottery winner');
  const channel = await client.channels.fetch(CONFIG.CHANNELS.GENERAL).catch(()=>null);
  if (channel) {
    const embed = new EmbedBuilder().setColor('#FFD700').setTitle('🎟️ WEEKLY LOTTERY WINNER!')
      .setDescription(`<@${winner.userId}> just won the weekly lottery!

**Prize: ${totalPot} BB**

That's ${pool.length} tickets worth of Bully Bucks going to one lucky winner.

New lottery starts now — type **!lottery** to buy tickets.`)
      .setFooter({ text: "Bully's World • You could be next." }).setTimestamp();
    const gamerPing = CONFIG.ROLES.GAMER ? `<@&${CONFIG.ROLES.GAMER}>` : '@here';
    await channel.send({ content: gamerPing, embeds: [embed] });
  }
  db.prepare('DELETE FROM lottery_tickets WHERE week = ?').run(week);
}

// ─── HEIST NARRATION ──────────────────────────────────────────────────────
const HEIST_ROLES = {
  driller:     { emoji: '🔧', label: 'The Driller',     desc: 'handles the technical work and breaking in' },
  lookout:     { emoji: '👀', label: 'The Lookout',     desc: 'watches for security and guards' },
  distraction: { emoji: '🎭', label: 'The Distraction', desc: 'creates diversions to buy the crew time' },
  mastermind:  { emoji: '💼', label: 'The Mastermind',  desc: 'calls the shots and coordinates the crew' },
  getaway:     { emoji: '🏃', label: 'The Getaway',     desc: 'handles the escape route' },
};

const HEIST_NARRATIONS = {
  "The Paint Heist": {
    roleLines: {
      driller:     ["{user} carefully cracks open the storage cabinet where the color palette is kept...", "{user} bypasses the lock on the supply room in record time...", "{user} dismantles the security panel protecting the palette collection...", "{user} picks the lock on the art studio door without making a sound...", "{user} cuts through the case holding the secret palette..."],
      lookout:     ["{user} keeps watch from the hallway, scanning for any movement...", "{user} monitors the security cameras from a stolen feed...", "{user} signals the crew from the window — coast is clear...", "{user} spots a guard making rounds and calls for a pause...", "{user} stays hidden in the shadows watching every angle..."],
      distraction: ["{user} causes a commotion in the lobby to draw attention away from the studio...", "{user} knocks over an easel in the next room — buying the crew 2 minutes...", "{user} pretends to be a gallery visitor asking too many questions...", "{user} pulls the fire alarm on the opposite side of the building...", "{user} distracts the assistant with a fake delivery at the front door..."],
      mastermind:  ["{user} coordinates the crew through earpieces — everyone moves on her signal...", "{user} had this planned down to the second — nothing is left to chance...", "{user} calls an audible when the route changes — the crew adjusts seamlessly...", "{user} keeps the crew calm and focused when the pressure rises...", "{user} mapped out every exit before the job even started..."],
      getaway:     ["{user} has the car running two blocks away, engine warm and ready...", "{user} mapped the fastest exit route three days in advance...", "{user} navigates through back streets to avoid the cameras...", "{user} keeps the engine running with the doors already open...", "{user} is already pulling up as the crew sprints out the door..."],
    },
    success: [
      "The palette is secured. Bully won't even know it's gone until the next live — and by then it's too late. The crew splits clean.",
      "In and out in under four minutes. The color palette is in the bag and the crew disappears into the night like it never happened.",
      "Nobody saw a thing. The palette is gone, the crew is gone, and Bully's next live just got a lot less colorful.",
      "Flawless execution. The secret colors are ours now. The crew walks away clean with no witnesses and no evidence.",
      "The job went perfectly. Bully's signature palette is in the crew's hands and the studio has no idea what hit them.",
    ],
    failure: [
      "The alarm trips at the last second. Security floods the studio and the crew scatters empty handed.",
      "Someone knocks over a paint can and the noise brings the whole place running. The crew barely escapes without the palette.",
      "The palette case was reinforced — the crew couldn't crack it in time and had to bail before getting caught.",
      "A studio assistant walks in at the worst possible moment. The crew abandons the mission and runs.",
      "The palette was already moved to a different location. The crew hit the wrong room and wasted their shot.",
    ],
    blame: [
      "Word is {user} hesitated at the critical moment. If they had moved faster the crew would have walked out clean.",
      "{user} took too long on their part of the job. That delay cost the whole crew their shot at the palette.",
      "Sources say {user} made a noise at the worst possible time. The whole job unraveled from that single mistake.",
      "{user} missed the signal. By the time they caught up the window had already closed.",
      "Everyone's pointing at {user}. Their fumble at the last second is what brought the whole operation down.",
    ],
  },
  "The Drip Raid": {
    roleLines: {
      driller:     ["{user} cuts through the warehouse loading dock lock in seconds...", "{user} bypasses the electronic security on the storage unit...", "{user} gets the back door open without triggering a single sensor...", "{user} dismantles the inventory lock system like it was nothing...", "{user} cracks the warehouse side entrance clean and quiet..."],
      lookout:     ["{user} scouts the warehouse perimeter for security patrols...", "{user} monitors the guard rotation from the roof...", "{user} radios in — the shift change is in three minutes, move now...", "{user} keeps eyes on the loading dock while the crew works...", "{user} spots a camera blind spot and routes the crew through it..."],
      distraction: ["{user} calls in a fake delivery to the front of the warehouse...", "{user} sets off a car alarm in the parking lot to pull security away...", "{user} poses as a vendor and ties up the manager in conversation...", "{user} creates a diversion at the shipping office while the crew slips in...", "{user} trips the motion sensor on the opposite side of the building deliberately..."],
      mastermind:  ["{user} had the warehouse floor plan memorized before the crew even arrived...", "{user} timed the guard rotations down to the second...", "{user} calls every move through the earpiece — the crew trusts her completely...", "{user} pivots the plan on the fly when the layout is different than expected...", "{user} keeps the crew on schedule when things start moving faster than planned..."],
      getaway:     ["{user} backs the van up to the loading dock right on cue...", "{user} has the route planned through every back road in the area...", "{user} keeps the engine running and the doors open — ready to roll the second the crew appears...", "{user} scouts the exit route twice before the job starts...", "{user} is already moving before the crew even hits the street..."],
    },
    success: [
      "The new drop is in the van and the warehouse doesn't even know it yet. The crew got out clean with the whole collection.",
      "Every piece of the unreleased drop is accounted for. The crew moves like ghosts through that warehouse and nobody saw a thing.",
      "The job went smoother than planned. The entire new drop is secured and the crew is long gone before the morning shift arrives.",
      "Flawless. The crew walks out with armfuls of unreleased apparel and the warehouse cameras caught nothing useful.",
      "The drop is ours. The crew executed perfectly and the new collection hits the streets before it was ever supposed to.",
    ],
    failure: [
      "A night security guard catches the crew in the inventory room. They drop everything and run.",
      "The drop was already moved to a different storage unit. The crew hit the wrong location and wasted their window.",
      "An inventory system triggers an alert the crew didn't account for. They barely get out before security responds.",
      "The warehouse had extra staff that night. The crew gets spotted before they can grab anything and has to abort.",
      "The van gets blocked in by a delivery truck at the worst possible time. The crew can't move the merchandise and has to leave it.",
    ],
    blame: [
      "{user} called the wrong storage unit. The whole crew hit an empty room because of that one mistake.",
      "Everyone agrees — {user} moved too slow when it counted. That hesitation is what triggered the alert.",
      "{user} missed the guard rotation by two minutes. If they had the timing right the crew walks out with everything.",
      "The crew is blaming {user} for the noise that tipped off security. One small mistake and the whole job fell apart.",
      "{user} took a wrong turn inside the warehouse. By the time the crew reoriented the window was already gone.",
    ],
  },
  "Bully's Kitchen": {
    roleLines: {
      driller:     ["{user} picks the kitchen lock without leaving a scratch...", "{user} disables the smart lock on the pantry door...", "{user} gets the back kitchen entrance open in under 20 seconds...", "{user} bypasses the keypad on the kitchen service door...", "{user} pops the lock on the refrigerator storage room without a sound..."],
      lookout:     ["{user} watches the dining room from the service corridor...", "{user} monitors the kitchen staff schedule from outside...", "{user} signals when the chef steps away from the stove...", "{user} keeps track of every person moving through the kitchen...", "{user} spots the sous chef heading back early and calls a warning..."],
      distraction: ["{user} calls in a fake reservation complaint to tie up the front of house...", "{user} causes a scene at the host stand to pull staff from the kitchen...", "{user} knocks on the delivery entrance on the far side to draw the chef out...", "{user} pretends to be a health inspector at the front door...", "{user} orders a complicated modification at the counter to keep the staff busy..."],
      mastermind:  ["{user} studied the kitchen layout and the schedule for three days straight...", "{user} times the whole job around the gap between prep and service...", "{user} coordinates every move through the earpiece with surgical precision...", "{user} adjusts the plan on the fly when an extra staff member shows up unexpectedly...", "{user} keeps the crew focused when the pressure in the kitchen starts rising..."],
      getaway:     ["{user} has the car idling in the alley behind the kitchen...", "{user} maps the fastest route out of the restaurant district...", "{user} times the exit perfectly with the shift change at the back entrance...", "{user} is parked at the service entrance ready to roll the second the plate is secured...", "{user} scouts two different exit routes just in case the first one gets cut off..."],
    },
    success: [
      "The plate is secured and the crew slips out the back before the next course hits the pass. The kitchen didn't even notice.",
      "In and out between courses. The plate is gone and the kitchen staff is still arguing about the reservation complaint up front.",
      "The crew moves through that kitchen like they own it. The plate is theirs and not a single soul saw it happen.",
      "Perfect timing. The chef turned around for thirty seconds and that was all the crew needed. The plate is secured.",
      "The most coveted plate is in the crew's hands. The kitchen is still in full service and nobody has a clue.",
    ],
    failure: [
      "The chef comes back from the walk-in at the worst possible time. The crew drops the plate and scatters.",
      "A line cook spots someone near the shelf and raises the alarm. The crew exits empty handed.",
      "The plate was already put away in a different location. The crew searched the whole kitchen and came up short.",
      "The kitchen was busier than expected. The crew never got a clean window and had to abort before anyone got caught.",
      "Someone on the crew knocks a pan off the counter. The whole kitchen turns around and the job is dead.",
    ],
    blame: [
      "{user} knocked something over at the worst possible moment. The noise gave the whole crew away.",
      "The crew is unanimous — {user} missed their cue. That one gap in timing is what brought the chef back early.",
      "{user} went to the wrong shelf. By the time anyone realized it the window had already closed.",
      "Everyone's blaming {user} for the timing error. The crew had one shot and that mistake cost them everything.",
      "{user} froze when the chef walked past. That hesitation is what unraveled the whole operation.",
    ],
  },
  "The Canvas Caper": {
    roleLines: {
      driller:     ["{user} disables the pressure sensors beneath the canvas frame...", "{user} cuts the alarm wire behind the painting without triggering a single sensor...", "{user} bypasses the gallery motion detection system in under a minute...", "{user} removes the security mounting from the frame with surgical precision...", "{user} gets the case open without leaving a trace of forced entry..."],
      lookout:     ["{user} monitors the gallery guard rotation from the mezzanine level...", "{user} watches the front entrance and feeds updates to the crew through earpieces...", "{user} tracks the security camera sweep and calls the timing for each move...", "{user} positions herself at the gallery entrance posing as a late visitor...", "{user} spots a second guard the crew didn't account for and reroutes everyone..."],
      distraction: ["{user} triggers a commotion in the adjacent gallery room to pull the guards away...", "{user} approaches a guard with questions about a different exhibit across the building...", "{user} sets off a sensor in the wrong wing to redirect the security response...", "{user} drops something loud in the gift shop to draw staff attention away from the main hall...", "{user} engages the night manager in a lengthy conversation about an upcoming exhibit..."],
      mastermind:  ["{user} had the security rotation mapped out before the crew ever set foot inside...", "{user} accounts for every camera angle and guard position in the heist plan...", "{user} calls every step through the earpiece — the crew moves like a single unit...", "{user} keeps the crew calm when the guard patrol comes closer than expected...", "{user} pivots the entire plan when the gallery layout turns out to be different than the blueprints..."],
      getaway:     ["{user} has the transport vehicle ready one block from the gallery exit...", "{user} mapped three different exit routes and knows which one to use at a moment's notice...", "{user} times the exit perfectly with the shift change at the rear entrance...", "{user} wraps the canvas for transport while the crew makes their way to the exit...", "{user} is already moving when the crew hits the street — doors open and engine running..."],
    },
    success: [
      "The canvas comes off the wall clean. The crew ghosts out of the gallery before the next patrol pass and the painting is never seen again.",
      "The most expensive piece in the collection is now in the crew's hands. The gallery won't even notice until morning.",
      "Flawless execution from start to finish. The canvas is secured and the security footage shows nothing useful.",
      "The crew pulls it off without a single alarm triggered. The painting leaves the gallery and nobody saw a thing.",
      "In and out in six minutes flat. The canvas is wrapped and loaded and the gallery is still running its normal patrol.",
    ],
    failure: [
      "The pressure sensors weren't fully disabled. The moment the canvas moves the alarm rings through the entire gallery.",
      "A guard makes an unscheduled pass at exactly the wrong moment. The crew abandons the canvas and disappears.",
      "The painting was moved to a secure storage room earlier that day. The crew hit an empty wall.",
      "The mounting system was more complex than the blueprints showed. The crew runs out of time and has to pull back.",
      "A late night visitor spots the crew near the painting and calls out. Security responds before the canvas is clear.",
    ],
    blame: [
      "{user} didn't fully cut the sensor wire. That partial connection is what triggered the alarm at the critical moment.",
      "The crew is pointing at {user} — the timing was off because of their delay and that's what cost everyone the painting.",
      "{user} misread the guard rotation. That one miscalculation brought security down on the crew right when it mattered most.",
      "Everyone agrees {user} moved too early. If they had waited three more seconds the guard would have been clear.",
      "{user} froze when the pressure was on. That hesitation gave the gallery just enough time to respond.",
    ],
  },
  "The Fourthwall Hack": {
    roleLines: {
      driller:     ["{user} intercepts the shipping manifest from the logistics system...", "{user} cracks the package tracking encryption in minutes...", "{user} bypasses the delivery verification system without leaving a trace...", "{user} gets into the courier's routing database and redirects the shipment...", "{user} spoofs the delivery confirmation to reroute the package to the crew's location..."],
      lookout:     ["{user} monitors the courier's GPS position in real time...", "{user} tracks the delivery truck from three cars back without being spotted...", "{user} watches the fulfillment center for any sign the reroute was detected...", "{user} keeps tabs on the logistics company's communication channels for any alerts...", "{user} scouts the package handoff point and confirms it's clear before the crew moves in..."],
      distraction: ["{user} files a fake delivery dispute to tie up the customer service team...", "{user} floods the tracking system with false queries to mask the reroute...", "{user} creates a support ticket storm that keeps the logistics team occupied...", "{user} calls in a fake warehouse emergency to pull staff away from the monitoring system...", "{user} generates a wave of fake shipping confirmations to bury the real alert..."],
      mastermind:  ["{user} planned the reroute three days in advance and left no digital fingerprints...", "{user} coordinates the crew's timing to match the exact window between scans...", "{user} accounts for every checkpoint in the delivery chain before the job begins...", "{user} adjusts the plan in real time when the truck takes an unexpected route...", "{user} keeps the crew synchronized across three different locations simultaneously..."],
      getaway:     ["{user} has a clean vehicle ready at the rerouted delivery point...", "{user} planned the extraction route to avoid every traffic camera in the area...", "{user} coordinates the final pickup so the package never sits unattended for more than thirty seconds...", "{user} has a second drop point ready in case the first location gets compromised...", "{user} moves the package twice before it reaches the final destination to break any trail..."],
    },
    success: [
      "The shipment is rerouted without a single flag in the system. The crew intercepts the package clean and the customer never gets a notification.",
      "The reroute executes perfectly. The apparel shipment is in the crew's hands before the delivery driver even knows something changed.",
      "The logistics system shows a clean delivery. In reality the package is with the crew and the trail goes cold immediately after.",
      "Flawless interception. The shipment disappears from the tracking system right on schedule and the crew walks away with everything.",
      "The crew pulls off the reroute without a single alert triggered. The package is secured and the system shows nothing unusual.",
    ],
    failure: [
      "The logistics company runs a verification check at exactly the wrong moment. The reroute gets flagged and reversed before the crew can intercept.",
      "The delivery driver uses a secondary tracking system the crew didn't account for. The shipment route stays locked and the crew comes up empty.",
      "A fraud detection algorithm flags the reroute within minutes. The crew loses access before the package ever reaches the interception point.",
      "The fulfillment center catches the manifest discrepancy during a routine check. The alert goes out and the crew has to abort.",
      "The package was already delivered before the reroute took effect. The crew intercepted an empty route.",
    ],
    blame: [
      "{user} missed a secondary verification layer in the logistics system. That oversight is what triggered the fraud flag.",
      "The crew blames {user} for the timing error. The reroute executed two minutes too late because of that delay.",
      "{user} left a trace in the tracking system. The logistics team followed it straight back to the interception point.",
      "Everyone's pointing at {user} — the distraction didn't hold long enough and that gap is what caused the alert.",
      "{user} accessed the wrong node in the routing system. That single mistake reversed the entire reroute automatically.",
    ],
  },
  "The Bully Bucks Vault": {
    roleLines: {
      driller:     ["{user} begins cracking the vault's six-digit combination by hand...", "{user} attaches the bypass device to the vault's electronic lock mechanism...", "{user} drills through the secondary lock plate with surgical precision...", "{user} works through the vault's three-layer security system layer by layer...", "{user} cracks the final tumbler and the vault door swings open..."],
      lookout:     ["{user} monitors every entrance to the BULLYLAND treasury from the security room...", "{user} loops the camera feed so the monitors show an empty corridor...", "{user} tracks the guard positions across the entire building in real time...", "{user} intercepts the security radio channel and listens for any response calls...", "{user} gives the crew a thirty second warning when the patrol approaches the vault room..."],
      distraction: ["{user} triggers a server room alert on the opposite side of the building to pull security away...", "{user} cuts the power to the east wing to force a response team away from the vault...", "{user} pulls the fire suppression system alarm in the administrative offices...", "{user} floods the security desk with simultaneous alerts across the building...", "{user} creates a full lockdown drill on the opposite floor — every guard responds..."],
      mastermind:  ["{user} spent two weeks mapping the BULLYLAND treasury security before the crew ever arrived...", "{user} coordinates the crew across four different positions simultaneously without missing a beat...", "{user} accounts for every guard, every camera and every response protocol in the plan...", "{user} adjusts the entire operation in real time when a guard pattern changes unexpectedly...", "{user} keeps the crew moving at exactly the right pace — not too fast, not too slow..."],
      getaway:     ["{user} has three separate escape routes planned and knows which one to use before the vault even opens...", "{user} coordinates the exit timing to match the exact window between patrol sweeps...", "{user} has the vehicle loaded and moving before the last crew member clears the building...", "{user} routes the crew through the one blind spot in the building's camera network...", "{user} has a clean safe house staged and ready fifteen minutes from the treasury..."],
    },
    success: [
      "The vault opens. The crew moves fast, cleans it out and disappears through the exit before the next patrol sweep. The BULLYLAND treasury is empty.",
      "Every last Bully Buck is in the crew's bags. The vault door swings shut behind them and the building has no idea what just happened.",
      "The biggest score in BULLYLAND history. The crew walks out of the treasury with everything and the security system logs show nothing.",
      "Flawless from start to finish. The vault is empty, the crew is gone and the only evidence is a clean room and a cracked combination.",
      "The crew executes the most ambitious heist in BULLYLAND's history without a single mistake. The treasury is cleaned out completely.",
    ],
    failure: [
      "The vault has a silent alarm the crew didn't find in the blueprints. Security floods the treasury room and the crew barely escapes empty handed.",
      "The vault door takes longer than planned to crack. By the time it opens the patrol is already on its way back and the crew has to run.",
      "A backup power system kicks on mid-heist and resets every lock in the building. The crew loses their window completely.",
      "The treasury was reinforced after the crew obtained the blueprints. Nothing the driller brought can get through the upgraded vault door.",
      "The heist runs perfectly until the final moment — a motion sensor inside the vault triggers when the door opens and the crew scatters.",
    ],
    blame: [
      "{user} underestimated the vault's upgraded security. That gap in intelligence is what shut the whole operation down.",
      "The crew is unanimous — {user}'s delay on the drill gave the patrol just enough time to circle back. That cost everyone everything.",
      "{user} missed the silent alarm in the pre-heist reconnaissance. If they had caught it the crew would have walked out rich.",
      "Everyone's blaming {user} for the timing breakdown. The window was there — {user} just didn't move fast enough to use it.",
      "{user} took the wrong exit route when the alarm triggered. The crew got separated and the whole operation collapsed from there.",
    ],
  },
};



function startScheduler() {
  schedule.scheduleJob('0 18 * * 0',   () => postMemberSpotlight());
  [{ d:'Monday',cron:'1'},{ d:'Wednesday',cron:'3'},{ d:'Saturday',cron:'6'}].forEach(({d,cron})=>{
    const h=Math.floor(Math.random()*14)+9, m=Math.floor(Math.random()*60);
    schedule.scheduleJob(`${m} ${h} * * ${cron}`, ()=>postMysteryDrop());
    console.log(`[Mystery Drop] ${d} at ${h}:${String(m).padStart(2,'0')}`);
  });
  schedule.scheduleJob({ rule:'0 10 * * *', tz:CONFIG.TIMEZONE }, ()=>{
    const delay = Math.floor(Math.random()*120);
    setTimeout(()=>postCheckin(), delay*60*1000);
    console.log(`[Check-in] Scheduled in ${delay} minutes`);
  });
  schedule.scheduleJob('0 */12 * * *', ()=>refreshShop(true));
  schedule.scheduleJob({ rule:'0 0 1 * *', tz:CONFIG.TIMEZONE }, ()=>doMonthlyReset());
  schedule.scheduleJob('0 */6 * * *', ()=>postDailyLeaderboard());
  postDailyLeaderboard(); // also post immediately on startup so it's never blank after a restart
  // Weekly lottery draw — Sunday at 8pm CT
  schedule.scheduleJob({ rule: '0 20 * * 0', tz: CONFIG.TIMEZONE }, () => runLottery());

  // Casino is always open — no scheduled windows needed
  schedule.scheduleJob({ rule:'0 12 24 1,4,7,10 *', tz:CONFIG.TIMEZONE }, ()=>postGiveawayOpening());
  // Treasure chest — Tuesday and Friday at random times between 12pm-8pm CT
  ['2', '5'].forEach(day => {
    const hour = Math.floor(Math.random() * 8) + 12;
    const min = Math.floor(Math.random() * 60);
    schedule.scheduleJob({ rule:`${min} ${hour} * * ${day}`, tz:CONFIG.TIMEZONE }, ()=>spawnTreasureChest());
    console.log(`[Treasure Chest] Scheduled for day ${day} at ${hour}:${String(min).padStart(2,'0')}`);
  });
  // One-time first giveaway opening — April 24th 2026
  const firstOpen = new Date('2026-04-24T12:00:00-05:00');
  if (firstOpen > new Date()) schedule.scheduleJob(firstOpen, ()=>postGiveawayOpening());
  // One-time first giveaway draw — May 1st 2026
  const firstDraw = new Date('2026-05-01T12:00:00-05:00');
  if (firstDraw > new Date()) schedule.scheduleJob(firstDraw, ()=>runGiveaway());
  schedule.scheduleJob({ rule:'0 12 1 2,5,8,11 *', tz:CONFIG.TIMEZONE }, ()=>runGiveaway());

  // Booster + Superfan Club weekly paychecks — every Friday at 12pm CT
  schedule.scheduleJob({ rule: '0 12 * * 5', tz: CONFIG.TIMEZONE }, async () => {
    console.log('[Scheduler] Running weekly Booster + Superfan payouts...');
    await runBoosterPayouts();
    await runSuperfanPayouts();
  });

  console.log('[Scheduler] All jobs started.');
}

// ─── BOOT ──────────────────────────────────────────────────────────────────
client.once('ready', async()=>{
  console.log(`\n✅ Bully's World Bot online as ${client.user.tag}`);
  activeCasino = true; // Casino is always open
  await setGiveawayChannelVisible(false);
  await refreshShop();
  startScheduler();
  dailyQ.init(client, db, addBB);

  // ── Startup env checks ────────────────────────────────────────────────────────
  if (!process.env.ROLE_SUPERFAN) console.warn('[⚠️  Config] ROLE_SUPERFAN is not set — Superfan weekly payouts are disabled. Add it in Railway → Variables.');
  if (!process.env.ROLE_BOOSTER)  console.warn('[⚠️  Config] ROLE_BOOSTER is not set — Booster weekly payouts are disabled. Add it in Railway → Variables.');

  // ── Neighborhood Watch: post channel button & reschedule any live votes ───────
  loadFeatureFlags();
  console.log('[GameController] Feature flags loaded:', Object.entries(FEATURE_FLAGS).map(([k,v]) => `${k}:${v?'ON':'OFF'}`).join(' '));

  try {
    await postNWChannelButton();
    const pendingNWReports = db.prepare("SELECT id, voting_ends_at FROM nw_reports WHERE status = 'voting'").all();
    for (const r of pendingNWReports) scheduleNWResolve(r.id, r.voting_ends_at);
    if (pendingNWReports.length) console.log(`[NW] Rescheduled ${pendingNWReports.length} pending vote(s).`);
  } catch (e) { console.error('[NW] Startup error:', e.message); }

  // ── Reload persisted scheduled auctions (survives bot restarts) ───────────────
  const pendingScheduled = db.prepare("SELECT * FROM auctions WHERE status = 'scheduled'").all();
  for (const auction of pendingScheduled) {
    const delay = Math.max(0, new Date(auction.scheduled_start).getTime() - Date.now());
    setTimeout(() => startScheduledAuction(auction.id), delay);
    console.log(`[Auction] Reloaded scheduled auction #${auction.id} "${auction.title}" — starts in ${Math.round(delay / 60000)} min`);
  }
  if (pendingScheduled.length) console.log(`[Auction] ${pendingScheduled.length} scheduled auction(s) reloaded.`);

  // Start analytics dashboard (Express) — available at your Railway URL
  try {
    startDashboard(db);
  } catch (e) {
    console.error('[Dashboard] Failed to start:', e.message);
  }

  // ── Bully Radio — 24/7 voice broadcast ────────────────────────────────────
  initRadio(client).catch(err => {
    console.error('[Radio] Fatal init error:', err.message);
  });

  // ── Register Stripe payment webhook callback ────────────────────────────────
  // Called by dashboard.js when a checkout.session.completed event is received
  setStripePaymentCallback(async (session) => {
    const { auction_id, winner_id } = session.metadata || {};
    if (!auction_id || !winner_id) return;

    // Update payment record to paid
    db.prepare(
      `UPDATE auction_payments SET status = 'paid', paid_at = ? WHERE stripe_session_id = ?`
    ).run(new Date().toISOString(), session.id);

    // Find the pending state for this session
    const pending = pendingAuctionPayments.get(session.id) || pendingAuctionPayments.get(winner_id);
    if (pending) {
      clearTimeout(pending.forfeitTimer);
      pendingAuctionPayments.delete(session.id);
      pendingAuctionPayments.delete(winner_id);
    }

    const auction = pending?.auction || db.prepare('SELECT * FROM auctions WHERE id = ?').get(parseInt(auction_id));
    const winMember = pending?.winMember || await (async () => {
      const guild = await client.guilds.fetch(CONFIG.GUILD_ID);
      return guild.members.fetch(winner_id).catch(() => null);
    })();
    const winnerUsername = pending?.winnerUsername || winner_id;
    const winningBid = pending?.winningBid || (session.amount_total / 100);

    // Notify admin
    const owner = await client.users.fetch(CONFIG.OWNER_ID).catch(() => null);
    if (owner) {
      await owner.send({ embeds: [new EmbedBuilder().setColor('#2ecc71')
        .setTitle('💰 Auction Payment Received!')
        .addFields(
          { name: '🎨 Item',    value: auction?.title || `Auction #${auction_id}`, inline: true },
          { name: '👤 Winner',  value: `${winnerUsername} (<@${winner_id}>)`,      inline: true },
          { name: '💵 Amount',  value: `$${winningBid.toFixed(2)}`,               inline: true },
        )
        .setFooter({ text: "Stripe confirmed • Shipping info collection started" }).setTimestamp()]
      }).catch(() => {});
    }

    // Notify winner and start shipping collection
    if (winMember && auction) {
      await startShippingCollection(auction, winner_id, winnerUsername, winningBid, winMember);
    } else {
      console.error('[Auction] Could not start shipping collection — missing member or auction data');
    }
  });
});


// ============================================================================
// AUTO-DELETE HELPERS
// ============================================================================
const autoDelete = (msg, ms = 8000) => { if (msg?.deletable !== false) setTimeout(() => msg?.delete().catch(() => {}), ms); };

// ============================================================================
// HORSE RACE RUNNER — with auto-cleanup of round messages
// ============================================================================
const _races = new Map();
let _raceN = 0;

// Returns the number of active games running in a given channel (trivia, hangman, heist, horse race)
function getActiveGameCount(channelId) {
  let count = 0;
  if (activeTrivia.has(channelId))  count++;
  if (activeHangman.has(channelId)) count++;
  for (const h of activeHeists.values()) {
    if ((h.channel?.id ?? h.channelId) === channelId) count++;
  }
  for (const r of _races.values()) {
    if (r.channelId === channelId && r.phase !== 'done') count++;
  }
  return count;
}
const MAX_GAMES_PER_CHANNEL = 2;

async function runHorseRace(rid, channel) {
  const race = _races.get(rid);
  if (!race || race.phase !== 'betting') return;
  race.phase = 'running';

  if (race.bets.size === 0) {
    _races.delete(rid);
    const msg = await channel.send(`🏇 Race #${rid} cancelled — no bets placed.`);
    autoDelete(msg, 10000);
    return;
  }

  const HORSES = race.horses;
  const rand = Math.random(); let cum = 0, winIdx = 0;
  for (let i = 0; i < HORSES.length; i++) { cum += HORSES[i].wc; if (rand < cum) { winIdx = i; break; } }
  const winner = HORSES[winIdx];
  const positions = HORSES.map((h, i) => ({ ...h, idx: i, prog: 0 }));

  const roundNarr = [
    ["And they're off!", "The gates fly open!", "The crowd goes wild!"],
    ["{w} takes an early lead!", "It's a tight pack!", "{w} surges ahead!"],
    ["{w} pulling ahead!", "Anything can happen!", "{w} makes a bold move!"],
    ["{w} is flying!", "{w} making up ground!", "{w} looks unstoppable!"],
    ["Down the final stretch!", "{w} refuses to give up!", "The crowd is on their feet!"],
  ];

  const roundMessages = [];

  // Send initiation message (KEEP this one)
  const initMsg = await channel.send({ embeds: [
    new EmbedBuilder().setColor('#c9a84c').setTitle(`🏇 Race #${rid} — OFF TO THE RACES!`)
      .setDescription(`${race.bets.size} bet${race.bets.size !== 1 ? 's' : ''} placed. 5 rounds of racing ahead. May the best horse win!`)
      .setFooter({ text: "Bully's Casino • Results posted when the race ends" })
  ]});

  for (let round = 1; round <= 5; round++) {
    await new Promise(r => setTimeout(r, 2000));
    const narr = roundNarr[round - 1][Math.floor(Math.random() * 3)].replace(/{w}/g, `${winner.emoji} ${winner.name}`);
    const track = positions.map(h => {
      const prog = Math.min(20, Math.round((round / 5) * 20 * (h.idx === winIdx ? 1.05 : (0.7 + Math.random() * 0.35))));
      h.prog = prog;
      return `${h.emoji} ${h.name.padEnd(15)} [${'▓'.repeat(prog)}${'░'.repeat(20 - prog)}]`;
    }).join('\n');
    const roundMsg = await channel.send({ embeds: [
      new EmbedBuilder().setColor('#c9a84c')
        .setTitle(`🏇 Race #${rid} — Round ${round}/5`)
        .setDescription(`*${narr}*

\`\`\`${track}\`\`\``)
        .setFooter({ text: "Bully's Casino • May the best horse win" })
    ]});
    roundMessages.push(roundMsg);
  }

  await new Promise(r => setTimeout(r, 2000));

  // Delete ALL round messages — only initiation + result stay
  await Promise.all(roundMessages.map(m => m.delete().catch(() => {})));

  // Build result
  const finishes = [
    `**${winner.emoji} ${winner.name}** crosses the finish line!`,
    `**${winner.emoji} ${winner.name}** wins by a nose!`,
    `**${winner.emoji} ${winner.name}** takes it in stunning fashion!`,
  ];
  const winLines = [];
  for (const [uid, entry] of race.bets) {
    if (entry.horseIdx === winIdx) {
      const payout = Math.round(entry.bet * winner.odds);
      db.prepare('UPDATE balances SET balance = balance + ?, total_earned = total_earned + ? WHERE user_id = ?').run(payout, payout, uid);
      winLines.push(`🎉 **${entry.username}** — bet ${entry.bet} BB → **+${payout} BB** (${winner.odds}x)`);
    }
  }

  await channel.send({ embeds: [
    new EmbedBuilder().setColor('#c9a84c')
      .setTitle(`🏇 Race #${rid} — FINAL RESULT`)
      .setDescription(`${finishes[Math.floor(Math.random() * 3)]}

**Winners:**
${winLines.length ? winLines.join('\n') : '💸 No one bet on the winner.'}`)
      .setFooter({ text: "Bully's Casino • Thanks for playing" })
  ]});

  _races.delete(rid);
}

// ============================================================================
// BUTTONS, CASINO, HEIST, SHOP
// ============================================================================

function makeBetRow(prefix, userBal) {
  return new ActionRowBuilder().addComponents(
    [25, 50, 75, 100].map(amt =>
      new ButtonBuilder().setCustomId(`${prefix}.${amt}`).setLabel(`${amt} BB`).setStyle(ButtonStyle.Primary).setDisabled(userBal < amt)
    )
  );
}

function casinoOpen(isAdmin) {
  if (isAdmin) return true;
  return !!activeCasino;
}

const _bj = new Map();
const _rl = new Map();

// ── Shop role purchase handler ───────────────────────────────────────────────
async function fulfillRolePurchase(interaction, userId, username, roleName, rarity, cost) {
  // Prevent concurrent purchases from the same user bypassing the 3-slot equip limit
  if (activeShopBuyers.has(userId)) {
    await interaction.reply({ content: '⏳ Your previous purchase is still processing. Try again in a moment.', ephemeral: true });
    return;
  }
  activeShopBuyers.add(userId);
  try {
  // Check if already owned
  if (ownsRole(userId, roleName)) {
    await interaction.reply({ content: `You already own **${roleName}**! Check your **!inventory**.`, ephemeral: true });
    return;
  }
  const u = getUser(userId, username);
  if (u.balance < cost) {
    await interaction.reply({ content: `❌ You need **${cost} BB** but only have **${u.balance} BB**.`, ephemeral: true });
    return;
  }
  spendBB(userId, cost);
  db.prepare('INSERT INTO shop_purchases (user_id, item_name, cost) VALUES (?, ?, ?)').run(userId, roleName, cost);

  // Add to inventory
  addToInventory(userId, roleName, rarity);

  // Auto-equip if slot available — re-read equipped count inside lock to prevent race
  const guild = await client.guilds.fetch(CONFIG.GUILD_ID);
  const mem = await guild.members.fetch(userId).catch(() => null);
  const equipped = getEquippedRoles(userId);
  let equipMsg = '';
  if (equipped.length < 3) {
    if (mem) await equipRole(mem, roleName, rarity, userId);
    equipMsg = ` Equipped automatically! (${equipped.length + 1}/3 slots)`;
  } else {
    // Added to inventory unequipped (addToInventory inserts with equipped=1, fix that)
    db.prepare('UPDATE role_inventory SET equipped = 0 WHERE user_id = ? AND role_name = ?').run(userId, roleName);
    equipMsg = ' Stored in inventory — use **!inventory** to equip it.';
  }

  const rarityColors = { Common: '#aaaaaa', Uncommon: '#57a8ff', Rare: '#cc44ff', Legendary: '#FFD700' };
  await interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor(rarityColors[rarity] || '#c9a84c')
      .setTitle('✅ Role Purchased!')
      .setDescription(`**${roleName}** [${rarity}] is now yours!${equipMsg}`)
      .setFooter({ text: "Bully's World • Wear it well." })
      .setTimestamp()
    ],
    ephemeral: true
  });
  } finally {
    activeShopBuyers.delete(userId); // Release purchase lock
  }
}

// !shop — handled in main message handler above

// !bullygames
client.on('messageCreate', async msg => {
  if (msg.author?.bot || !msg.guild) return;
  if (TESTING_MODE && !hasAccess(msg.member)) return;
  if (msg.content.trim().toLowerCase() !== '!bullygames') return;
  const _isAdmin = msg.member?.permissions.has(PermissionsBitField.Flags.Administrator);
  const GAME_CHANNELS = [CONFIG.CHANNELS.GAMES, CONFIG.CHANNELS.GAMES_2, CONFIG.CHANNELS.TESTING];
  if (!_isAdmin && !GAME_CHANNELS.includes(msg.channelId)) {
    const r = await msg.reply(`🎮 Games only run in <#${CONFIG.CHANNELS.GAMES}> or <#${CONFIG.CHANNELS.GAMES_2}>. Head over there!`);
    setTimeout(() => r.delete().catch(() => {}), 6000);
    await msg.delete().catch(() => {});
    return;
  }
  // Build game menu — disabled games show as greyed out for everyone
  const gmBtn = (id, label, style, flag) => {
    const off = !!(flag && !isEnabled(flag)); // always a real boolean — null would fail Discord API validation
    return new ButtonBuilder()
      .setCustomId(id)
      .setLabel(off ? `🔴 ${label.replace(/^\S+\s/, '')}` : label)
      .setStyle(off ? ButtonStyle.Secondary : style)
      .setDisabled(off);
  };
  const disabledList = ['heist','casino','lottery','trivia','hangman'].filter(f => !isEnabled(f));
  const statusNote  = disabledList.length ? `\n\n🔴 Currently unavailable: ${disabledList.map(f => f[0].toUpperCase() + f.slice(1)).join(', ')}` : '';
  const embed = new EmbedBuilder().setColor('#c9a84c').setTitle('🎮 BULLYLAND Games')
    .setDescription('**Welcome to the game room.** Pick a game below.\n\n⚔️ **Raid** — Team battles\n👹 **Boss Raid** — Legendary bosses\n🦹 **Heist** — Crew heists for BB\n🎰 **Casino** — Slots, Blackjack, Roulette, Horse Racing\n🎟️ **Lottery** — Weekly jackpot draw\n🧠 **Trivia** — Answer fast, earn BB\n🔤 **Hangman** — Guess the word together\n\n*Type `!help` for a full guide to earning, banking, and stealing.*' + statusNote)
    .setFooter({ text: "Bully's World" }).setTimestamp();
  const row1 = new ActionRowBuilder().addComponents(
    gmBtn('menu.raid',    '⚔️ Raid',     ButtonStyle.Primary,   null),
    gmBtn('menu.boss',    '👹 Boss Raid', ButtonStyle.Danger,    null),
    gmBtn('menu.heist',   '🦹 Heist',    ButtonStyle.Secondary, 'heist'),
    gmBtn('menu.casino',  '🎰 Casino',   ButtonStyle.Primary,   'casino'),
    gmBtn('menu.lottery', '🎟️ Lottery',  ButtonStyle.Primary,   'lottery'),
  );
  const row2 = new ActionRowBuilder().addComponents(
    gmBtn('menu.trivia',  '🧠 Trivia',   ButtonStyle.Success,   'trivia'),
    gmBtn('menu.hangman', '🔤 Hangman',  ButtonStyle.Success,   'hangman'),
  );
  await msg.reply({ embeds: [embed], components: [row1, row2] });
});

// ============================================================================
// TRIVIA — multi-round helpers
// ============================================================================
async function startTriviaRound(channel, state) {
  let trivia;
  try { trivia = await generateTriviaQuestion(state.catId); } catch {
    channel.send('❌ Couldn\'t fetch a trivia question. Ending game early.').catch(() => {});
    activeTrivia.delete(channel.id);
    gameCooldowns.set(state.cdKey, Date.now() + 5 * 60 * 1000);
    return;
  }
  state.question = trivia.question;
  state.options  = trivia.options;
  state.answer   = trivia.answer.toUpperCase();
  state.answered = new Map(); // reset each round

  const embed = new EmbedBuilder().setColor('#c9a84c')
    .setTitle(`🧠 ${state.catLabel} Trivia — Round ${state.roundNum} of ${state.totalRounds}`)
    .setDescription(
      `**${obfuscate(state.question)}**\n\n` +
      `🅰️  ${obfuscate(state.options.A)}\n` +
      `🅱️  ${obfuscate(state.options.B)}\n` +
      `🇨  ${obfuscate(state.options.C)}\n` +
      `🇩  ${obfuscate(state.options.D)}`
    )
    .setFooter({ text: `Lock in your answer — 15 seconds • Bully's World` }).setTimestamp();
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('trivia.a').setLabel('A').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('trivia.b').setLabel('B').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('trivia.c').setLabel('C').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('trivia.d').setLabel('D').setStyle(ButtonStyle.Secondary),
  );
  const triviaMsg = await channel.send({ embeds: [embed], components: [row] });
  state.messageId = triviaMsg.id;
  state.timeout = setTimeout(() => endTriviaRound(channel, state, triviaMsg), 15 * 1000);
}

async function endTriviaRound(channel, state, triviaMsg) {
  const { question, options, answer: correct, catLabel, roundNum, totalRounds, scores } = state;

  // Sort correct answers by timestamp — earliest = first correct
  const roundCorrect = [...state.answered.entries()]
    .filter(([, v]) => v.choice === correct)
    .sort(([, a], [, b]) => a.ts - b.ts);

  // Accumulate into game-wide score tracker
  roundCorrect.forEach(([uid, v], i) => {
    if (!scores.has(uid)) scores.set(uid, { username: v.username, corrects: 0, firsts: 0 });
    const s = scores.get(uid);
    s.corrects++;
    if (i === 0) s.firsts++;
  });

  const disabledRow = new ActionRowBuilder().addComponents(
    ['A', 'B', 'C', 'D'].map(l =>
      new ButtonBuilder()
        .setCustomId(`trivia_r${roundNum}_${l.toLowerCase()}`)
        .setLabel(l)
        .setStyle(l === correct ? ButtonStyle.Success : ButtonStyle.Secondary)
        .setDisabled(true)
    )
  );
  const roundLines = roundCorrect.length
    ? roundCorrect.map(([uid], i) => `${i === 0 ? '⚡ ' : ''}<@${uid}>${i === 0 ? ' — first!' : ''}`)
    : ['Nobody got it right.'];
  const moreRounds = roundNum < totalRounds;
  const roundEmbed = new EmbedBuilder()
    .setColor(roundCorrect.length ? '#2ecc71' : '#8B0000')
    .setTitle(`🧠 ${catLabel} — Round ${roundNum}/${totalRounds} Results`)
    .setDescription(`**${question}**\n\n🅰️  ${options.A}\n🅱️  ${options.B}\n🇨  ${options.C}\n🇩  ${options.D}`)
    .addFields({ name: `✅ Answer: ${correct} — ${options[correct]}`, value: roundLines.join('\n') })
    .setFooter({ text: moreRounds ? 'Next round in 5 seconds...' : 'Final round — tallying scores!' }).setTimestamp();
  await triviaMsg.edit({ embeds: [roundEmbed], components: [disabledRow] }).catch(() => {});

  if (moreRounds) {
    state.roundNum++;
    state.timeout = setTimeout(() => startTriviaRound(channel, state), 5000);
  } else {
    state.timeout = setTimeout(() => endTriviaGame(channel, state), 5000);
  }
}

// Trivia payouts scale with competition — solo play earns far less than a full lobby
// Max MVP payout per tier (5 questions): solo=30, small=75, medium=120, full=150
function getTriviaPayoutRates(playerCount) {
  if (playerCount <= 1) return { mvpBonus: 15,  mvpPerCorrect: 3,  otherPerCorrect: 3  }; // solo  — max 30 BB
  if (playerCount <= 3) return { mvpBonus: 50,  mvpPerCorrect: 5,  otherPerCorrect: 6  }; // 2–3   — max 75 BB
  if (playerCount <= 6) return { mvpBonus: 90,  mvpPerCorrect: 6,  otherPerCorrect: 9  }; // 4–6   — max 120 BB
  return                       { mvpBonus: 100, mvpPerCorrect: 10, otherPerCorrect: 10 }; // 7+    — max 150 BB
}

async function endTriviaGame(channel, state) {
  activeTrivia.delete(channel.id);
  gameCooldowns.set(state.cdKey, Date.now() + 5 * 60 * 1000);

  const allScores = [...state.scores.entries()];
  if (!allScores.length) {
    await channel.send({ embeds: [new EmbedBuilder().setColor('#8B0000')
      .setTitle(`🧠 ${state.catLabel} Trivia — Game Over`)
      .setDescription('Nobody scored across all 5 rounds. Better luck next time!')
      .setFooter({ text: "Bully's World" }).setTimestamp()] }).catch(() => {});
    return;
  }

  const playerCount = allScores.length;
  const { mvpBonus, mvpPerCorrect, otherPerCorrect } = getTriviaPayoutRates(playerCount);
  const maxFirsts = Math.max(...allScores.map(([, s]) => s.firsts));
  const payoutLines = [];
  for (const [uid, s] of allScores) {
    const isMvp = maxFirsts > 0 && s.firsts === maxFirsts;
    const bbEarned = isMvp ? mvpBonus + s.corrects * mvpPerCorrect : s.corrects * otherPerCorrect;
    if (bbEarned > 0) {
      addBB(uid, s.username, bbEarned, `trivia — ${state.catLabel} (${s.corrects} correct, ${s.firsts} firsts, ${playerCount} players)`);
      payoutLines.push(isMvp
        ? `🏆 <@${uid}> **+${bbEarned} BB** — ${s.corrects} correct, ${s.firsts} first${s.firsts !== 1 ? 's' : ''} *(${mvpBonus} BB bonus + ${s.corrects}×${mvpPerCorrect} BB)*`
        : `<@${uid}> **+${bbEarned} BB** — ${s.corrects} correct *(${s.corrects}×${otherPerCorrect} BB)*`
      );
    }
  }
  const finalEmbed = new EmbedBuilder().setColor('#FFD700')
    .setTitle(`🧠 ${state.catLabel} Trivia — 5 Rounds Complete!`)
    .setDescription(payoutLines.join('\n') || 'Nobody scored.')
    .setFooter({ text: "Bully's World" }).setTimestamp();
  await channel.send({ embeds: [finalEmbed] }).catch(() => {});
}

// ============================================================================
// SELF-ROLES
// ============================================================================

const SELF_ROLE_CHANNEL_ID = '1357645830462505080'; // 👀-introduce-yourself

const INTEREST_ROLES = [
  { id: '1497978868093419730', label: '🎮 Gamer',   value: 'gamer'   },
  { id: '1497978841082237110', label: '🍳 Cooking',  value: 'cooking' },
  { id: '1497978802477727905', label: '🖌️ Artist',   value: 'artist'  },
  { id: '1497978706042425574', label: '🍥 Anime',    value: 'anime'   },
  { id: '1497978671816773782', label: '🎵 Music',    value: 'music'   },
  { id: '1498193590332166185', label: '🍿 Movies',   value: 'movies'  },
];
const WATCH_ROLE_ID = '1494499384618909716'; // 👮 Neighborhood Watch

// Image files live in /assets — committed to the repo so Railway can serve them
const ASSET_DIR = path.join(__dirname, 'assets');

// Message 1a — Introduce Yourself banner (standalone image)
function buildInterestsBanner() {
  return { files: [{ attachment: path.join(ASSET_DIR, 'banner-introduce-yourself.png'), name: 'banner-introduce-yourself.png' }] };
}

// Message 1b — Interests embed + dropdown
function buildInterestsPanel() {
  const embed = new EmbedBuilder()
    .setColor('#c9a84c')
    .setDescription(
      "## 🎨  Choose Your Interests\n" +
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n" +
      "*Tell us who you are — pick the roles that match your vibe.*\n\n" +
      "**Select as many as you like** using the dropdown below.\n" +
      "You can come back and update them any time — nothing is permanent. 🙌"
    )
    .setFooter({ text: "Bully's World  •  roles update instantly" });

  const interestMenu = new StringSelectMenuBuilder()
    .setCustomId('selfrole_interests')
    .setPlaceholder('Choose Your Interests…')
    .setMinValues(0)
    .setMaxValues(INTEREST_ROLES.length)
    .addOptions(INTEREST_ROLES.map(r => ({ label: r.label, value: r.value })));

  return {
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(interestMenu)],
  };
}

// Message 2a — Neighborhood Watch banner (standalone image)
function buildWatchBanner() {
  return { files: [{ attachment: path.join(ASSET_DIR, 'banner-neighborhood-watch.png'), name: 'banner-neighborhood-watch.png' }] };
}

// Message 2b — Watch embed + toggle button
function buildWatchPanel() {
  const embed = new EmbedBuilder()
    .setColor('#c9a84c')
    .setDescription(
      "## 👮‍♀️  Neighborhood Watch\n" +
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n" +
      "*See something, say something.*\n\n" +
      "Help keep **Bully's World** a safe and welcoming space for everyone.\n" +
      "Members of the Watch look out for the community and report rule-breaking when they see it.\n\n" +
      "> **Click the button below to join or leave at any time.**"
    )
    .setFooter({ text: "Bully's World  •  Neighborhood Watch" });

  const watchBtn = new ButtonBuilder()
    .setCustomId('selfrole_watch')
    .setLabel('👮 Join the Neighborhood Watch')
    .setStyle(ButtonStyle.Success);

  return {
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(watchBtn)],
  };
}

// Separate interactionCreate listener so self-role logic is isolated
client.on('interactionCreate', async interaction => {

  // ── Neighborhood Watch — single-click toggle ─────────────────────────────
  if (interaction.isButton() && interaction.customId === 'selfrole_watch') {
    const has = interaction.member.roles.cache.has(WATCH_ROLE_ID);
    try {
      if (has) {
        await interaction.member.roles.remove(WATCH_ROLE_ID);
        await interaction.reply({ content: "👋 You've left the **Neighborhood Watch**.", flags: 64 });
      } else {
        await interaction.member.roles.add(WATCH_ROLE_ID);
        await interaction.reply({ content: "✅ You've joined the **Neighborhood Watch**! Thanks for helping keep Bully's World safe.", flags: 64 });
      }
    } catch {
      await interaction.reply({ content: '❌ Could not update your role — please let an admin know.', flags: 64 });
    }
    return;
  }

  // ── Interests dropdown ─────────────────────────────────────────────────────
  if (interaction.isStringSelectMenu() && interaction.customId === 'selfrole_interests') {
    const member = await interaction.member.fetch(); // fresh cache
    const selected = new Set(interaction.values);

    const toAdd    = INTEREST_ROLES.filter(r => selected.has(r.value)  && !member.roles.cache.has(r.id));
    const toRemove = INTEREST_ROLES.filter(r => !selected.has(r.value) &&  member.roles.cache.has(r.id));

    try {
      if (toAdd.length)    await member.roles.add(toAdd.map(r => r.id));
      if (toRemove.length) await member.roles.remove(toRemove.map(r => r.id));

      if (!toAdd.length && !toRemove.length) {
        await interaction.reply({ content: '✅ Your interest roles are already up to date!', flags: 64 });
      } else {
        const lines = [];
        if (toAdd.length)    lines.push(`➕ Added: ${toAdd.map(r => r.label).join('  ')}`);
        if (toRemove.length) lines.push(`➖ Removed: ${toRemove.map(r => r.label).join('  ')}`);
        await interaction.reply({ content: `✅ Roles updated!\n${lines.join('\n')}`, flags: 64 });
      }
    } catch {
      await interaction.reply({ content: '❌ Could not update your roles — please let an admin know.', flags: 64 });
    }
    return;
  }
});

// ============================================================================
// INTERACTION HANDLER
// ============================================================================
client.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;

  // ── Neighborhood Watch buttons bypass testing mode (DM interactions have no member) ──
  // ── Game Controller toggle ───────────────────────────────────────────────────
  if (interaction.customId.startsWith('gc_toggle.')) {
    const iAdm = interaction.member?.permissions?.has(PermissionsBitField.Flags.Administrator) || interaction.user.id === process.env.OWNER_ID;
    if (!iAdm) { await interaction.reply({ content: '❌ Admin only.', ephemeral: true }); return; }
    const feature = interaction.customId.split('.')[1];
    if (!(feature in FEATURE_FLAGS)) { await interaction.reply({ content: '❌ Unknown feature.', ephemeral: true }); return; }
    setFeature(feature, !FEATURE_FLAGS[feature]);
    await interaction.update(buildGameController());
    // Refresh shop channel immediately so the embed reflects the new state
    if (feature === 'shop') refreshShop().catch(console.error);
    return;
  }

  // ── Jail bail button ─────────────────────────────────────────────────────────
  if (interaction.customId.startsWith('jail_bail.')) {
    const targetId = interaction.customId.split('.')[1];
    if (interaction.user.id !== targetId) {
      await interaction.reply({ content: "That's not your jail card.", ephemeral: true }); return;
    }
    const jailRow = getJail(targetId);
    if (!jailRow) {
      await interaction.update({ embeds: [new EmbedBuilder().setColor('#3B6D11').setTitle('✅ Already Free').setDescription("You're no longer in jail.")], components: [] });
      return;
    }
    const bail = jailRow.bail_amount;
    const u = getUser(targetId, interaction.user.username);
    if (u.balance < bail) {
      await interaction.reply({ content: `❌ Not enough BB. You need **${bail.toLocaleString()} BB**, you have **${u.balance.toLocaleString()} BB**.`, ephemeral: true });
      return;
    }
    db.prepare('UPDATE balances SET balance = balance - ? WHERE user_id = ?').run(bail, targetId);
    db.prepare('INSERT INTO transactions (user_id, amount, reason) VALUES (?, ?, ?)').run(targetId, -bail, 'bail paid');
    db.prepare('DELETE FROM jail WHERE user_id = ?').run(targetId);
    await interaction.update({ embeds: [new EmbedBuilder()
      .setColor('#3B6D11')
      .setTitle('✅ Bail Paid — You\'re Free!')
      .setDescription(`You paid **${bail.toLocaleString()} BB** and walked out of jail.\n\nDon't let us see you back here. 👮`)
      .setFooter({ text: "Bully's World" }).setTimestamp()
    ], components: [] });
    return;
  }

  if (interaction.customId === 'nw_submit' ||
      interaction.customId.startsWith('nw_vote_') ||
      interaction.customId.startsWith('nw_vote_confirm.') ||
      interaction.customId.startsWith('nw_vote_back.') ||
      interaction.customId.startsWith('nw_appeal.') ||
      interaction.customId.startsWith('nw_mod_uphold.') ||
      interaction.customId.startsWith('nw_mod_overturn.')) {
    await handleNWInteraction(interaction).catch(e => console.error('[NW] Interaction error:', e.message));
    return;
  }

  if (TESTING_MODE && !hasAccess(interaction.member)) {
    await interaction.reply({ content: '🔒 Bot is in testing mode. You need the @tester role.', ephemeral: true }); return;
  }
  const { customId, user, channel } = interaction;
  const userId = user.id, username = user.username;
  const isAdmin = interaction.member?.permissions?.has(PermissionsBitField.Flags.Administrator) || userId === process.env.OWNER_ID;
  const getBal = () => db.prepare('SELECT balance FROM balances WHERE user_id = ?').get(userId)?.balance || 0;

  // Game interactions must happen in the games channel
  const GAME_CUSTOMS = ['menu.raid','menu.boss','menu.heist','menu.casino','menu.lottery','menu.trivia','menu.hangman'];
  const isGameInteraction = GAME_CUSTOMS.some(k => customId.startsWith(k)) ||
    customId.startsWith('raid.') || customId.startsWith('boss.') ||
    customId.startsWith('heist.') || customId.startsWith('casino.') ||
    customId.startsWith('lottery.') || customId.startsWith('slots.') ||
    customId.startsWith('bj.') || customId.startsWith('roulette.') || customId.startsWith('race.') ||
    customId.startsWith('trivia.') || customId.startsWith('hangman.');
  const ALLOWED_GAME_CHANNELS = [CONFIG.CHANNELS.GAMES, CONFIG.CHANNELS.GAMES_2, CONFIG.CHANNELS.TESTING];
  if (isGameInteraction && !ALLOWED_GAME_CHANNELS.includes(interaction.channelId)) {
    await interaction.reply({ content: `🎮 Games only run in <#${CONFIG.CHANNELS.GAMES}> or <#${CONFIG.CHANNELS.GAMES_2}>.`, ephemeral: true }); return;
  }

  try {

    // ── HELP TOPIC BUTTONS ────────────────────────────────────────────────────
    if (customId.startsWith('help.')) {
      const topic = customId.slice('help.'.length);
      let embed;
      if (topic === 'earning') {
        embed = new EmbedBuilder().setColor('#f1c40f').setTitle('💰 How to Earn Bully Bucks')
          .addFields(
            { name: '💬 Chat',         value: '**+5 BB** per message (5-second cooldown between rewards)', inline: false },
            { name: '📅 Daily Check-In', value: '**+25 BB** base · streak bonuses stack every 7 days\n⠀**0–6 days:** +25 BB\n⠀**7+ days:** +50 BB\n⠀**14+ days:** +100 BB\n⠀**21+ days:** +200 BB\n⠀**28+ days:** +400 BB', inline: false },
            { name: '🎮 Games',        value: 'Win BB through Trivia, Heists, Casino, Raids, and Lottery', inline: false },
            { name: '🎁 Events',       value: 'Bully gifts BB live on TikTok — redeem codes with `!redeem CODE`', inline: false },
            { name: '📌 Key Commands', value: '`!checkin` — daily reward\n`!balance` — see your BB\n`!history` — last 5 transactions', inline: false }
          )
          .setFooter({ text: "Bully's World • Consistency pays." }).setTimestamp();
      } else if (topic === 'banking') {
        const u = getUser(userId, username);
        const bankBal = u.bank_balance ?? 0;
        const { capacity, label } = getBankCapacity(interaction.member);
        const tierLines = BANK_LEVEL_ROLES.map(t => {
          const isCurrent = label === t.label;
          return `${isCurrent ? '▶️' : '◾'} **${t.label}** — ${t.capacity.toLocaleString()} BB${isCurrent ? '  ← *your tier*' : ''}`;
        }).join('\n');
        embed = new EmbedBuilder().setColor('#c9a84c').setTitle('🏦 Banking Guide')
          .setDescription(`Your bank protects BB from steals and counts toward the leaderboard. Capacity grows as you level up.\n\n**Your bank:** ${bankBal.toLocaleString()} / ${capacity.toLocaleString()} BB *(${label})*`)
          .addFields(
            { name: '📊 Tier Table', value: `> *(No role)* — locked until Rookie\n${tierLines}`, inline: false },
            { name: '💡 Commands',   value: '`!deposit [amount]` or `!deposit all`\n`!withdraw [amount]` or `!withdraw all`\n`!bank` — full guide in your DMs', inline: false },
            { name: '🔒 Why Bank?', value: '• BB in the bank **cannot be stolen**\n• Counts toward the **leaderboard ranking**\n• Level up by chatting + checking in daily', inline: false }
          )
          .setFooter({ text: "Bully's World • Protect your bag." }).setTimestamp();
      } else if (topic === 'games') {
        embed = new EmbedBuilder().setColor('#2ecc71').setTitle('🎮 Bully Games — Quick Guide')
          .setDescription('All games are in <#' + CONFIG.CHANNELS.GAMES + '> or <#' + CONFIG.CHANNELS.GAMES_2 + '>. Type `!bullygames` to open the menu.')
          .addFields(
            { name: '🎰 Casino',    value: 'Slots, Blackjack, Roulette, Horse Racing — bet BB and win big', inline: false },
            { name: '🦹 Heist',     value: 'Join a crew, pick a target, split the payout — or lose it all', inline: false },
            { name: '🧠 Trivia',    value: '5 rounds, 15 sec each · payouts scale with player count · MVP bonus goes to most first-answers · solo play earns the least', inline: false },
            { name: '🔤 Hangman',  value: 'Team up to guess the hidden word — one wrong letter at a time', inline: false },
            { name: '🎟️ Lottery',   value: 'Buy tickets weekly · more tickets = better odds · winner drawn each week', inline: false },
            { name: '📌 Tip',       value: 'Casino games auto-cancel after 5 min of inactivity. Use the **Cancel Bet** button if you get stuck.', inline: false }
          )
          .setFooter({ text: "Bully's World • May the odds be in your favor." }).setTimestamp();
      } else if (topic === 'stealing') {
        embed = new EmbedBuilder().setColor('#e74c3c').setTitle('🕵️ Stealing — Rules & Protections')
          .addFields(
            { name: '📋 How It Works', value: '`!steal @user [amount]` — attempt to steal BB from someone\nThe target gets a DM and has a short window to **block** it', inline: false },
            { name: '⏳ Cooldown',      value: 'You can only steal once every **3 minutes**', inline: false },
            { name: '🛡️ Who Is Protected?', value:
              '• Anyone with **25 BB or less** in their wallet — you lose **10 BB** for trying\n' +
              '• Anyone with an active **shield** (`!blackmarket` — 5,000 BB for 24h protection)\n' +
              '• Steal too many times and you may get caught (penalty up to 50% of the steal amount)',
              inline: false },
            { name: '⚠️ Risks',        value: '• Target can block it — you lose up to 50% of the attempt as penalty\n• Attempt against low-balance users = instant -10 BB fine\n• Going below -50 BB freezes your steal ability', inline: false },
            { name: '📌 Other Crime',  value: '`!heist` (via `!bullygames`) — organized crew robbery', inline: false }
          )
          .setFooter({ text: "Bully's World • Crime doesn't always pay." }).setTimestamp();
      } else if (topic === 'shop') {
        embed = new EmbedBuilder().setColor('#9b59b6').setTitle('🛒 Shop & Spending Guide')
          .addFields(
            { name: '🏪 Main Shop',    value: '`!shop` — browse collectible roles you can buy and equip\n**Requires Rookie rank** (Level 1+) to access', inline: false },
            { name: '🖤 Black Market', value: '`!blackmarket` — special items with unique abilities\n(Account Pull, Pocket Scan, Vault Key)', inline: false },
            { name: '🎁 Gift & Redeem', value: '`!gift @user [amount]` — send your own BB to someone\n`!redeem CODE` — redeem a stream event code for BB', inline: false },
            { name: '🏷️ Role Rarities', value:
              '⬜ **Common** — 750 BB\n' +
              '🟦 **Uncommon** — 1,250 BB\n' +
              '🟣 **Rare** — 2,000 BB\n' +
              '🟡 **Legendary** — 5,000 BB',
              inline: false },
            { name: '🎒 Inventory',    value: '`!inventory` — see your roles and equip/unequip them (max 3 equipped)', inline: false }
          )
          .setFooter({ text: "Bully's World • Spend wisely." }).setTimestamp();
      }
      if (embed) await interaction.reply({ embeds: [embed], ephemeral: true });
      return;
    }

    // ── ADMIN HELP TOPIC BUTTONS ──────────────────────────────────────────────
    if (customId.startsWith('admin.')) {
      if (!isAdmin) { await interaction.reply({ content: '🔒 Admin only.', ephemeral: true }); return; }
      const topic = customId.slice('admin.'.length);
      let embed;

      if (topic === 'bb') {
        embed = new EmbedBuilder().setColor('#e74c3c').setTitle('💰 BB Control')
          .addFields(
            { name: '🎯 Target a user', value:
              '`!gift @user [amount]` — gift BB to a specific user\n' +
              '`!adjust @user [amount]` — adjust by ± amount\n' +
              '`!set @user [amount]` — set exact balance\n' +
              '`!resetuser @user` — zero out balance + streak\n' +
              '`!balancecheck @user` — view any user\'s balance', inline: false },
            { name: '🌐 Mass gifts', value:
              '`!gifteveryone [amount]` — give BB to every server member\n' +
              '`!giveall [amount]` — give BB to every DB user *(requires confirm)*\n' +
              '`!giftall @role [amount]` — give BB to all members with a role\n' +
              '`!giverole @role [amount]` — alias of giftall\n' +
              '`!resetall` — zero everyone\'s balance *(requires confirm)*', inline: false },
            { name: '🧪 Self-test', value:
              '`!testgive [amount]` — add BB to yourself\n' +
              '`!testgive @user [amount]` — add BB to any user\n' +
              '`!testtake [amount]` — remove BB from yourself\n' +
              '`!testbalance` — check your own balance\n' +
              '`!testreset` — reset your own balance to 0', inline: false },
            { name: '🎟️ Codes', value:
              '`!createcode CODE [amount]` — create a stream event redeem code\n' +
              '`!gifttickets @user [amount]` — give giveaway tickets to a user', inline: false },
          ).setFooter({ text: 'Admin • BB Control' }).setTimestamp();

      } else if (topic === 'events') {
        embed = new EmbedBuilder().setColor('#e67e22').setTitle('📅 Events')
          .addFields(
            { name: '✅ Check-In', value: '`!testcheckin` — clear your own check-in cooldown so you can test it', inline: false },
            { name: '🛍️ Shop', value: '`!testshop` — force-refresh the shop now\n`!testshopview` — preview current shop lineup', inline: false },
            { name: '🎁 Mystery Drops', value:
              '`!testdrop` — trigger a mystery drop right now\n' +
              '`!pausedrops` — pause all scheduled drops\n' +
              '`!resumedrops` — resume drops\n' +
              '`!dropstatus` — check whether drops are active or paused', inline: false },
            { name: '🎟️ Lottery', value: '`!testlottery` — trigger the weekly lottery draw now', inline: false },
            { name: '🎰 Giveaway', value:
              '`!testgiveaway` — trigger giveaway draw now\n' +
              '`!testgiveawayopen` — open the giveaway channel\n' +
              '`!testgiveawayhide` — hide the giveaway channel', inline: false },
            { name: '📦 Treasure Chest', value: '`!testchest` — spawn a treasure chest now', inline: false },
            { name: '🌟 Member Spotlight', value: '`!testspotlight` — post a member spotlight now', inline: false },
            { name: '💬 Daily Q', value: '`!dailyq post` — post today\'s daily question now (includes quote + image)', inline: false },
          ).setFooter({ text: 'Admin • Events' }).setTimestamp();

      } else if (topic === 'games') {
        embed = new EmbedBuilder().setColor('#3498db').setTitle('🎮 Games')
          .addFields(
            { name: '🎰 Casino', value:
              '`!testcasino` — open casino right now\n' +
              '*Admins bypass casino hours automatically*', inline: false },
            { name: '🦹 Heists', value:
              '`!testheist [number]` — launch a specific heist with a dummy crew (use number 1–' + '10)\n' +
              '`!testheiststart` — force-start the currently recruiting heist\n' +
              '`!testheistcancel` — cancel active heist and refund all entry fees\n' +
              '*Admins bypass heist cooldowns automatically*', inline: false },
          ).setFooter({ text: 'Admin • Games' }).setTimestamp();

      } else if (topic === 'clubs') {
        embed = new EmbedBuilder().setColor('#2ecc71').setTitle('👥 Clubs')
          .addFields(
            { name: '💜 Booster Club', value:
              '`!boosterlist` — see all current server boosters\n' +
              '`!payboost` — manually run this week\'s booster payouts now\n' +
              '*New boosters are detected and paid automatically*', inline: false },
            { name: '🔥 Superfan Club', value:
              '`!superfan add @user` — grant Superfan status + send welcome DM + first paycheck\n' +
              '`!superfan remove @user` — remove Superfan status\n' +
              '`!superfan list` — see all current superfans\n' +
              '`!paysuperfan` — manually run this week\'s superfan payouts now\n' +
              '*Requires `ROLE_SUPERFAN` set in Railway env vars*', inline: false },
          ).setFooter({ text: 'Admin • Clubs' }).setTimestamp();

      } else if (topic === 'comms') {
        embed = new EmbedBuilder().setColor('#9b59b6').setTitle('📣 Comms')
          .addFields(
            { name: '📢 Announcements', value:
              '`!announcement` — guided flow: write text → pick channel → pick format → pick mention → set time → queued\n' +
              '`!announcementqueue` — view all queued announcements with IDs\n' +
              '`!cancelannouncement [id]` — cancel a queued announcement by ID', inline: false },
            { name: '✉️ DM Blasts', value:
              '`!dm` — guided flow: write message → pick recipients → set time → queued\n' +
              '`!dmqueue` — view all scheduled DM blasts with IDs\n' +
              '`!canceldm [id]` — cancel a queued DM blast by ID', inline: false },
          ).setFooter({ text: 'Admin • Comms' }).setTimestamp();

      } else if (topic === 'dailyq') {
        embed = new EmbedBuilder().setColor('#c9a84c').setTitle('🗓️ Daily Questionnaire')
          .addFields(
            { name: '▶️ Post & Close', value:
              '`!dailyq post` — force-post today\'s question right now\n' +
              '`!dailyq close` — force-close the active question right now', inline: false },
            { name: '🧪 Testing', value:
              '`!dailyq test` — post a live preview in THIS channel: 2-minute window, no BB awarded, no data saved', inline: false },
            { name: '📊 Stats', value:
              '`!dailyq stats` — show latest question, status, and response count\n' +
              '`!dailyq streaks` — show top 10 responders by current streak', inline: false },
            { name: 'ℹ️ Schedule', value: 'Auto-posts at **9:00 AM CT** · Closes at **9:00 PM CT** · Requires `CHANNEL_DAILYQ` in Railway', inline: false },
          ).setFooter({ text: 'Admin • Daily Q' }).setTimestamp();

      } else if (topic === 'auction') {
        embed = new EmbedBuilder().setColor('#f0a500').setTitle('🔨 Auction')
          .addFields(
            { name: '🚀 Running an auction', value:
              '`!auction start [title] | [description] | [image url]` — start a new auction\n' +
              '`!auction end` — end the active auction and pay out the winner\n' +
              '`!auction status` — check current auction details and top bid', inline: false },
            { name: '🛡️ Moderation', value:
              '`!auction unban @user` — remove an auction ban from a user\n' +
              '`!auction warnings @user` — view a user\'s auction warning count', inline: false },
          ).setFooter({ text: 'Admin • Auction' }).setTimestamp();

      } else if (topic === 'system') {
        embed = new EmbedBuilder().setColor('#7f8c8d').setTitle('🔧 System')
          .addFields(
            { name: '📊 Status', value: '`!adminstatus` — live snapshot: user count, BB in economy, casino/heist/shop state', inline: false },
            { name: '⚠️ Fun / Chaos', value: '`!disaster` — hits every server member for 75 BB with a random disaster announcement', inline: false },
            { name: '🔒 Testing Mode', value:
              '`!testingmode on` — restrict bot to admins + @tester role only\n' +
              '`!testingmode off` — open bot to everyone *(currently off by default)*', inline: false },
            { name: '🚧 Construction Zone', value:
              '`!servershutdown [time] ["msg"]` — lock server now or at a scheduled time\n' +
              '`!serverrestore` — restore access immediately\n' +
              '`!schedulerestore [time]` — schedule a restore at a specific time\n' +
              '`!cancelschedule` — cancel any pending shutdown or restore\n' +
              '`!constructionstatus` — view current construction zone state', inline: false },
          ).setFooter({ text: 'Admin • System' }).setTimestamp();
      }

      if (embed) await interaction.reply({ embeds: [embed], ephemeral: true });
      return;
    }

    // ── BLACK MARKET: buy button ──────────────────────────────────────────────
    if (customId.startsWith('bm_buy.')) {
      const itemId = customId.slice('bm_buy.'.length);
      const item = ITEMS[itemId];
      if (!item) { await interaction.reply({ content: '❌ Unknown item.', ephemeral: true }); return; }
      const u = getUser(userId, username);
      if (u.balance < item.price) { await interaction.reply({ content: `❌ Need **${item.price.toLocaleString()} BB**. You have **${u.balance.toLocaleString()} BB**.`, ephemeral: true }); return; }
      if (item.instant) {
        // Instant items (e.g. Shield) — activate directly, never enter user_items
        if (hasShield(userId)) { await interaction.reply({ content: '🛡️ You already have an active shield!', ephemeral: true }); return; }
        spendBB(userId, item.price);
        const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        db.prepare('INSERT OR REPLACE INTO shields (user_id, expires_at) VALUES (?, ?)').run(userId, expires);
        const expiresTs = Math.floor(new Date(expires).getTime() / 1000);
        await interaction.reply({ content: `🛡️ **Shield activated!** You're protected from steals for the next 24 hours.\n\nExpires <t:${expiresTs}:R>`, ephemeral: true });
        return;
      }
      if (getItemStacks(userId, itemId) >= item.stackLimit) { await interaction.reply({ content: `❌ Stack limit reached (${item.stackLimit}/${item.stackLimit}). Use your existing **${item.name}** first.`, ephemeral: true }); return; }
      spendBB(userId, item.price);
      db.prepare('INSERT INTO user_items (user_id, item_id, uses_remaining) VALUES (?, ?, ?)').run(userId, itemId, item.maxUses);
      await interaction.reply({ content: `✅ Purchased **${item.emoji} ${item.name}** — ${item.maxUses} use${item.maxUses>1?'s':''}. Check your DMs for instructions.`, ephemeral: true });
      await interaction.user.send(`${item.emoji} **${item.name}** — purchased!\n\n${item.description}\n\n**Uses remaining:** ${item.maxUses}\n\n**How to deploy:** Go to \`!blackmarket\`, press **Use ${item.name}**, and I'll DM you to select your target. Results are delivered here, privately.`).catch(() => {});
      return;
    }

    // ── BLACK MARKET: use button — prompts for target ─────────────────────────
    if (customId.startsWith('bm_use.')) {
      const itemId = customId.slice('bm_use.'.length);
      const item = ITEMS[itemId];
      if (!item) { await interaction.reply({ content: '❌ Unknown item.', ephemeral: true }); return; }
      if (getItemUses(userId, itemId) < 1) { await interaction.reply({ content: `❌ No uses of **${item.name}** remaining.`, ephemeral: true }); return; }
      const cdMs = itemCooldownRemaining(userId, itemId);
      if (cdMs > 0) { await interaction.reply({ content: `⏳ **${item.name}** is on cooldown — **${fmtCooldown(cdMs)}** remaining.`, ephemeral: true }); return; }
      // Initiate DM-based targeting flow
      try {
        await interaction.user.send(`${item.emoji} **${item.name}** ready to deploy.\n\nMention or type the username of your target below. Example: \`@username\`\n\nType **cancel** to abort.`);
        _pendingDMUse.set(userId, { itemId, guildId: interaction.guildId });
        await interaction.reply({ content: `${item.emoji} Check your DMs — I'll take your target there.`, ephemeral: true });
      } catch (_) {
        await interaction.reply({ content: `❌ I couldn't DM you. Please enable DMs from server members and try again.`, ephemeral: true });
      }
      return;
    }

    // ── TRIVIA: start ────────────────────────────────────────────────────────
    // ── TRIVIA: start ────────────────────────────────────────────────────────
    // ── TRIVIA: category picker ───────────────────────────────────────────────
    if (customId === 'menu.trivia') {
      if (!isEnabled('trivia')) { await interaction.reply({ content: '🧠 Trivia is currently **disabled**. Check back later.', ephemeral: true }); return; }
      const cid = interaction.channelId;
      if (activeTrivia.has(cid)) { await interaction.reply({ content: '🧠 A trivia game is already running in this channel!', ephemeral: true }); return; }
      if (getActiveGameCount(cid) >= MAX_GAMES_PER_CHANNEL) { await interaction.reply({ content: `⏳ **2 games are already running in this channel.** Wait for one to finish before starting another!`, ephemeral: true }); return; }
      const cdKey = `trivia.${cid}`;
      const cdLeft = (gameCooldowns.get(cdKey) || 0) - Date.now();
      if (cdLeft > 0) {
        const mins = Math.floor(cdLeft / 60000), secs = Math.ceil((cdLeft % 60000) / 1000);
        await interaction.reply({ content: `⏳ Trivia on cooldown — **${mins > 0 ? mins + 'm ' : ''}${secs}s** left.`, ephemeral: true }); return;
      }
      const catEmbed = new EmbedBuilder().setColor('#c9a84c').setTitle('🧠 BULLYLAND Trivia')
        .setDescription('Pick a category for your **5-round trivia game!**\n\n⏱️ **15 seconds** per question\n💰 **Payouts scale with competition** — the more players, the bigger the reward\n🏆 Most first-correct answers wins the **MVP bonus**\n👥 Solo play earns the least — bring competition!')
        .setFooter({ text: "Bully's World" }).setTimestamp();
      const catRow1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('trivia.cat.26').setLabel('🌟 Celebrities').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('trivia.cat.12').setLabel('🎵 Music').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('trivia.cat.14').setLabel('📺 TV Shows').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('trivia.cat.11').setLabel('🎬 Movies').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('trivia.cat.21').setLabel('🏆 Sports').setStyle(ButtonStyle.Primary),
      );
      const catRow2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('trivia.cat.9').setLabel('🧠 General Knowledge').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('trivia.cat.0').setLabel('🎲 Random').setStyle(ButtonStyle.Secondary),
      );
      await interaction.reply({ embeds: [catEmbed], components: [catRow1, catRow2] });
      return;
    }

    // ── TRIVIA: category selected — fetch question and start round ────────────
    if (customId.startsWith('trivia.cat.')) {
      const cid = interaction.channelId;
      if (activeTrivia.has(cid)) { await interaction.reply({ content: '🧠 A trivia game is already running!', ephemeral: true }); return; }
      const cdKey = `trivia.${cid}`;
      const cdLeft = (gameCooldowns.get(cdKey) || 0) - Date.now();
      if (cdLeft > 0) {
        const mins = Math.floor(cdLeft / 60000), secs = Math.ceil((cdLeft % 60000) / 1000);
        await interaction.reply({ content: `⏳ Trivia on cooldown — **${mins > 0 ? mins + 'm ' : ''}${secs}s** left.`, ephemeral: true }); return;
      }

      const TRIVIA_CATS = {
        '26': { label: '🌟 Celebrities',      id: 26 },
        '12': { label: '🎵 Music',             id: 12 },
        '14': { label: '📺 TV Shows',          id: 14 },
        '11': { label: '🎬 Movies',            id: 11 },
        '21': { label: '🏆 Sports',            id: 21 },
        '9':  { label: '🧠 General Knowledge', id: 9  },
        '0':  { label: '🎲 Random',            id: OPENTDB_CATEGORIES[Math.floor(Math.random() * OPENTDB_CATEGORIES.length)] },
      };
      const catKey = customId.slice('trivia.cat.'.length);
      const catInfo = TRIVIA_CATS[catKey] || TRIVIA_CATS['0'];

      await interaction.update({ content: `🧠 Starting **${catInfo.label}** trivia — 5 rounds!`, embeds: [], components: [] });

      const state = {
        catId:       catInfo.id,
        catLabel:    catInfo.label,
        cdKey,
        roundNum:    1,
        totalRounds: 5,
        messageId:   null,
        question:    null, options: null, answer: null,
        answered:    new Map(),
        scores:      new Map(), // userId → { username, corrects, firsts }
        timeout:     null,
      };
      activeTrivia.set(cid, state);
      await interaction.editReply({ content: `🧠 **${catInfo.label}** trivia is on! 5 rounds, 15 seconds each. Good luck!`, embeds: [], components: [] }).catch(() => {});
      await startTriviaRound(interaction.channel, state);
      return;
    }

    // ── TRIVIA: answer buttons — silent lock-in, no feedback on correctness ──
    if (['trivia.a','trivia.b','trivia.c','trivia.d'].includes(customId)) {
      const cid = interaction.channelId;
      const state = activeTrivia.get(cid);
      if (!state) { await interaction.reply({ content: '⏰ No active trivia game.', ephemeral: true }); return; }
      if (state.answered.has(userId)) { await interaction.reply({ content: '🔒 You already locked in an answer.', ephemeral: true }); return; }
      const chosen = customId.slice(-1).toUpperCase();
      state.answered.set(userId, { choice: chosen, username, ts: Date.now() });
      await interaction.reply({ content: `🤫 Answer locked in. Results drop when the timer ends.`, ephemeral: true });
      return;
    }

    // ── HANGMAN: category picker ──────────────────────────────────────────────
    if (customId === 'menu.hangman') {
      if (!isEnabled('hangman')) { await interaction.reply({ content: '🔤 Hangman is currently **disabled**. Check back later.', ephemeral: true }); return; }
      const cid = interaction.channelId;
      if (activeHangman.has(cid)) { await interaction.reply({ content: '🔤 A hangman game is already running in this channel!', ephemeral: true }); return; }
      if (getActiveGameCount(cid) >= MAX_GAMES_PER_CHANNEL) { await interaction.reply({ content: `⏳ **2 games are already running in this channel.** Wait for one to finish before starting another!`, ephemeral: true }); return; }
      const cdKey = `hangman.${cid}`;
      const cdLeft = (gameCooldowns.get(cdKey) || 0) - Date.now();
      if (cdLeft > 0) {
        const mins = Math.floor(cdLeft / 60000), secs = Math.ceil((cdLeft % 60000) / 1000);
        await interaction.reply({ content: `⏳ Hangman on cooldown — **${mins > 0 ? mins + 'm ' : ''}${secs}s** left.`, ephemeral: true }); return;
      }
      const catEmbed = new EmbedBuilder().setColor('#c9a84c').setTitle('🔤 Hangman — Pick a Category')
        .setDescription('Choose a category to start the round.\n\nYou have **3 minutes** to solve the word.\nCorrect letters: **+10 BB** each • Solver: **+100 BB**')
        .setFooter({ text: "Bully's World" }).setTimestamp();
      const hmCatRow1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('hangman.cat.artist').setLabel('🎵 Artist').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('hangman.cat.song').setLabel('🎶 Song Title').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('hangman.cat.tvshow').setLabel('📺 TV Show').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('hangman.cat.movie').setLabel('🎬 Movie').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('hangman.cat.athlete').setLabel('🏆 Athlete').setStyle(ButtonStyle.Primary),
      );
      const hmCatRow2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('hangman.cat.sneaker').setLabel('👟 Sneaker').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('hangman.cat.brand').setLabel('🏷️ Brand').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('hangman.cat.slang').setLabel('💬 Slang').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('hangman.cat.app').setLabel('📱 App').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('hangman.cat.words').setLabel('📝 Words & Phrases').setStyle(ButtonStyle.Primary),
      );
      const hmCatRow3 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('hangman.cat.random').setLabel('🎲 Random').setStyle(ButtonStyle.Secondary),
      );
      await interaction.reply({ embeds: [catEmbed], components: [hmCatRow1, hmCatRow2, hmCatRow3] });
      return;
    }

    // ── HANGMAN: category selected — start game ───────────────────────────────
    if (customId.startsWith('hangman.cat.')) {
      const cid = interaction.channelId;
      if (activeHangman.has(cid)) { await interaction.reply({ content: '🔤 A hangman game is already running!', ephemeral: true }); return; }
      const cdKey = `hangman.${cid}`;
      const slug = customId.slice('hangman.cat.'.length);
      const catInfo = HM_CATS[slug] || HM_CATS.random;

      await interaction.update({ content: `🔤 Loading **${catInfo.label}** hangman...`, embeds: [], components: [] });

      let hwData;
      try { hwData = generateHangmanWord(catInfo.filter); } catch {
        await interaction.editReply({ content: '❌ Failed to start hangman. Try again.', embeds: [], components: [] }); return;
      }

      const word = hwData.word.toUpperCase().replace(/[^A-Z ]/g, '');
      const state = {
        word, category: hwData.category, hint: hwData.hint,
        guessed: new Set(), wrong: new Set(),
        display: buildHangmanDisplay(word, new Set()),
        participants: new Map(),
        pendingGuess: new Map(),
        letterCooldowns: new Map(),
        solveAttempts: new Map(),
      };
      const hmRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('hangman.guess').setLabel('🔤 Guess Letter').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('hangman.solve').setLabel('🔍 Solve').setStyle(ButtonStyle.Success),
      );
      const hmEmbed = buildHangmanEmbed(state);
      const hmMsg = await interaction.channel.send({ embeds: [hmEmbed], components: [hmRow] });
      state.messageId = hmMsg.id;
      activeHangman.set(cid, state);
      await interaction.editReply({ content: `${catInfo.label} hangman started!`, embeds: [], components: [] }).catch(() => {});

      // Auto-end after 3 minutes
      state.timeout = setTimeout(async () => {
        const cur = activeHangman.get(cid);
        if (!cur || cur.messageId !== hmMsg.id) return;
        activeHangman.delete(cid);
        gameCooldowns.set(cdKey, Date.now() + 5 * 60 * 1000);
        const failEmbed = new EmbedBuilder().setColor('#8B0000').setTitle(`🔤 Hangman — Time's Up!`)
          .setDescription(`${HANGMAN_STAGES[6]}\n\n**The word was: ${cur.word}**`)
          .setFooter({ text: "Bully's World" }).setTimestamp();
        await hmMsg.edit({ embeds: [failEmbed], components: [] }).catch(() => {});
        await interaction.channel.send(`⏰ Time's up! The word was **${cur.word}**.`).catch(() => {});
      }, 3 * 60 * 1000);
      return;
    }

    // ── HANGMAN: guess letter button ─────────────────────────────────────────
    if (customId === 'hangman.guess') {
      const cid = interaction.channelId;
      const state = activeHangman.get(cid);
      if (!state) { await interaction.reply({ content: '❌ No active hangman game.', ephemeral: true }); return; }
      const cdLeft = (state.letterCooldowns.get(userId) || 0) - Date.now();
      if (cdLeft > 0) { await interaction.reply({ content: `⏳ You have **${Math.ceil(cdLeft/1000)}s** left on your cooldown. Wait before guessing again.`, ephemeral: true }); return; }
      state.pendingGuess.set(userId, 'letter');
      await interaction.reply({ content: `🔤 Your **next message** in this channel will be your letter guess. Type a single letter now.\n> ⏰ You'll have a **30-second cooldown** after each guess.`, ephemeral: true });
      return;
    }

    // ── HANGMAN: solve button ────────────────────────────────────────────────
    if (customId === 'hangman.solve') {
      const cid = interaction.channelId;
      const state = activeHangman.get(cid);
      if (!state) { await interaction.reply({ content: '❌ No active hangman game.', ephemeral: true }); return; }
      const usedSolves = state.solveAttempts.get(userId) || 0;
      if (usedSolves >= 2) { await interaction.reply({ content: `❌ You've used both of your solve attempts this game.`, ephemeral: true }); return; }
      state.pendingGuess.set(userId, 'solve');
      const remaining = 2 - usedSolves;
      await interaction.reply({ content: `🔍 Your **next message** in this channel will be your solve attempt. Type the full word or phrase now.\n> 🎯 You have **${remaining} solve attempt${remaining !== 1 ? 's' : ''}** remaining.`, ephemeral: true });
      return;
    }

    // ── SHOP: role buy button ─────────────────────────────────────────────────
    if (customId.startsWith('shopbuy_role.')) {
      if (!isEnabled('shop')) { await interaction.reply({ content: '🔒 The shop is currently closed.', ephemeral: true }); return; }
      const idx = parseInt(customId.split('.')[1]);
      const role = activeShopRoles[idx];
      if (!role) { await interaction.reply({ content: '❌ Role not found. The shop may have just refreshed — try **!shop** again.', ephemeral: true }); return; }
      const price = CONFIG.ROLE_PRICES[role.rarity] || CONFIG.ROLE_PRICES['Common'];
      await fulfillRolePurchase(interaction, userId, username, role.name, role.rarity, price);
      return;
    }

    // ── INVENTORY: equip button ───────────────────────────────────────────────
    if (customId.startsWith('inv_equip.')) {
      const b64 = customId.slice('inv_equip.'.length);
      const roleName = Buffer.from(b64, 'base64').toString('utf8');
      const owned = ownsRole(userId, roleName);
      if (!owned) { await interaction.reply({ content: `You don't own **${roleName}**.`, ephemeral: true }); return; }
      if (owned.equipped) { await interaction.reply({ content: `**${roleName}** is already equipped.`, ephemeral: true }); return; }
      const equipped = getEquippedRoles(userId);
      if (equipped.length >= 3) { await interaction.reply({ content: `You already have 3 roles equipped. Unequip one first.`, ephemeral: true }); return; }
      const guild = await client.guilds.fetch(CONFIG.GUILD_ID);
      const mem = await guild.members.fetch(userId).catch(() => null);
      if (mem) await equipRole(mem, roleName, owned.rarity, userId);
      await interaction.reply({ content: `✅ **${roleName}** equipped! (${equipped.length + 1}/3 slots)`, ephemeral: true });
      return;
    }

    // ── INVENTORY: unequip button ─────────────────────────────────────────────
    if (customId.startsWith('inv_unequip.')) {
      const b64 = customId.slice('inv_unequip.'.length);
      const roleName = Buffer.from(b64, 'base64').toString('utf8');
      const owned = ownsRole(userId, roleName);
      if (!owned) { await interaction.reply({ content: `You don't own **${roleName}**.`, ephemeral: true }); return; }
      if (!owned.equipped) { await interaction.reply({ content: `**${roleName}** is already unequipped.`, ephemeral: true }); return; }
      const guild = await client.guilds.fetch(CONFIG.GUILD_ID);
      const mem = await guild.members.fetch(userId).catch(() => null);
      if (mem) await unequipRole(mem, roleName, userId);
      const stillEquipped = getEquippedRoles(userId);
      await interaction.reply({ content: `📦 **${roleName}** unequipped and stored. You now have ${stillEquipped.length}/3 roles equipped.`, ephemeral: true });
      return;
    }

    // MAIN MENU
    if (customId === 'menu.lottery') {
      if (!isEnabled('lottery')) { await interaction.reply({ content: '🎟️ The lottery is currently **disabled**. Check back later.', ephemeral: true }); return; }
      const week = getCurrentLotteryWeek();
      const ex = db.prepare('SELECT * FROM lottery_tickets WHERE user_id = ? AND week = ?').get(userId, week);
      const owned = ex ? ex.tickets : 0;
      const u = getUser(userId, username);
      const pot = db.prepare('SELECT SUM(tickets) as t FROM lottery_tickets WHERE week = ?').get(week).t || 0;
      const makeBuyBtn = (qty) => {
        const cost = qty * 30;
        const canBuy = owned + qty <= 10 && u.balance >= cost;
        return new ButtonBuilder().setCustomId(`lottery_buy.${qty}`).setLabel(`${qty} ticket${qty !== 1 ? 's' : ''} — ${cost} BB`).setStyle(ButtonStyle.Primary).setDisabled(!canBuy);
      };
      const embed = new EmbedBuilder().setColor('#FFD700').setTitle('🎟️ Bully\'s World Lottery')
        .setDescription(`Tickets cost **30 BB each** · Max **10 per draw**\n\nYou have **${owned}/10 tickets** this week.\nCurrent pot: **${pot * 30} BB**\n\nDraw: Every Sunday at 8pm CT`)
        .setFooter({ text: "Bully's World • May the odds be in your favor." }).setTimestamp();
      const components = owned < 10
        ? [new ActionRowBuilder().addComponents(makeBuyBtn(1), makeBuyBtn(3), makeBuyBtn(5), makeBuyBtn(10))]
        : [];
      await interaction.reply({ embeds: [embed], components, ephemeral: true });
      return;
    }

    if (customId.startsWith('lottery_buy.')) {
      const qty = parseInt(customId.split('.')[1]);
      const week = getCurrentLotteryWeek();
      const ex = db.prepare('SELECT * FROM lottery_tickets WHERE user_id = ? AND week = ?').get(userId, week);
      const owned = ex ? ex.tickets : 0;
      if (owned + qty > 10) { await interaction.reply({ content: `❌ That would put you over the **10 ticket** limit. You have **${owned}** — you can buy up to **${10 - owned}** more.`, ephemeral: true }); return; }
      const u = getUser(userId, username);
      const cost = qty * 30;
      if (u.balance < cost) { await interaction.reply({ content: `❌ You need **${cost} BB** for ${qty} ticket${qty !== 1 ? 's' : ''}. You have **${u.balance} BB**.`, ephemeral: true }); return; }
      spendBB(userId, cost);
      if (ex) db.prepare('UPDATE lottery_tickets SET tickets = tickets + ? WHERE user_id = ? AND week = ?').run(qty, userId, week);
      else db.prepare('INSERT INTO lottery_tickets (user_id, username, tickets, week) VALUES (?, ?, ?, ?)').run(userId, username, qty, week);
      const newTotal = owned + qty;
      const pot = db.prepare('SELECT SUM(tickets) as t FROM lottery_tickets WHERE week = ?').get(week).t || 0;
      await interaction.reply({
        embeds: [new EmbedBuilder().setColor('#FFD700').setTitle('🎟️ Tickets Purchased!')
          .setDescription(`You bought **${qty} ticket${qty !== 1 ? 's' : ''}** for **${cost} BB**!\n\nYou now have **${newTotal}/10 tickets** this week.\nCurrent pot: **${pot * 30} BB**\n\nDraw: Every Sunday at 8pm CT`)
          .setFooter({ text: "Bully's World • May the odds be in your favor." }).setTimestamp()],
        ephemeral: true
      });
      return;
    }
    if (customId === 'menu.raid')    { await interaction.reply({ content: '⚔️ **Raids** coming soon!', ephemeral: true }); return; }
    if (customId === 'menu.boss')    { await interaction.reply({ content: '👹 **Boss Raids** coming soon!', ephemeral: true }); return; }

    // ── AUCTION BID BUTTON ────────────────────────────────────────────────────
    if (customId === 'auction.bid') {
      if (!activeAuction) { await interaction.reply({ content: '❌ There is no active auction right now.', ephemeral: true }); return; }
      const auction = db.prepare('SELECT * FROM auctions WHERE id = ? AND status = ?').get(activeAuction, 'active');
      if (!auction) { await interaction.reply({ content: '❌ No active auction found.', ephemeral: true }); return; }

      // Check blacklist
      const warningRow = db.prepare('SELECT * FROM auction_warnings WHERE user_id = ?').get(userId);
      if (warningRow?.blacklisted) { await interaction.reply({ content: '🚫 You are banned from participating in auctions.', ephemeral: true }); return; }

      // Already leading bidder
      if (auction.current_bidder_id === userId) { await interaction.reply({ content: "⚠️ You're already the highest bidder!", ephemeral: true }); return; }

      // First bid = starting bid exactly; subsequent bids = current + $5
      const newBid = auction.current_bid === null || auction.current_bid === undefined
        ? parseFloat((auction.starting_bid || 50).toFixed(2))
        : parseFloat((auction.current_bid + 5).toFixed(2));

      // Save previous bidder as runner-up
      const prevBidderId       = auction.current_bidder_id;
      const prevBidderUsername = auction.current_bidder_username;
      const prevBid            = auction.current_bid;

      db.prepare('UPDATE auctions SET current_bid = ?, current_bidder_id = ?, current_bidder_username = ?, second_bid = ?, second_bidder_id = ?, second_bidder_username = ? WHERE id = ?')
        .run(newBid, userId, username, prevBid, prevBidderId, prevBidderUsername, activeAuction);
      db.prepare('INSERT INTO auction_bids (auction_id, user_id, username, amount) VALUES (?, ?, ?, ?)').run(activeAuction, userId, username, newBid);

      const updatedAuction = db.prepare('SELECT * FROM auctions WHERE id = ?').get(activeAuction);
      await updateAuctionEmbed(updatedAuction);
      await interaction.reply({ content: `✅ Bid of **$${newBid.toFixed(2)}** placed! You are now the leading bidder.`, ephemeral: true });

      // Notify previous bidder they were outbid
      if (prevBidderId) {
        try {
          const guild = await client.guilds.fetch(CONFIG.GUILD_ID);
          const prevMember = await guild.members.fetch(prevBidderId).catch(()=>null);
          if (prevMember) await prevMember.send(`⚠️ You've been outbid on **${auction.title}**! The new leading bid is **$${newBid.toFixed(2)}**. Head to the auction channel to bid again.`).catch(()=>{});
        } catch {}
      }
      return;
    }

    // HEIST MENU
    if (customId === 'menu.heist') {
      if (!isEnabled('heist')) { await interaction.reply({ content: '🦹 Heists are currently **disabled**. Check back later.', ephemeral: true }); return; }
      if (activeHeists.size >= 3) { await interaction.reply({ content: '🦹 3 heists are already running! Wait for one to finish.', ephemeral: true }); return; }
      if (getActiveGameCount(interaction.channelId) >= MAX_GAMES_PER_CHANNEL) { await interaction.reply({ content: `⏳ **2 games are already running in this channel.** Wait for one to finish before starting another!`, ephemeral: true }); return; }
      if (heistSelectionPending.has(userId)) { await interaction.reply({ content: 'You already have a heist menu open!', ephemeral: true }); return; }
      if (!isAdmin) {
        const cd = db.prepare('SELECT last_heist FROM heist_cooldown WHERE user_id = ?').get(userId);
        if (cd) {
          const rem = 5 * 60 * 1000 - (Date.now() - new Date(cd.last_heist).getTime());
          if (rem > 0) { const m = Math.floor(rem / 60000), s = Math.ceil((rem % 60000) / 1000); await interaction.reply({ content: `⏳ Wait **${m > 0 ? m + 'm ' : ''}${s}s** before leading another heist.`, ephemeral: true }); return; }
        }
        const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
        const heistCount = db.prepare("SELECT COUNT(*) as c FROM heist_log WHERE user_id = ? AND created_at > ?").get(userId, sixHoursAgo);
        if (heistCount.c >= 5) { await interaction.reply({ content: "You've led **5 heists** in the last 6 hours.", ephemeral: true }); return; }
      }
      const memberRoles = interaction.member?.roles.cache;
      const heistMinRoles = [null, null, process.env.ROLE_ROOKIE, process.env.ROLE_VETERAN, process.env.ROLE_OG, process.env.ROLE_VIP];
      // Build per-heist availability: role-unlocked AND progression-unlocked (or admin)
      const heistList = HEISTS.map((h, i) => {
        const roleOk = isAdmin || !heistMinRoles[i] || memberRoles?.has(heistMinRoles[i]);
        const prevCompleted = isAdmin || i === 0 || !!db.prepare('SELECT 1 FROM heist_completions WHERE user_id = ? AND heist_index = ?').get(userId, i - 1);
        return { heist: h, index: i, roleOk, prevCompleted, canLead: roleOk && prevCompleted };
      });
      const roleNames = [null, null, 'Rookie', 'Veteran', 'OG', 'VIP'];
      const availableHeists = heistList.filter(e => e.canLead).map(e => e.heist);
      const heistDesc = heistList.map(e => {
        const lockReason = !e.roleOk ? `🔒 needs ${roleNames[e.index] || 'higher role'}` : !e.prevCompleted ? `🔒 complete ${HEISTS[e.index - 1].name} first` : null;
        return `**${e.index + 1}.** ${e.heist.name} — **${e.heist.entry} BB** · **${Math.round(e.heist.chance * 100)}%** · **${e.heist.payout} BB** payout\n*${e.heist.description}*${lockReason ? `\n${lockReason}` : ''}`;
      }).join('\n\n');
      const embed = new EmbedBuilder().setColor('#FF4500').setTitle('🦹 CHOOSE YOUR HEIST')
        .setDescription(`${heistDesc}\n\n*Anyone can join a heist. Only leaders need progression unlocked.*`)
        .setFooter({ text: "Bully's World • Choose wisely." }).setTimestamp();
      const rows = [];
      [availableHeists.slice(0, 3), availableHeists.slice(3, 6)].forEach((chunk, ri) => {
        if (!chunk.length) return;
        rows.push(new ActionRowBuilder().addComponents(chunk.map((h, ci) => new ButtonBuilder().setCustomId(`heist_sel.${ri * 3 + ci}`).setLabel(`${ri * 3 + ci + 1}. ${h.name}`).setStyle(ButtonStyle.Secondary))));
      });
      if (!availableHeists.length) { await interaction.reply({ content: '🔒 No heists available for you to lead yet. Complete lower-tier heists first or check your role level.', ephemeral: true }); return; }
      heistSelectionPending.set(userId, { username, channel: interaction.channel, availableHeists });
      setTimeout(() => heistSelectionPending.delete(userId), 60000);
      await interaction.reply({ embeds: [embed], components: rows, ephemeral: false });
      return;
    }

    // HEIST SELECT
    if (customId.startsWith('heist_sel.')) {
      if (!heistSelectionPending.has(userId)) { await interaction.reply({ content: '❌ This menu is not for you or has expired.', ephemeral: true }); return; }
      const idx = parseInt(customId.split('.')[1]);
      const pend = heistSelectionPending.get(userId);
      const { availableHeists, channel: hCh } = pend;
      if (idx >= availableHeists.length) { await interaction.reply({ content: '❌ Invalid selection.', ephemeral: true }); return; }
      const heist = availableHeists[idx];
      // Double-check progression (defence against stale menus)
      if (!isAdmin) {
        const heistIndex = HEISTS.indexOf(heist);
        if (heistIndex > 0 && !db.prepare('SELECT 1 FROM heist_completions WHERE user_id = ? AND heist_index = ?').get(userId, heistIndex - 1)) {
          await interaction.reply({ content: `❌ You need to successfully lead **${HEISTS[heistIndex - 1].name}** before you can lead this one.`, ephemeral: true }); return;
        }
      }
      const u = getUser(userId, username);
      if (u.balance < heist.entry) { await interaction.reply({ content: `❌ Need **${heist.entry} BB**. You have **${u.balance} BB**.`, ephemeral: true }); return; }
      spendBB(userId, heist.entry);
      heistSelectionPending.delete(userId);
      const heistId = ++_heistIdCounter;
      activeHeists.set(heistId, { id: heistId, heist, crew: [{ id: userId, username, role: 'mastermind' }], expiresAt: Date.now() + 2 * 60 * 1000, channel: hCh });
      db.prepare('INSERT OR REPLACE INTO heist_cooldown (user_id, last_heist) VALUES (?, ?)').run(userId, new Date().toISOString());
      db.prepare('INSERT INTO heist_log (user_id) VALUES (?)').run(userId);
      const endsAt = Math.floor((Date.now() + 2 * 60 * 1000) / 1000);
      const recruitEmbed = new EmbedBuilder().setColor('#FF4500').setTitle(`🦹 HEIST RECRUITING — ${heist.name}`)
        .setDescription(`*${heist.description}*

**Entry:** ${heist.entry} BB · **Success:** ${Math.round(heist.chance * 100)}% · **Payout:** ${heist.payout} BB split

**Crew (1/5):** ${username} 💼 Mastermind

Roles: 🔧 Driller · 👀 Lookout · 🎭 Distraction · 🏃 Getaway

Launches <t:${endsAt}:R> — click **Join** to pick your role!`)
        .setFooter({ text: "Bully's World • Click Join to pick your role." }).setTimestamp();
      const crewRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`heist_join.${heistId}`).setLabel('🦹 Join Heist').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`heist_start.${heistId}`).setLabel('▶️ Start Now').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`heist_cancel.${heistId}`).setLabel('❌ Cancel').setStyle(ButtonStyle.Danger),
      );
      const recruitMsg = await hCh.send({ content: '@here', embeds: [recruitEmbed], components: [crewRow] });
      heistMessageMap.set(heistId, [recruitMsg]);
      heistTimers.set(heistId, setTimeout(() => executeHeist(heistId, hCh), 2 * 60 * 1000));
      await interaction.reply({ content: `✅ **${heist.name}** started! **${heist.entry} BB** entry deducted.`, ephemeral: true });
      return;
    }

    // HEIST JOIN
    if (customId.startsWith('heist_join.')) {
      const heistId = parseInt(customId.split('.')[1]);
      const activeHeist = activeHeists.get(heistId);
      if (!activeHeist) { await interaction.reply({ content: '❌ This heist has ended or no longer exists.', ephemeral: true }); return; }
      if (activeHeist.crew.find(m => m.id === userId)) { await interaction.reply({ content: "You're already in this crew!", ephemeral: true }); return; }
      if (activeHeist.crew.length >= 5) { await interaction.reply({ content: 'Crew is full (5/5)!', ephemeral: true }); return; }
      // Jail check — jailed users cannot join heists
      if (!isAdmin) {
        const jailRowHeist = getJail(userId);
        if (jailRowHeist) {
          const releaseTs = Math.floor(new Date(jailRowHeist.release_at).getTime() / 1000);
          await interaction.reply({ content: `⛓️ You're in **jail** and can't join a heist.\nReleased <t:${releaseTs}:R> — or pay **${jailRowHeist.bail_amount.toLocaleString()} BB** bail with \`!bail\`.`, ephemeral: true });
          return;
        }
      }
      const u = getUser(userId, username);
      if (u.balance < activeHeist.heist.entry) { await interaction.reply({ content: `❌ Need **${activeHeist.heist.entry} BB** to join.`, ephemeral: true }); return; }
      const available = Object.entries(HEIST_ROLES).filter(([k]) => !activeHeist.crew.find(m => m.role === k));
      if (!available.length) { await interaction.reply({ content: 'All roles taken!', ephemeral: true }); return; }
      const roleRow = new ActionRowBuilder().addComponents(available.map(([k, r]) => new ButtonBuilder().setCustomId(`heist_role.${heistId}.${k}`).setLabel(`${r.emoji} ${r.label}`).setStyle(ButtonStyle.Secondary)));
      await interaction.reply({ content: '**Pick your role:**', components: [roleRow], ephemeral: true }); return;
    }

    // ── Heist challenge: Mastermind ─────────────────────────────────────────────────────────────────────────────
    if (customId.startsWith('hc_mm.')) {
      const [,hcHeistId,hcTarget,hcChoice] = customId.split('.');
      if (interaction.user.id !== hcTarget) { await interaction.reply({ content: "❌ That's not your challenge!", ephemeral: true }); return; }
      const hcs = heistChallengeState.get(parseInt(hcHeistId));
      if (!hcs) { await interaction.reply({ content: "⏱️ This challenge has expired.", ephemeral: true }); return; }
      const hcc = hcs.challenges.get(hcTarget);
      if (!hcc) { await interaction.reply({ content: "✅ Challenge already completed.", ephemeral: true }); return; }
      clearTimeout(hcc.timer); hcs.challenges.delete(hcTarget);
      const choice = hcc.data.scenario.choices[parseInt(hcChoice)];
      const score  = choice.score;
      const te = new EmbedBuilder().setColor(hcScoreColor(score)).setTitle("💼 MASTERMIND — RESULT")
        .setDescription(`<@${hcTarget}> chose: **${choice.label}**\n\n*${choice.feedback}*\n\n${hcScoreLabel(score)}`);
      await interaction.update({ embeds: [te], components: [] });
      hcc.resolve(score); return;
    }

    // ── Heist challenge: Driller ───────────────────────────────────────────────────────────────────────────────
    if (customId.startsWith('hc_drill.')) {
      const [,hcHeistId,hcTarget] = customId.split('.');
      if (interaction.user.id !== hcTarget) { await interaction.reply({ content: "❌ That's not your challenge!", ephemeral: true }); return; }
      const hcs = heistChallengeState.get(parseInt(hcHeistId));
      if (!hcs) { await interaction.reply({ content: "⏱️ This challenge has expired.", ephemeral: true }); return; }
      const hcc = hcs.challenges.get(hcTarget);
      if (!hcc) { await interaction.reply({ content: "✅ Challenge already completed.", ephemeral: true }); return; }
      clearTimeout(hcc.timer); clearInterval(hcc.data.interval); hcs.challenges.delete(hcTarget);
      const elapsed = Date.now() - hcc.data.startTime;
      const cfg     = hcc.data.cfg;
      const pos     = calcDrillerPos(elapsed, cfg.period, cfg.barWidth);
      const score   = scoreDrillerShot(pos, cfg.targetStart, cfg.targetEnd);
      const barStr  = renderDrillerBar(pos, cfg.targetStart, cfg.targetEnd, cfg.barWidth);
      const posLabel = pos >= cfg.targetStart && pos <= cfg.targetEnd ? "\ud83c\udfaf **IN THE ZONE!**" : `Position ${pos + 1} (zone: ${cfg.targetStart + 1}\u2013${cfg.targetEnd + 1})`;
      const te = new EmbedBuilder().setColor(hcScoreColor(score)).setTitle("🔧 DRILLER — RESULT")
        .setDescription(`<@${hcTarget}> \u2014 ${posLabel}\n\n${barStr}\n\n${hcScoreLabel(score)}`);
      await interaction.update({ embeds: [te], components: [] });
      hcc.resolve(score); return;
    }

    // ── Heist challenge: Lookout ──────────────────────────────────────────────────────────────────────────────
    if (customId.startsWith('hc_look.')) {
      const parts2 = customId.split('.');
      const hcHeistId = parts2[1], hcTarget = parts2[2], hcCorrect = parts2[3] === '1';
      if (interaction.user.id !== hcTarget) { await interaction.reply({ content: "❌ That's not your challenge!", ephemeral: true }); return; }
      const hcs = heistChallengeState.get(parseInt(hcHeistId));
      if (!hcs) { await interaction.reply({ content: "⏱️ This challenge has expired.", ephemeral: true }); return; }
      const hcc = hcs.challenges.get(hcTarget);
      if (!hcc) { await interaction.reply({ content: "✅ Challenge already completed.", ephemeral: true }); return; }
      clearTimeout(hcc.timer); hcs.challenges.delete(hcTarget);
      const score = hcCorrect ? 2 : -1;
      const te = new EmbedBuilder().setColor(hcScoreColor(score)).setTitle("👀 LOOKOUT — RESULT")
        .setDescription(`<@${hcTarget}> ${hcCorrect ? `identified **${hcc.data.correctAnswer}** correctly!` : `picked wrong. (Correct: **${hcc.data.correctAnswer}**)`}\n\n${hcScoreLabel(score)}`);
      await interaction.update({ embeds: [te], components: [] });
      hcc.resolve(score); return;
    }

    // ── Heist challenge: Getaway ──────────────────────────────────────────────────────────────────────────────
    if (customId.startsWith('hc_gw.')) {
      const [,hcHeistId,hcTarget,hcChoice] = customId.split('.');
      if (interaction.user.id !== hcTarget) { await interaction.reply({ content: "❌ That's not your challenge!", ephemeral: true }); return; }
      const hcs = heistChallengeState.get(parseInt(hcHeistId));
      if (!hcs) { await interaction.reply({ content: "⏱️ This challenge has expired.", ephemeral: true }); return; }
      const hcc = hcs.challenges.get(hcTarget);
      if (!hcc) { await interaction.reply({ content: "✅ Challenge already completed.", ephemeral: true }); return; }
      clearTimeout(hcc.timer); hcs.challenges.delete(hcTarget);
      const choice = hcc.data.scenario.choices[parseInt(hcChoice)];
      const score  = choice.score;
      const te = new EmbedBuilder().setColor(hcScoreColor(score)).setTitle("🏃 GETAWAY — RESULT")
        .setDescription(`<@${hcTarget}> chose: **${choice.label}**\n\n*${choice.feedback}*\n\n${hcScoreLabel(score)}`);
      await interaction.update({ embeds: [te], components: [] });
      hcc.resolve(score); return;
    }

    // HEIST ROLE
    if (customId.startsWith('heist_role.')) {
      const parts = customId.split('.');
      const heistId = parseInt(parts[1]);
      const role = parts[2];
      const activeHeist = activeHeists.get(heistId);
      if (!activeHeist) { await interaction.reply({ content: '❌ This heist has ended.', ephemeral: true }); return; }
      if (activeHeist.crew.find(m => m.id === userId)) { await interaction.reply({ content: "You're already in this crew!", ephemeral: true }); return; }
      if (activeHeist.crew.find(m => m.role === role)) { await interaction.reply({ content: 'Role taken! Pick another.', ephemeral: true }); return; }
      const u = getUser(userId, username);
      if (u.balance < activeHeist.heist.entry) { await interaction.reply({ content: `❌ Need **${activeHeist.heist.entry} BB** to join.`, ephemeral: true }); return; }
      spendBB(userId, activeHeist.heist.entry);
      activeHeist.crew.push({ id: userId, username, role });
      const rd = HEIST_ROLES[role];
      const heistCh = activeHeist.channel || channel;
      const joinMsg = await heistCh.send(`${rd.emoji} **${username}** joined as **${rd.label}**! (${activeHeist.crew.length}/5)`);
      const msgs = heistMessageMap.get(heistId) || [];
      msgs.push(joinMsg);
      heistMessageMap.set(heistId, msgs);
      await interaction.reply({ content: `✅ Joined as **${rd.label}**! Entry fee deducted.`, ephemeral: true });
      if (activeHeist.crew.length === 5) {
        const fullMsg = await heistCh.send({ embeds: [new EmbedBuilder().setColor('#c9a84c').setTitle('🦹 CREW IS FULL — 5/5').setDescription("Everyone's in. Leader can click **▶️ Start Now** or wait for the timer.").setTimestamp()] });
        msgs.push(fullMsg);
      }
      return;
    }

    // HEIST START
    if (customId.startsWith('heist_start.')) {
      const heistId = parseInt(customId.split('.')[1]);
      const activeHeist = activeHeists.get(heistId);
      if (!activeHeist) { await interaction.reply({ content: '❌ This heist has ended.', ephemeral: true }); return; }
      if (activeHeist.crew[0]?.id !== userId && !isAdmin) { await interaction.reply({ content: '❌ Only the leader can start early.', ephemeral: true }); return; }
      if (activeHeist.crew.length < 2) { await interaction.reply({ content: '❌ Need at least 2 crew members.', ephemeral: true }); return; }
      const t = heistTimers.get(heistId);
      if (t) { clearTimeout(t); heistTimers.delete(heistId); }
      await interaction.reply({ content: '🚀 Launching the heist!', ephemeral: true });
      await executeHeist(heistId, activeHeist.channel || channel); return;
    }

    // HEIST CANCEL
    if (customId.startsWith('heist_cancel.')) {
      const heistId = parseInt(customId.split('.')[1]);
      const activeHeist = activeHeists.get(heistId);
      if (!activeHeist) { await interaction.reply({ content: '❌ This heist has ended.', ephemeral: true }); return; }
      if (activeHeist.crew[0]?.id !== userId && !isAdmin) { await interaction.reply({ content: '❌ Only the leader can cancel.', ephemeral: true }); return; }
      activeHeist.crew.forEach(m => addBB(m.id, m.username, activeHeist.heist.entry, 'heist cancelled — refund'));
      const t = heistTimers.get(heistId);
      if (t) { clearTimeout(t); }
      const name = activeHeist.heist.name;
      activeHeists.delete(heistId);
      heistTimers.delete(heistId);
      const heistCh = activeHeist.channel || channel;
      await cleanupHeistMessages(heistId);
      await heistCh.send(`🚫 **${name}** cancelled. All entry fees refunded.`);
      await interaction.reply({ content: '✅ Cancelled and refunded.', ephemeral: true }); return;
    }

    // CASINO
    if (customId === 'menu.casino') {
      if (!isEnabled('casino')) { await interaction.reply({ content: '🎰 The casino is currently **disabled**. Check back later.', ephemeral: true }); return; }
      if (!casinoOpen(isAdmin)) { await interaction.reply({ content: "🎰 **Bully's Casino is closed right now.** Watch #general for the opening announcement!", ephemeral: true }); return; }
      const bal = getBal();
      const r1 = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('cas.slots').setLabel('🎰 Slots').setStyle(ButtonStyle.Primary), new ButtonBuilder().setCustomId('cas.blackjack').setLabel('🃏 Blackjack').setStyle(ButtonStyle.Success));
      const r2 = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('cas.roulette').setLabel('🎡 Roulette').setStyle(ButtonStyle.Danger), new ButtonBuilder().setCustomId('cas.horse').setLabel('🏇 Horse Racing').setStyle(ButtonStyle.Primary));
      const r3 = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('cas.cancelbet').setLabel('🚪 Cancel Stuck Bet').setStyle(ButtonStyle.Secondary));
      await interaction.reply({ embeds: [new EmbedBuilder().setColor('#c9a84c').setTitle("🎰 Bully's Casino").setDescription(`Balance: **${bal.toLocaleString()} BB**

Choose your game:`).setFooter({ text: "Bully's Casino • Bets: 25, 50, 75, 100 BB • Use 'Cancel Stuck Bet' if a game won't clear" })], components: [r1, r2, r3], ephemeral: true }); return;
    }

    // CANCEL STUCK BET
    if (customId === 'cas.cancelbet') {
      const hadBJ = _bj.has(userId), hadRL = _rl.has(userId);
      if (hadBJ) { clearTimeout(_bj.get(userId)?.autoForfeit); _bj.delete(userId); }
      if (hadRL) _rl.delete(userId);
      if (hadBJ || hadRL) {
        await interaction.reply({ content: `✅ Your stuck casino session has been cleared.\n⚠️ Note: **any BB already deducted for a blackjack bet is forfeited.** Use the 🚪 Forfeit button inside the game next time to exit cleanly.`, ephemeral: true });
      } else {
        await interaction.reply({ content: `ℹ️ You don't have any stuck casino bet to clear.`, ephemeral: true });
      }
      return;
    }

    // SLOTS
    if (customId === 'cas.slots') {
      if (!casinoOpen(isAdmin)) { await interaction.reply({ content: "🎰 Casino is closed!", ephemeral: true }); return; }
      await interaction.reply({ embeds: [new EmbedBuilder().setColor('#c9a84c').setTitle('🎰 Slots — Choose Bet').setDescription(`Balance: **${getBal().toLocaleString()} BB** · Win **2x**`).setFooter({ text: "Bully's Casino • Pure luck" })], components: [makeBetRow('cas_slots', getBal())], ephemeral: true }); return;
    }
    if (customId.startsWith('cas_slots.')) {
      const bet = parseInt(customId.split('.')[1]), bal = getBal();
      if (bal < bet) { await interaction.reply({ content: `❌ Need **${bet} BB**.`, ephemeral: true }); return; }
      const won = Math.random() < 0.5;
      if (won) db.prepare('UPDATE balances SET balance = balance + ?, total_earned = total_earned + ? WHERE user_id = ?').run(bet, bet, userId);
      else db.prepare('UPDATE balances SET balance = balance - ? WHERE user_id = ?').run(bet, userId);
      const reels = ['🍒', '🍋', '🔔', '💎', '7️⃣', '🍊'], r = () => reels[Math.floor(Math.random() * reels.length)];
      const display = won ? `${reels[0]} ${reels[0]} ${reels[0]}` : `${r()} ${r()} ${r()}`;
      await interaction.reply({ embeds: [new EmbedBuilder().setColor(won ? '#3B6D11' : '#8B0000').setTitle(won ? '🎰 YOU WON!' : '🎰 No luck.').setDescription(`[ ${display}${won ? ' ← MATCH!' : ''} ]

${won ? `🎉 **+${bet} BB**` : `💸 **-${bet} BB**`}
Balance: **${getBal().toLocaleString()} BB**`).setFooter({ text: won ? "Bully's Casino • Luck is on your side" : "Bully's Casino • The house wins this time" })], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('cas.slots').setLabel('🎰 Play Again').setStyle(ButtonStyle.Primary), new ButtonBuilder().setCustomId('menu.casino').setLabel('↩️ Casino Menu').setStyle(ButtonStyle.Secondary))], ephemeral: true }); return;
    }

    // BLACKJACK
    if (customId === 'cas.blackjack') {
      if (!casinoOpen(isAdmin)) { await interaction.reply({ content: "🎰 Casino is closed!", ephemeral: true }); return; }
      // If user has a stuck game, RESUME it instead of blocking them forever
      if (_bj.has(userId)) {
        const g = _bj.get(userId);
        const pv = g.hV(g.player), canDbl = getBal() >= g.bet;
        await interaction.reply({ embeds: [new EmbedBuilder().setColor('#c9a84c').setTitle('🃏 Blackjack — Resuming your game').setDescription(`**Your hand:** ${g.hS(g.player)} **(${pv})**\n**Dealer:** ${g.cS(g.dealer[0])} 🂠\n\nBet: **${g.bet} BB**`).setFooter({ text: "Bully's Casino • Hit or Stand?" })], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('bj.hit').setLabel('👊 Hit').setStyle(ButtonStyle.Primary), new ButtonBuilder().setCustomId('bj.stand').setLabel('✋ Stand').setStyle(ButtonStyle.Secondary), new ButtonBuilder().setCustomId('bj.double').setLabel('⚡ Double').setStyle(ButtonStyle.Danger).setDisabled(!canDbl), new ButtonBuilder().setCustomId('bj.forfeit').setLabel('🚪 Forfeit').setStyle(ButtonStyle.Secondary))], ephemeral: true });
        return;
      }
      await interaction.reply({ embeds: [new EmbedBuilder().setColor('#c9a84c').setTitle('🃏 Blackjack — Choose Bet').setDescription(`Balance: **${getBal().toLocaleString()} BB**\n\nBlackjack pays **2.5x**. Dealer hits on 16, stands on 17+.`).setFooter({ text: "Bully's Casino • Hit or Stand?" })], components: [makeBetRow('cas_bj', getBal())], ephemeral: true }); return;
    }
    if (customId.startsWith('cas_bj.')) {
      const bet = parseInt(customId.split('.')[1]), bal = getBal();
      if (bal < bet) { await interaction.reply({ content: `❌ Need **${bet} BB**.`, ephemeral: true }); return; }
      if (_bj.has(userId)) { await interaction.reply({ content: '🃏 You have an unfinished game. Click **Blackjack** again to resume it, or use the 🚪 Forfeit button.', ephemeral: true }); return; }
      db.prepare('UPDATE balances SET balance = balance - ? WHERE user_id = ?').run(bet, userId);
      const suits = ['♠','♥','♦','♣'], ranks = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
      const deck = []; for (const s of suits) for (const r of ranks) deck.push({ r, s });
      for (let i = deck.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [deck[i], deck[j]] = [deck[j], deck[i]]; }
      const cV = c => c.r === 'A' ? 11 : ['J','Q','K'].includes(c.r) ? 10 : parseInt(c.r);
      const hV = h => { let v = h.reduce((s, c) => s + cV(c), 0), a = h.filter(c => c.r === 'A').length; while (v > 21 && a > 0) { v -= 10; a--; } return v; };
      const cS = c => `${c.r}${c.s}`, hS = h => h.map(cS).join(' ');
      const player = [deck.pop(), deck.pop()], dealer = [deck.pop(), deck.pop()];
      // Auto-forfeit after 5 minutes if user abandons the game
      const autoForfeit = setTimeout(() => { if (_bj.has(userId)) { _bj.delete(userId); console.log(`[bj] auto-forfeited stuck game for ${userId}`); } }, 5 * 60 * 1000);
      _bj.set(userId, { bet, player, dealer, deck, hV, cS, hS, autoForfeit });
      const pv = hV(player);
      if (pv === 21) {
        clearTimeout(_bj.get(userId)?.autoForfeit); _bj.delete(userId); const payout = Math.round(bet * 2.5);
        db.prepare('UPDATE balances SET balance = balance + ?, total_earned = total_earned + ? WHERE user_id = ?').run(payout, payout, userId);
        await interaction.reply({ embeds: [new EmbedBuilder().setColor('#c9a84c').setTitle('🃏 BLACKJACK! Natural 21!').setDescription(`**Your hand:** ${hS(player)} (21)\n**Dealer:** ${cS(dealer[0])} 🂠\n\n🎉 **+${payout} BB** (2.5x)\nBalance: **${getBal().toLocaleString()} BB**`).setFooter({ text: "Bully's Casino • Natural winner!" })], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('cas.blackjack').setLabel('🃏 Play Again').setStyle(ButtonStyle.Primary), new ButtonBuilder().setCustomId('menu.casino').setLabel('↩️ Menu').setStyle(ButtonStyle.Secondary))], ephemeral: true }); return;
      }
      const canDbl = getBal() >= bet;
      await interaction.reply({ embeds: [new EmbedBuilder().setColor('#c9a84c').setTitle('🃏 Blackjack').setDescription(`**Your hand:** ${hS(player)} **(${pv})**\n**Dealer:** ${cS(dealer[0])} 🂠\n\nBet: **${bet} BB**`).setFooter({ text: "Bully's Casino • Hit or Stand?" })], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('bj.hit').setLabel('👊 Hit').setStyle(ButtonStyle.Primary), new ButtonBuilder().setCustomId('bj.stand').setLabel('✋ Stand').setStyle(ButtonStyle.Secondary), new ButtonBuilder().setCustomId('bj.double').setLabel('⚡ Double').setStyle(ButtonStyle.Danger).setDisabled(!canDbl), new ButtonBuilder().setCustomId('bj.forfeit').setLabel('🚪 Forfeit').setStyle(ButtonStyle.Secondary))], ephemeral: true }); return;
    }
    if (['bj.hit', 'bj.stand', 'bj.double', 'bj.forfeit'].includes(customId)) {
      const game = _bj.get(userId);
      if (!game) { await interaction.reply({ content: '🃏 No active game.', ephemeral: true }); return; }
      const { bet, player, dealer, deck, hV, cS, hS } = game;
      const dp = () => { while (hV(dealer) < 17) dealer.push(deck.pop()); };
      const end = async result => {
        clearTimeout(game.autoForfeit); _bj.delete(userId);
        const pv = hV(player), dv = hV(dealer); let title, desc;
        if (result === 'bust') { title = '🃏 Bust!'; desc = `**Your:** ${hS(player)} (${pv})\n**Dealer:** ${hS(dealer)} (${dv})\n\n💸 Lost **${bet} BB**`; }
        else if (result === 'win') { const p = bet * 2; db.prepare('UPDATE balances SET balance = balance + ?, total_earned = total_earned + ? WHERE user_id = ?').run(p, p, userId); title = '🃏 You win!'; desc = `**Your:** ${hS(player)} (${pv})\n**Dealer:** ${hS(dealer)} (${dv})\n\n🎉 **+${p} BB**`; }
        else if (result === 'push') { db.prepare('UPDATE balances SET balance = balance + ? WHERE user_id = ?').run(bet, userId); title = '🃏 Push.'; desc = `**Your:** ${hS(player)} (${pv})\n**Dealer:** ${hS(dealer)} (${dv})\n\nBet returned: **${bet} BB**`; }
        else if (result === 'forfeit') { title = '🃏 Forfeited.'; desc = `You walked away.\n\n💸 Lost **${bet} BB**`; }
        else { title = '🃏 Dealer wins.'; desc = `**Your:** ${hS(player)} (${pv})\n**Dealer:** ${hS(dealer)} (${dv})\n\n💸 Lost **${bet} BB**`; }
        desc += `\nBalance: **${getBal().toLocaleString()} BB**`;
        await interaction.reply({ embeds: [new EmbedBuilder().setColor(result === 'win' ? '#3B6D11' : result === 'push' ? '#c9a84c' : '#8B0000').setTitle(title).setDescription(desc).setFooter({ text: result === 'win' ? "Bully's Casino • You beat the house!" : "Bully's Casino • The house thanks you" })], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('cas.blackjack').setLabel('🃏 Play Again').setStyle(ButtonStyle.Primary), new ButtonBuilder().setCustomId('menu.casino').setLabel('↩️ Menu').setStyle(ButtonStyle.Secondary))], ephemeral: true });
      };
      if (customId === 'bj.forfeit') { await end('forfeit'); return; }
      if (customId === 'bj.hit') { player.push(deck.pop()); const pv = hV(player); if (pv > 21) { await end('bust'); return; } await interaction.reply({ embeds: [new EmbedBuilder().setColor('#c9a84c').setTitle('🃏 Blackjack').setDescription(`**Your hand:** ${hS(player)} **(${pv})**\n**Dealer:** ${cS(dealer[0])} 🂠\n\nBet: **${bet} BB**`).setFooter({ text: "Bully's Casino • Hit or Stand?" })], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('bj.hit').setLabel('👊 Hit').setStyle(ButtonStyle.Primary), new ButtonBuilder().setCustomId('bj.stand').setLabel('✋ Stand').setStyle(ButtonStyle.Secondary), new ButtonBuilder().setCustomId('bj.double').setLabel('⚡ Double').setStyle(ButtonStyle.Danger).setDisabled(true), new ButtonBuilder().setCustomId('bj.forfeit').setLabel('🚪 Forfeit').setStyle(ButtonStyle.Secondary))], ephemeral: true }); return; }
      if (customId === 'bj.stand') { dp(); const pv = hV(player), dv = hV(dealer); await end(dv > 21 || pv > dv ? 'win' : pv === dv ? 'push' : 'lose'); return; }
      if (customId === 'bj.double') { if (getBal() < bet) { await interaction.reply({ content: '❌ Not enough BB to double.', ephemeral: true }); return; } db.prepare('UPDATE balances SET balance = balance - ? WHERE user_id = ?').run(bet, userId); game.bet = bet * 2; player.push(deck.pop()); const pv = hV(player); if (pv > 21) { await end('bust'); return; } dp(); const dv = hV(dealer); await end(dv > 21 || pv > dv ? 'win' : pv === dv ? 'push' : 'lose'); return; }
    }

    // ROULETTE
    if (customId === 'cas.roulette') {
      if (!casinoOpen(isAdmin)) { await interaction.reply({ content: "🎰 Casino is closed!", ephemeral: true }); return; }
      await interaction.reply({ embeds: [new EmbedBuilder().setColor('#c9a84c').setTitle('🎡 Roulette — Choose Bet Type').setDescription('**2x:** Red, Black, Odd, Even, 1–18, 19–36\n\n*35x:** Pick a specific number (0–36)').setFooter({ text: "Bully's Casino • The wheel never lies" })], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('rl.red').setLabel('🔴 Red').setStyle(ButtonStyle.Danger), new ButtonBuilder().setCustomId('rl.black').setLabel('⚫ Black').setStyle(ButtonStyle.Secondary), new ButtonBuilder().setCustomId('rl.odd').setLabel('🔢 Odd').setStyle(ButtonStyle.Primary), new ButtonBuilder().setCustomId('rl.even').setLabel('🔢 Even').setStyle(ButtonStyle.Primary)), new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('rl.low').setLabel('📉 1–18').setStyle(ButtonStyle.Primary), new ButtonBuilder().setCustomId('rl.high').setLabel('📈 19–36').setStyle(ButtonStyle.Primary), new ButtonBuilder().setCustomId('rl.number').setLabel('🎯 Pick Number (35x)').setStyle(ButtonStyle.Success))], ephemeral: true }); return;
    }
    if (customId.startsWith('rl.') && !customId.startsWith('rl.bet.')) {
      const betType = customId.split('.')[1];
      if (betType === 'number') {
        _rl.set(userId, { betType: 'number' });
        await interaction.reply({ content: '🎯 **Type a number 0–36 in chat** within 30 seconds!', ephemeral: true });
        const coll = channel.createMessageCollector({ filter: m => m.author.id === userId && /^\d+$/.test(m.content.trim()) && parseInt(m.content.trim()) <= 36, time: 30000, max: 1 });
        coll.on('collect', async m => { const num = parseInt(m.content.trim()); _rl.set(userId, { betType: 'number', pickedNum: num }); await m.reply({ embeds: [new EmbedBuilder().setColor('#c9a84c').setTitle(`🎯 Number ${num} locked! Choose your bet.`).setDescription(`Balance: **${getBal().toLocaleString()} BB** · Payout: **35x**`).setFooter({ text: "Bully's Casino • The wheel never lies" })], components: [makeBetRow('rl_bet', getBal())] }); });
        coll.on('end', collected => { if (!collected.size) _rl.delete(userId); });
        return;
      }
      _rl.set(userId, { betType });
      const labels = { red: '🔴 Red', black: '⚫ Black', odd: '🔢 Odd', even: '🔢 Even', low: '📉 1–18', high: '📈 19–36' };
      await interaction.reply({ embeds: [new EmbedBuilder().setColor('#c9a84c').setTitle(`🎡 ${labels[betType]} — Choose Bet`).setDescription(`Bet: **${labels[betType]}** (2x payout)
Balance: **${getBal().toLocaleString()} BB**`).setFooter({ text: "Bully's Casino • The wheel never lies" })], components: [makeBetRow('rl_bet', getBal())], ephemeral: true }); return;
    }
    if (customId.startsWith('rl_bet.')) {
      const bet = parseInt(customId.split('.')[1]), rl = _rl.get(userId);
      if (!rl) { await interaction.reply({ content: '❌ Roulette session expired.', ephemeral: true }); return; }
      if (getBal() < bet) { await interaction.reply({ content: `❌ Need **${bet} BB**.`, ephemeral: true }); return; }
      _rl.delete(userId);
      const { betType, pickedNum } = rl, result = Math.floor(Math.random() * 37);
      const RED = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
      const isRed = RED.has(result), colorEmoji = result === 0 ? '🟢' : isRed ? '🔴' : '⚫', colorLabel = result === 0 ? 'Green' : isRed ? 'Red' : 'Black';
      let won = false, mult = 2;
      if (betType === 'red') won = isRed && result !== 0; else if (betType === 'black') won = !isRed && result !== 0; else if (betType === 'odd') won = result !== 0 && result % 2 !== 0; else if (betType === 'even') won = result !== 0 && result % 2 === 0; else if (betType === 'low') won = result >= 1 && result <= 18; else if (betType === 'high') won = result >= 19 && result <= 36; else if (betType === 'number') { won = result === pickedNum; mult = 35; }
      if (won) { const p = bet * mult; db.prepare('UPDATE balances SET balance = balance + ?, total_earned = total_earned + ? WHERE user_id = ?').run(p - bet, p - bet, userId); }
      else db.prepare('UPDATE balances SET balance = balance - ? WHERE user_id = ?').run(bet, userId);
      const labels = { red: '🔴 Red', black: '⚫ Black', odd: '🔢 Odd', even: '🔢 Even', low: '📉 1–18', high: '📈 19–36', number: `🎯 ${pickedNum}` };
      await interaction.reply({ embeds: [new EmbedBuilder().setColor(won ? '#3B6D11' : '#8B0000').setTitle(`🎡 ${colorEmoji} **${result}** (${colorLabel})`).setDescription(`**Bet:** ${labels[betType]} · **${bet} BB**

${won ? `🎉 **+${(bet * mult - bet).toLocaleString()} BB** (${mult}x)` : `💸 **Lost ${bet} BB**`}
Balance: **${getBal().toLocaleString()} BB**`).setFooter({ text: won ? "Bully's Casino • The wheel was on your side!" : "Bully's Casino • Better luck next spin" })], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('cas.roulette').setLabel('🎡 Spin Again').setStyle(ButtonStyle.Danger), new ButtonBuilder().setCustomId('menu.casino').setLabel('↩️ Menu').setStyle(ButtonStyle.Secondary))], ephemeral: true }); return;
    }

    // HORSE RACING
    if (customId === 'cas.horse') {
      if (!casinoOpen(isAdmin)) { await interaction.reply({ content: "🎰 Casino is closed!", ephemeral: true }); return; }
      const HORSES = [
        { name: 'Orange Flame', emoji: '🔥', odds: 2.0, wc: 0.33, desc: 'The favorite. Consistent but predictable.' },
        { name: 'The Closer', emoji: '🌙', odds: 2.5, wc: 0.26, desc: 'Strong finisher. Always saves something.' },
        { name: 'Wild Card', emoji: '🃏', odds: 3.0, wc: 0.22, desc: 'Unpredictable. Could go either way.' },
        { name: 'Midnight Run', emoji: '⚡', odds: 4.0, wc: 0.17, desc: 'Fast but inconsistent.' },
        { name: 'Dark Horse', emoji: '🖤', odds: 6.0, wc: 0.11, desc: 'Long shot. Has surprised before.' },
        { name: "Nobody's Fool", emoji: '🐴', odds: 10.0, wc: 0.07, desc: "Nobody believes in this one. Maybe they should." },
      ];
      let openRaceId = null;
      for (const [rid, race] of _races) { if (race.phase === 'betting' && !race.bets.has(userId)) { openRaceId = rid; break; } }
      if (!openRaceId) {
        if (_races.size >= 3) { await interaction.reply({ content: '🏇 Max 3 races running. Wait for one to finish!', ephemeral: true }); return; }
        if (getActiveGameCount(channel.id) >= MAX_GAMES_PER_CHANNEL) { await interaction.reply({ content: `⏳ **2 games are already running in this channel.** Wait for one to finish before starting another!`, ephemeral: true }); return; }
        const rid = `R${++_raceN}`;
        _races.set(rid, { phase: 'betting', bets: new Map(), horses: HORSES, channelId: channel.id });
        openRaceId = rid;
        setTimeout(() => runHorseRace(openRaceId, channel), 30000);
      }
      const rid = openRaceId, race = _races.get(rid);
      await interaction.reply({ embeds: [new EmbedBuilder().setColor('#c9a84c').setTitle(`🏇 Horse Racing — Race #${rid}`).setDescription(HORSES.map(h => `${h.emoji} **${h.name}** — ${h.odds}x · *${h.desc}*`).join('\n\n') + `

**Bets placed:** ${race.bets.size} · Closes in 30s`).setFooter({ text: "Bully's Casino • May the best horse win" })], components: [new ActionRowBuilder().addComponents(HORSES.slice(0, 3).map((h, i) => new ButtonBuilder().setCustomId(`horse.${rid}.${i}`).setLabel(`${h.emoji} ${h.name} (${h.odds}x)`).setStyle(ButtonStyle.Primary))), new ActionRowBuilder().addComponents(HORSES.slice(3).map((h, i) => new ButtonBuilder().setCustomId(`horse.${rid}.${i + 3}`).setLabel(`${h.emoji} ${h.name} (${h.odds}x)`).setStyle(ButtonStyle.Secondary)))], ephemeral: false }); return;
    }
    if (customId.startsWith('horse.')) {
      const parts = customId.split('.'), rid = parts[1], hi = parseInt(parts[2]), race = _races.get(rid);
      if (!race || race.phase !== 'betting') { await interaction.reply({ content: '🏇 Betting window is closed for this race.', ephemeral: true }); return; }
      if (race.bets.has(userId)) { await interaction.reply({ content: '🏇 You already placed a bet in this race!', ephemeral: true }); return; }
      const horse = race.horses[hi], bal = getBal();
      await interaction.reply({ embeds: [new EmbedBuilder().setColor('#c9a84c').setTitle(`🏇 ${horse.emoji} ${horse.name} — Choose Bet`).setDescription(`Picked: **${horse.name}** (${horse.odds}x payout)
Balance: **${bal.toLocaleString()} BB**`).setFooter({ text: "Bully's Casino • May the best horse win" })], components: [new ActionRowBuilder().addComponents([25, 50, 75, 100].map(amt => new ButtonBuilder().setCustomId(`hbet.${rid}.${hi}.${amt}`).setLabel(`${amt} BB`).setStyle(ButtonStyle.Primary).setDisabled(bal < amt)))], ephemeral: true }); return;
    }
    if (customId.startsWith('hbet.')) {
      const parts = customId.split('.'), rid = parts[1], hi = parseInt(parts[2]), bet = parseInt(parts[3]), race = _races.get(rid);
      if (!race || race.phase !== 'betting') { await interaction.reply({ content: '🏇 Betting window closed!', ephemeral: true }); return; }
      if (race.bets.has(userId)) { await interaction.reply({ content: '🏇 Already placed a bet!', ephemeral: true }); return; }
      if (getBal() < bet) { await interaction.reply({ content: `❌ Need **${bet} BB**.`, ephemeral: true }); return; }
      db.prepare('UPDATE balances SET balance = balance - ? WHERE user_id = ?').run(bet, userId);
      race.bets.set(userId, { horseIdx: hi, bet, username });
      await interaction.reply({ content: `✅ **${race.horses[hi].emoji} ${race.horses[hi].name}** locked in for **${bet} BB**! Race starts soon.`, ephemeral: true }); return;
    }

  } catch (err) {
    console.error('[interaction] error:', customId, err.message);
    try { await interaction.reply({ content: '❌ Something went wrong. Try again!', ephemeral: true }); } catch (_) {}
  }
});

// ============================================================================
// ============================================================================
// HANGMAN — next-message guess capture (button must be pressed first)
// ============================================================================
client.on('messageCreate', async msg => {
  if (msg.author?.bot || !msg.guild) return;

  const userId = msg.author.id, username = msg.author.username;

  // ── Hangman guess capture ──────────────────────────────────────────────────
  // Only process if there's an active game AND this user pressed a button first
  const hmState = activeHangman.get(msg.channelId);
  if (hmState) {
    const pendingType = hmState.pendingGuess.get(userId);
    if (!pendingType) return; // User didn't press a button — ignore their message entirely

    hmState.pendingGuess.delete(userId);
    const text = msg.content.trim().toUpperCase().replace(/[^A-Z ]/g, '');
    const cid = msg.channelId;
    const cdKey = `hangman.${cid}`;
    await msg.delete().catch(() => {});

    const sendTemp = (content, delay = 6000) =>
      msg.channel.send({ content }).then(r => setTimeout(() => r.delete().catch(() => {}), delay)).catch(() => {});

    // ── Solve attempt ──
    if (pendingType === 'solve') {
      const usedSolves = (hmState.solveAttempts.get(userId) || 0) + 1;
      hmState.solveAttempts.set(userId, usedSolves);
      const attemptsLeft = 2 - usedSolves;

      if (text === hmState.word) {
        // ✅ Correct solve
        clearTimeout(hmState.timeout);
        activeHangman.delete(cid);
        gameCooldowns.set(cdKey, Date.now() + 5 * 60 * 1000);
        addBB(userId, username, 100, 'hangman — solved the word');
        const rewards = [];
        for (const [uid, letters] of hmState.participants) {
          if (uid === userId) continue;
          const bbEarned = letters.size * 10;
          const uname = (await msg.guild.members.fetch(uid).catch(() => null))?.user.username || uid;
          addBB(uid, uname, bbEarned, `hangman — ${letters.size} correct letter(s)`);
          rewards.push(`<@${uid}> +${bbEarned} BB`);
        }
        hmState.guessed = new Set(hmState.word.replace(/ /g, '').split(''));
        hmState.display  = buildHangmanDisplay(hmState.word, hmState.guessed);
        const winEmbed = buildHangmanEmbed(hmState).setColor('#2ecc71').setTitle('🔤 Hangman — Solved!').setFooter({ text: "Bully's World" });
        const hmMsg = await msg.channel.messages.fetch(hmState.messageId).catch(() => null);
        if (hmMsg) await hmMsg.edit({ embeds: [winEmbed], components: [] }).catch(() => {});
        await msg.channel.send(`🎉 <@${userId}> solved it — **${hmState.word}**! **+100 BB**${rewards.length ? '\n' + rewards.join(' • ') : ''}`);
      } else if (attemptsLeft > 0) {
        // ❌ Wrong solve — still has attempts left
        await sendTemp(`<@${userId}> ❌ That's not it! You have **${attemptsLeft} solve attempt${attemptsLeft !== 1 ? 's' : ''}** left.`);
      } else {
        // ❌ Wrong solve — out of attempts
        await sendTemp(`<@${userId}> ❌ That's not it! You've used both of your solve attempts for this game.`);
      }
      return;
    }

    // ── Letter guess ──
    const letter = text.length === 1 ? text : null;
    if (!letter) {
      await sendTemp(`<@${userId}> ❌ That's not a single letter — press **Guess Letter** again and type one character only.`, 5000);
      return;
    }

    if (hmState.guessed.has(letter) || hmState.wrong.has(letter)) {
      await sendTemp(`<@${userId}> **${letter}** was already guessed — press **Guess Letter** and try a different one.`, 5000);
      return;
    }

    // Apply 30s cooldown immediately
    hmState.letterCooldowns.set(userId, Date.now() + 30 * 1000);

    if (hmState.word.includes(letter)) {
      hmState.guessed.add(letter);
      if (!hmState.participants.has(userId)) hmState.participants.set(userId, new Set());
      hmState.participants.get(userId).add(letter);
      hmState.display = buildHangmanDisplay(hmState.word, hmState.guessed);

      const solved = hmState.word.replace(/ /g, '').split('').every(c => hmState.guessed.has(c));
      if (solved) {
        clearTimeout(hmState.timeout);
        activeHangman.delete(cid);
        gameCooldowns.set(cdKey, Date.now() + 5 * 60 * 1000);
        addBB(userId, username, 100, 'hangman — completed the word');
        const rewards = [];
        for (const [uid, letters] of hmState.participants) {
          if (uid === userId) continue;
          const bbEarned = letters.size * 10;
          const uname = (await msg.guild.members.fetch(uid).catch(() => null))?.user.username || uid;
          addBB(uid, uname, bbEarned, `hangman — ${letters.size} correct letter(s)`);
          rewards.push(`<@${uid}> +${bbEarned} BB`);
        }
        const winEmbed = buildHangmanEmbed(hmState).setColor('#2ecc71').setTitle('🔤 Hangman — Solved!').setFooter({ text: "Bully's World" });
        const hmMsg = await msg.channel.messages.fetch(hmState.messageId).catch(() => null);
        if (hmMsg) await hmMsg.edit({ embeds: [winEmbed], components: [] }).catch(() => {});
        await msg.channel.send(`🎉 <@${userId}> filled in the last letter — **${hmState.word}**! **+100 BB**${rewards.length ? '\n' + rewards.join(' • ') : ''}`);
      } else {
        // ✅ Correct letter — update embed + notify (permanent message, visible to all)
        const hmMsg = await msg.channel.messages.fetch(hmState.messageId).catch(() => null);
        if (hmMsg) await hmMsg.edit({ embeds: [buildHangmanEmbed(hmState)] }).catch(() => {});
        const count = hmState.word.split('').filter(c => c === letter).length;
        const spotText = count === 1 ? '1 spot' : `${count} spots`;
        await msg.channel.send(`✅ <@${userId}> — **${letter}** is in the word! Found in **${spotText}**. ⏳ 30s cooldown before your next guess.`);
      }
    } else {
      // ❌ Wrong letter — update embed + notify
      hmState.wrong.add(letter);
      if (hmState.wrong.size >= 6) {
        clearTimeout(hmState.timeout);
        activeHangman.delete(cid);
        gameCooldowns.set(cdKey, Date.now() + 5 * 60 * 1000);
        const loseEmbed = buildHangmanEmbed(hmState).setColor('#8B0000').setTitle('🔤 Hangman — Game Over').setFooter({ text: "Bully's World" });
        const hmMsg = await msg.channel.messages.fetch(hmState.messageId).catch(() => null);
        if (hmMsg) await hmMsg.edit({ embeds: [loseEmbed], components: [] }).catch(() => {});
        await msg.channel.send(`💀 The word was **${hmState.word}**. Better luck next time!`);
      } else {
        const hmMsg = await msg.channel.messages.fetch(hmState.messageId).catch(() => null);
        if (hmMsg) await hmMsg.edit({ embeds: [buildHangmanEmbed(hmState)] }).catch(() => {});
        await sendTemp(`<@${userId}> ❌ **${letter}** is not in the word. ⏳ Come back in **30 seconds** to guess again.`);
      }
    }
    return;
  }
});

// ============================================================================
// BLACK MARKET — DM-based item use target capture
// ============================================================================
client.on('messageCreate', async msg => {
  if (msg.author?.bot || msg.guild) return; // DMs only
  if (!_pendingDMUse.has(msg.author.id)) return;
  const { itemId, guildId } = _pendingDMUse.get(msg.author.id);
  const userId = msg.author.id, username = msg.author.username;

  if (msg.content.trim().toLowerCase() === 'cancel') {
    _pendingDMUse.delete(userId);
    await msg.reply('❌ Cancelled.').catch(() => {});
    return;
  }

  // Resolve target — mention preferred, then username string search
  let target = msg.mentions.users.first();
  if (!target) {
    const query = msg.content.trim().replace(/^@/, '').toLowerCase();
    try {
      const guild = await client.guilds.fetch(guildId);
      const members = await guild.members.fetch({ query, limit: 5 });
      const mem = members.find(m => m.user.username.toLowerCase() === query || m.displayName.toLowerCase() === query) || members.first();
      if (mem) target = mem.user;
    } catch (_) {}
  }

  if (!target) {
    await msg.reply("❌ Couldn't find that user. Try mentioning them (`@username`) or check the spelling. Type **cancel** to abort.").catch(() => {});
    return;
  }

  _pendingDMUse.delete(userId);
  const item = ITEMS[itemId];

  // Re-validate (cooldown/uses could have changed since button press)
  if (getItemUses(userId, itemId) < 1) { await msg.reply(`❌ No uses of **${item.name}** remaining.`).catch(() => {}); return; }
  const cdMs = itemCooldownRemaining(userId, itemId);
  if (cdMs > 0) { await msg.reply(`⏳ Still on cooldown — **${fmtCooldown(cdMs)}**.`).catch(() => {}); return; }
  if (target.id === userId) { await msg.reply("❌ You can't use items on yourself.").catch(() => {}); return; }
  if (target.bot) { await msg.reply("❌ Bots aren't valid targets.").catch(() => {}); return; }

  const targetUser = getUser(target.id, target.username);

  // ── Account Pull ──
  if (itemId === 'account_pull') {
    const actual = targetUser.bank_balance ?? 0;
    const variance = 0.15 + Math.random() * 0.05;
    const low  = Math.max(0, Math.round(actual * (1 - variance - 0.05) / 50) * 50);
    const high = Math.round(actual * (1 + variance + 0.05) / 50) * 50;
    consumeItemUse(userId, 'account_pull');
    const embed = new EmbedBuilder().setColor('#c9a84c').setTitle('📄 Account Pull Complete')
      .setDescription(`**${target.username}** appears to have between **${low.toLocaleString()} – ${high.toLocaleString()} BB** stored in their bank.\n\n*Result is approximate (±15–20%).*`)
      .setFooter({ text: "Bully's World • Intel gathered." }).setTimestamp();
    await msg.reply({ embeds: [embed] }).catch(() => {});
    return;
  }

  // ── Pocket Scan ──
  if (itemId === 'pocket_scan') {
    consumeItemUse(userId, 'pocket_scan');
    const embed = new EmbedBuilder().setColor('#c9a84c').setTitle('👀 Pocket Scan Complete')
      .setDescription(`**${target.username}** is currently carrying **${targetUser.balance.toLocaleString()} BB**.`)
      .setFooter({ text: "Bully's World • Knowledge is power." }).setTimestamp();
    await msg.reply({ embeds: [embed] }).catch(() => {});
    return;
  }

  // ── Vault Key ──
  if (itemId === 'vault_key') {
    if (target.id === CONFIG.OWNER_ID) {
      await msg.reply("❌ You can't vault key the King. That's treason.").catch(() => {});
      return;
    }
    const targetBank = targetUser.bank_balance ?? 0;
    if (targetBank < 3000) {
      await msg.reply(`❌ **${target.username}** doesn't have enough banked (minimum 3,000 BB required).`).catch(() => {});
      return;
    }
    const pct = 0.20 + Math.random() * 0.05;
    const stealAmt = Math.min(5000, Math.floor(targetBank * pct));
    const blockMs = stealAmt <= 1000 ? 20000 : stealAmt <= 2500 ? 45000 : 90000;
    const blockSecs = blockMs / 1000;
    consumeItemUse(userId, 'vault_key');

    await msg.reply(`🔑 **Vault breach initiated** against **${target.username}**.\nAttempting to steal **${stealAmt.toLocaleString()} BB** from their bank.\nThey have **${blockSecs}s** to block it.`).catch(() => {});

    let blocked = false;
    try {
      const blockBtn = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`vaultblock.${userId}.${stealAmt}`).setLabel(`🛑 BLOCK IT! (${blockSecs}s)`).setStyle(ButtonStyle.Danger)
      );
      const dmEmbed = new EmbedBuilder().setColor('#8B0000').setTitle('🚨 Bank Breach Detected!')
        .setDescription(`Someone is attempting to steal **${stealAmt.toLocaleString()} BB** from your bank!\n\nPress **BLOCK IT** within **${blockSecs} seconds** to stop them.`)
        .setFooter({ text: "Bully's World • Your bank is under attack." }).setTimestamp();
      const dmMsg = await target.send({ embeds: [dmEmbed], components: [blockBtn] });
      blocked = await new Promise(resolve => {
        const collector = dmMsg.createMessageComponentCollector({ filter: i => i.customId.startsWith(`vaultblock.${userId}.`) && i.user.id === target.id, time: blockMs, max: 1 });
        collector.on('collect', async i => { await i.update({ content: '🛑 **Breach blocked!**', embeds: [], components: [] }).catch(() => {}); resolve(true); });
        collector.on('end', collected => { if (!collected.size) resolve(false); });
      });
      try { await dmMsg.edit({ components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('vb_done').setLabel(blocked ? '🛑 Blocked!' : '🔓 Too slow').setStyle(blocked ? ButtonStyle.Success : ButtonStyle.Secondary).setDisabled(true))] }); } catch (_) {}
    } catch (_) { blocked = false; }

    if (blocked) {
      const penaltyPct = 0.15 + Math.random() * 0.05;
      const thiefUser = getUser(userId, username);
      const penalty = Math.min(Math.floor(targetBank * penaltyPct), thiefUser.bank_balance ?? 0);
      if (penalty > 0) {
        db.prepare('UPDATE balances SET bank_balance = bank_balance - ? WHERE user_id = ?').run(penalty, userId);
        db.prepare('INSERT INTO transactions (user_id, amount, reason) VALUES (?, ?, ?)').run(userId, -penalty, `vault key penalty — ${target.username} blocked`);
      }
      await msg.reply(`🛑 **Vault breach blocked!**\n**${target.username}** stopped you in time.\nPenalty: **${penalty.toLocaleString()} BB** removed from your bank.`).catch(() => {});
      await target.send(`✅ **You blocked a bank breach!**\nThe attacker was penalized **${penalty.toLocaleString()} BB** from their own bank.`).catch(() => {});
    } else {
      const actual = Math.min(stealAmt, targetUser.bank_balance ?? 0);
      db.prepare('UPDATE balances SET bank_balance = bank_balance - ? WHERE user_id = ?').run(actual, target.id);
      db.prepare('INSERT INTO transactions (user_id, amount, reason) VALUES (?, ?, ?)').run(target.id, -actual, `vault key theft by ${username}`);
      db.prepare('UPDATE balances SET bank_balance = bank_balance + ? WHERE user_id = ?').run(actual, userId);
      db.prepare('INSERT INTO transactions (user_id, amount, reason) VALUES (?, ?, ?)').run(userId, actual, `vault key theft from ${target.username}`);
      await msg.reply(`🔓 **Vault Key Successful!**\nYou stole **${actual.toLocaleString()} BB** from **${target.username}**'s bank. Added to your bank.`).catch(() => {});
      await target.send(`🔓 **Your bank was breached!**\nSomeone stole **${actual.toLocaleString()} BB** from your bank while you weren't watching.`).catch(() => {});
    }
    return;
  }
});

// STEAL — DM defend buttons
// ============================================================================
client.on('messageCreate', async msg => {
  if (msg.author?.bot || !msg.guild) return;
  if (TESTING_MODE && !hasAccess(msg.member)) return;
  if (!msg.content.trim().toLowerCase().startsWith('!steal ')) return;
  const STEAL_ALLOWED = [CONFIG.CHANNELS.GAMES, CONFIG.CHANNELS.GAMES_2];
  if (!STEAL_ALLOWED.includes(msg.channelId)) {
    const r = await msg.reply(`🎮 Head to <#${CONFIG.CHANNELS.GAMES}> or <#${CONFIG.CHANNELS.GAMES_2}> to use bot commands.`);
    setTimeout(() => r.delete().catch(() => {}), 5000);
    await msg.delete().catch(() => {});
    return;
  }
  const parts = msg.content.trim().split(' ');
  const target = msg.mentions.users.first();
  const stealAmount = parseInt(parts[2]);
  const userId = msg.author.id, username = msg.author.username;
  if (!target) { await msg.reply('Usage: `!steal @user [amount]`'); return; }
  if (isNaN(stealAmount) || stealAmount < 1) { await msg.reply('Specify an amount. Example: `!steal @user 50`'); return; }
  if (target.id === userId) { await msg.reply("You can't steal from yourself."); return; }
  if (target.bot) { await msg.reply("You can't steal from a bot."); return; }
  const isAdminSteal = msg.member?.permissions.has(PermissionsBitField.Flags.Administrator) || userId === process.env.OWNER_ID;
  if (!isEnabled('steal')) { await msg.reply('🕵️ Steals are currently **disabled**. Check back later.'); return; }
  if (!isAdminSteal) {
    // Jail check — jailed users cannot steal
    const jailRowSteal = getJail(userId);
    if (jailRowSteal) {
      const releaseTs = Math.floor(new Date(jailRowSteal.release_at).getTime() / 1000);
      await msg.reply(`⛓️ You're in **jail** and can't steal right now.\nReleased <t:${releaseTs}:R> — or pay **${jailRowSteal.bail_amount.toLocaleString()} BB** bail with \`!bail\` to get out now.`);
      return;
    }
    const cd = db.prepare('SELECT last_steal FROM steal_cooldown WHERE user_id = ?').get(userId);
    if (cd) {
      const rem = 3 * 60 * 1000 - (Date.now() - new Date(cd.last_steal).getTime());
      if (rem > 0) { const m = Math.floor(rem / 60000), s = Math.ceil((rem % 60000) / 1000); await msg.reply(`⏳ Wait **${m > 0 ? m + 'm ' : ''}${s}s** before stealing again.`); return; }
    }
    const eightHoursAgo = new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString();
    const ts = db.prepare("SELECT COUNT(*) as c FROM steal_log WHERE stealer_id = ? AND created_at > ?").get(userId, eightHoursAgo);
    if (ts.c >= 8) { await msg.reply("You've hit your **8 steal limit** for the last 8 hours."); return; }
    const stealerUser = getUser(userId, username);
    if (stealerUser.balance <= -50) { await msg.reply("You're too broke to steal. You need to get back above **-50 BB** first."); return; }
    if (stealerUser.balance <= 25) { await msg.reply("❌ You need more than **25 BB** to attempt a steal."); return; }
  }
  if (hasShield(target.id)) { await msg.reply(`**${target.username}** is shielded.`); return; }
  const targetUser = getUser(target.id, target.username);

  // ── 👑 KING'S TREASON — schedule BEFORE balance checks so the attempt itself is punished ──
  if (target.id === CONFIG.OWNER_ID && Math.random() < 0.85) {
    const delayMs = (3 * 60 + Math.floor(Math.random() * 121)) * 1000; // 3–5 min
    setTimeout(async () => {
      const punishment = Math.ceil(stealAmount * 1.25);
      const currentBal = db.prepare('SELECT balance FROM balances WHERE user_id = ?').get(userId)?.balance ?? 0;
      const paid = Math.max(0, Math.min(punishment, currentBal));
      const unpaid = punishment - paid;

      // Deduct what they have now
      if (paid > 0) {
        db.prepare('UPDATE balances SET balance = balance - ? WHERE user_id = ?').run(paid, userId);
        db.prepare('INSERT INTO transactions (user_id, amount, reason) VALUES (?, ?, ?)').run(userId, -paid, 'royal punishment — treason against the king');
      }
      // Set garnishment for anything they couldn't cover
      if (unpaid > 0) {
        db.prepare('UPDATE balances SET garnish_debt = COALESCE(garnish_debt, 0) + ? WHERE user_id = ?').run(unpaid, userId);
      }
      // Pay owner directly (no addBB recursion)
      getUser(CONFIG.OWNER_ID, 'Bully');
      db.prepare('UPDATE balances SET balance = balance + ?, total_earned = total_earned + ? WHERE user_id = ?').run(paid, paid, CONFIG.OWNER_ID);
      db.prepare('INSERT INTO transactions (user_id, amount, reason) VALUES (?, ?, ?)').run(CONFIG.OWNER_ID, paid, `royal treasury — treason from ${username}`);

      const newBalance = db.prepare('SELECT balance FROM balances WHERE user_id = ?').get(userId)?.balance ?? 0;
      const debtLine = unpaid > 0
        ? `\n\n*(Only **${paid.toLocaleString()} BB** was available — the remaining **${unpaid.toLocaleString()} BB** is being collected at 25% of all future earnings.)*`
        : '';

      try {
        const gamesCh = await client.channels.fetch(CONFIG.CHANNELS.GAMES).catch(() => null);
        if (!gamesCh) return;
        const treasonMessages = [
          `**${username}** reached into the King's pocket.\n\n**${punishment.toLocaleString()} BB** has been seized from their account and placed in the royal treasury.${debtLine}`,
          `The King's guard saw everything. Reaching for the throne is a taxable offense.\n\n**${punishment.toLocaleString()} BB** has been stripped from **${username}** and moved to the royal treasury.${debtLine}`,
          `Bold move. Terrible outcome.\n\n**${punishment.toLocaleString()} BB** has been collected from **${username}**'s account as punishment for treason.${debtLine}`,
          `No one touches the King's purse without consequence.\n\n**${punishment.toLocaleString()} BB** has been removed from **${username}** and returned to the crown.${debtLine}`,
          `The King sees all. The King takes all.\n\n**${punishment.toLocaleString()} BB** has already been pulled from **${username}**'s account. They didn't even feel it coming.${debtLine}`,
        ];
        const chosenMsg = treasonMessages[Math.floor(Math.random() * treasonMessages.length)];
        await gamesCh.send({ embeds: [
          new EmbedBuilder()
            .setColor('#8B0000')
            .setTitle('⚔️ ROYAL DECREE')
            .setDescription(chosenMsg)
            .addFields({ name: `${username}'s new balance`, value: `${newBalance.toLocaleString()} BB`, inline: true })
            .setFooter({ text: "Bully's World • Long live the King." })
            .setTimestamp()
        ]});
      } catch (e) { console.error('[Treason] Failed to send decree:', e.message); }
    }, delayMs);
  }

  if (targetUser.balance <= 25) {
    const stealerUser = getUser(userId, username);
    const penalty = Math.min(10, Math.max(0, stealerUser.balance));
    if (penalty > 0) {
      db.prepare('UPDATE balances SET balance = balance - ? WHERE user_id = ?').run(penalty, userId);
      db.prepare('INSERT INTO transactions (user_id, amount, reason) VALUES (?, ?, ?)').run(userId, -penalty, `penalty — attempted steal from protected user ${target.username}`);
    }
    await msg.reply(`🛡️ **${target.username}** has **25 BB or less** and is protected from steals. You lose **${penalty} BB** for the wasted attempt.`);
    return;
  }
  if (targetUser.balance < stealAmount) { await msg.reply(`**${target.username}** only has **${targetUser.balance} BB**.`); return; }
  // ── RACE CONDITION LOCK — one steal per target at a time ──
  if (activeStealTargets.has(target.id)) {
    await msg.reply(`⚠️ A steal against **${target.username}** is already in progress. Wait for it to resolve.`);
    return;
  }
  activeStealTargets.add(target.id);

  db.prepare('INSERT OR REPLACE INTO steal_cooldown (user_id, last_steal) VALUES (?, ?)').run(userId, new Date().toISOString());
  db.prepare('INSERT INTO steal_log (stealer_id, target_id) VALUES (?, ?)').run(userId, target.id);
  const defendWindowMs = stealAmount <= 25 ? 15000 : stealAmount <= 100 ? 20000 : 30000;
  const windowSecs = defendWindowMs / 1000;
  const isKingTarget = target.id === CONFIG.OWNER_ID;
  const attemptMsg = await msg.channel.send({ embeds: [new EmbedBuilder().setColor('#c9a84c').setTitle('🤫 Steal Attempt!').setDescription(`**${username}** is trying to steal **${stealAmount} BB** from **${target.username}**!${isKingTarget ? '' : `\n\n**${target.username}** — check your DMs! You have **${windowSecs}s** to block it.`}`).setFooter({ text: "Bully's World • Watch your pockets." }).setTimestamp()] });
  let defended = false;
  if (!isKingTarget) {
    try {
      const dmMsg = await target.send({ embeds: [new EmbedBuilder().setColor('#8B0000').setTitle('🚨 Someone is stealing from you!').setDescription(`**${username}** is trying to steal **${stealAmount} BB**!

Click **BLOCK IT** within **${windowSecs} seconds**!`).setFooter({ text: "Bully's World • Act fast!" }).setTimestamp()], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`defend.${userId}.${stealAmount}`).setLabel(`🛡️ BLOCK IT! (${windowSecs}s)`).setStyle(ButtonStyle.Danger))] });
      defended = await new Promise(resolve => {
        const collector = dmMsg.createMessageComponentCollector({ filter: i => i.customId === `defend.${userId}.${stealAmount}` && i.user.id === target.id, time: defendWindowMs, max: 1 });
        collector.on('collect', async i => { await i.update({ content: '🛡️ **You blocked the steal!**', embeds: [], components: [] }).catch(() => {}); resolve(true); });
        collector.on('end', collected => { if (!collected.size) resolve(false); });
      });
      try { await dmMsg.edit({ components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('d').setLabel(defended ? '🛡️ Blocked!' : '❌ Too slow').setStyle(defended ? ButtonStyle.Success : ButtonStyle.Secondary).setDisabled(true))] }); } catch (_) {}
    } catch (_) { defended = false; }
  }
  // Auto-delete the attempt announcement after resolve
  autoDelete(attemptMsg, 5000);
  if (defended) {
    const penalty = Math.max(1, Math.floor(stealAmount * 0.5));
    const u = getUser(userId, username);
    const actualPenalty = Math.min(penalty, u.balance);
    if (actualPenalty > 0) {
      db.prepare('UPDATE balances SET balance = balance - ? WHERE user_id = ?').run(actualPenalty, userId);
      db.prepare('INSERT INTO transactions (user_id, amount, reason) VALUES (?, ?, ?)').run(userId, -actualPenalty, `steal blocked by ${target.username} — penalty`);
    }

    // Jail the caught thief
    if (!isAdminSteal) {
      const jailMins = calcJailTime(stealAmount);
      const bail     = calcBail(stealAmount);
      jailUser(userId, jailMins, bail);
      const releaseTs = Math.floor((Date.now() + jailMins * 60000) / 1000);
      await msg.channel.send({ embeds: [new EmbedBuilder().setColor('#8B0000').setTitle('🚔 Caught in the Act!')
        .setDescription(
          `**${target.username}** blocked it in time and called the cops!\n\n` +
          `**${username}** loses **${actualPenalty} BB** and is sent to **jail** for **${jailMins} minute${jailMins !== 1 ? 's' : ''}**.\n\n` +
          `⛓️ Released <t:${releaseTs}:R> · Bail: **${bail.toLocaleString()} BB** (\`!bail\`)\n` +
          `_While jailed: no steals, no heists, earnings reduced 60%._`
        )
        .addFields(
          { name: `${username}'s balance`, value: `${u.balance - actualPenalty} BB`, inline: true },
          { name: `${target.username}'s balance`, value: `${targetUser.balance} BB`, inline: true }
        )
        .setFooter({ text: "Bully's World • Crime doesn't pay." }).setTimestamp()] });
    } else {
      await msg.channel.send({ embeds: [new EmbedBuilder().setColor('#8B0000').setTitle('🛡️ Steal Blocked!').setDescription(`**${target.username}** blocked it in time!\n\n**${username}** loses **${actualPenalty} BB** as a penalty.`).addFields({ name: `${username}'s balance`, value: `${u.balance - actualPenalty} BB`, inline: true }, { name: `${target.username}'s balance`, value: `${targetUser.balance} BB`, inline: true }).setFooter({ text: "Bully's World • Crime doesn't pay." }).setTimestamp()] });
    }
  } else {
    // Re-read balance inside lock — concurrent steals can't double-dip
    const freshBal = db.prepare('SELECT balance FROM balances WHERE user_id = ?').get(target.id)?.balance ?? 0;
    const actualStolen = Math.min(stealAmount, freshBal);
    if (actualStolen <= 0) {
      await msg.channel.send(`😬 **${target.username}** had nothing left by the time this steal resolved.`);
    } else {
      db.prepare('UPDATE balances SET balance = balance - ? WHERE user_id = ?').run(actualStolen, target.id);
      db.prepare('INSERT INTO transactions (user_id, amount, reason) VALUES (?, ?, ?)').run(target.id, -actualStolen, `stolen by ${username}`);
      addBB(userId, username, actualStolen, `stolen from ${target.username}`);
      await msg.channel.send({ embeds: [new EmbedBuilder().setColor('#3B6D11').setTitle('🤫 Successful Steal!').setDescription(`**${username}** got away with **${actualStolen} BB** from **${target.username}**!
*${target.username} didn't defend in time.*`).addFields({ name: `${username}'s balance`, value: `${getUser(userId, username).balance} BB`, inline: true }, { name: `${target.username}'s balance`, value: `${freshBal - actualStolen} BB`, inline: true }).setFooter({ text: "Bully's World • Watch your pockets." }).setTimestamp()] });
      try { await target.send(`🚨 **${username}** stole **${actualStolen} BB** from you!`); } catch (_) {}
    }
  }

  // Notify stealer how many attempts they have left today (only visible to them)
  if (!isAdminSteal) {
    const eightHoursAgo2 = new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString();
    const used = db.prepare("SELECT COUNT(*) as c FROM steal_log WHERE stealer_id = ? AND created_at > ?").get(userId, eightHoursAgo2).c;
    const left = Math.max(0, 8 - used);
    try { await msg.author.send(`🕵️ You have **${left} steal attempt${left !== 1 ? 's' : ''}** left this 8-hour window.`); } catch (_) {}
  }

  activeStealTargets.delete(target.id); // Release lock
});

// ============================================================================
// ANNOUNCEMENT SYSTEM
// ============================================================================
const ANNOUNCEMENT_CHANNEL_ID = process.env.CHANNEL_ANNOUNCEMENTS || '1353949538393526283';
const _pendingAnnouncements  = new Map(); // userId → { state, text, timer }
const _pendingAuctionSetups  = new Map(); // userId → { state, imageUrl, title, scheduledStart, timer }
const _announcementQueue = []; // { id, text, postAt, timeoutHandle }
let _announcementNextId = 1;

function scheduleAnnouncement(text, postAt, mention, channelId = ANNOUNCEMENT_CHANNEL_ID, format = 'embed') {
  const id = _announcementNextId++;
  const buildEmbed = (t) => new EmbedBuilder().setColor('#c9a84c').setTitle('📢 Announcement')
    .setDescription(t).setFooter({ text: "Bully's World" }).setTimestamp();
  const handle = setTimeout(async () => {
    const idx = _announcementQueue.findIndex(a => a.id === id);
    if (idx !== -1) _announcementQueue.splice(idx, 1);
    const ch = await client.channels.fetch(channelId).catch(() => null);
    if (!ch) return;
    const payload = format === 'embed'
      ? { content: mention || null, embeds: [buildEmbed(text)] }
      : { content: mention ? `${mention}\n\n${text}` : text };
    await ch.send(payload);
  }, postAt - Date.now());
  _announcementQueue.push({ id, text, postAt, mention, channelId, format, timeoutHandle: handle });
  return id;
}

// ── DM BLAST SYSTEM ──────────────────────────────────────────────────────────
const _pendingDMs = new Map(); // userId → { state, text, recipientIds, recipientLabel, timer }
const _dmQueue = []; // { id, text, recipientIds, recipientLabel, adminId, postAt, timeoutHandle }
let _dmNextId = 1;

async function resolveRecipients(guild, msg) {
  const lower = msg.content.trim().toLowerCase();
  if (lower === '@everyone') {
    const members = await guild.members.fetch();
    return { ids: members.filter(m => !m.user.bot).map(m => m.user.id), label: '@everyone' };
  }
  if (msg.mentions.roles.size > 0) {
    await guild.members.fetch();
    const ids = new Set();
    const names = [];
    msg.mentions.roles.forEach(role => {
      names.push(role.name);
      role.members.filter(m => !m.user.bot).forEach(m => ids.add(m.user.id));
    });
    return { ids: [...ids], label: names.map(n => `@${n}`).join(', ') };
  }
  if (msg.mentions.users.size > 0) {
    const users = msg.mentions.users.filter(u => !u.bot);
    return { ids: [...users.values()].map(u => u.id), label: `${users.size} specific user${users.size !== 1 ? 's' : ''}` };
  }
  return null;
}

async function executeDMBlast(text, recipientIds, adminId) {
  let sent = 0, failed = 0;
  const embed = new EmbedBuilder().setColor('#c9a84c').setTitle("📬 Message from Bully's World")
    .setDescription(text).setFooter({ text: "Bully's World" }).setTimestamp();
  for (const uid of recipientIds) {
    try {
      const user = await client.users.fetch(uid);
      await user.send({ embeds: [embed] });
      sent++;
    } catch (_) { failed++; }
    await new Promise(r => setTimeout(r, 300)); // stay within rate limits
  }
  try {
    const admin = await client.users.fetch(adminId);
    await admin.send(`✅ DM blast complete: **${sent}** delivered, **${failed}** failed (DMs closed).`);
  } catch (_) {}
}

function scheduleDMBlast(text, recipientIds, recipientLabel, adminId, postAt) {
  const id = _dmNextId++;
  const handle = setTimeout(async () => {
    const idx = _dmQueue.findIndex(d => d.id === id);
    if (idx !== -1) _dmQueue.splice(idx, 1);
    await executeDMBlast(text, recipientIds, adminId);
  }, postAt - Date.now());
  _dmQueue.push({ id, text, recipientIds, recipientLabel, adminId, postAt, timeoutHandle: handle });
  return id;
}

// ============================================================================
// ADMIN BB CONTROL COMMANDS
// ============================================================================
client.on('messageCreate', async msg => {
  if (msg.author?.bot || !msg.guild) return;
  const isAdmin = msg.author.id === process.env.OWNER_ID || msg.member?.permissions?.has(PermissionsBitField.Flags.Administrator);
  if (!isAdmin) return;
  const content = msg.content.trim();
  const lower = content.toLowerCase();

  // ── Announcement flow — capture mid-session replies before command checks ──
  if (_pendingAnnouncements.has(msg.author.id) && !lower.startsWith('!')) {
    const session = _pendingAnnouncements.get(msg.author.id);
    clearTimeout(session.timer);

    const resetTimer = () => {
      session.timer = setTimeout(() => _pendingAnnouncements.delete(msg.author.id), 5 * 60 * 1000);
    };
    const cancel = async () => {
      _pendingAnnouncements.delete(msg.author.id);
      await msg.reply('❌ Announcement cancelled.');
    };

    // Step 1 — collect the message text
    if (session.state === 'awaiting_text') {
      session.text = msg.content.trim();
      session.state = 'awaiting_channel';
      resetTimer();
      await msg.reply(
        '📡 **Which channel?**\n\n' +
        'Mention a channel (e.g. **`#announcements`**) or type **`default`** to use the default announcements channel.\n\n' +
        'Type **`cancel`** to abort.'
      );
      return;
    }

    // Step 2 — pick the target channel
    if (session.state === 'awaiting_channel') {
      if (lower === 'cancel') { await cancel(); return; }

      let targetChannel = null;
      if (lower === 'default') {
        targetChannel = await client.channels.fetch(ANNOUNCEMENT_CHANNEL_ID).catch(() => null);
      } else {
        // Accept a channel mention (#channel) or a raw ID
        targetChannel = msg.mentions.channels.first()
          ?? await client.channels.fetch(msg.content.trim().replace(/[<#>]/g, '')).catch(() => null);
      }

      if (!targetChannel?.isTextBased()) {
        resetTimer();
        await msg.reply("❌ Couldn't find that channel. Mention a channel (e.g. **`#general`**) or type **`default`**.");
        return;
      }

      session.channelId = targetChannel.id;
      session.channelName = targetChannel.name;
      session.state = 'awaiting_format';
      resetTimer();
      await msg.reply(
        '🎨 **What format?**\n\n' +
        '**`embed`** — styled card with gold border and Bully\'s World footer\n' +
        '**`plain`** — raw text, exactly as you typed it\n\n' +
        'Type **`cancel`** to abort.'
      );
      return;
    }

    // Step 3 — pick embed or plain text
    if (session.state === 'awaiting_format') {
      if (lower === 'cancel') { await cancel(); return; }

      if (!['embed', 'e', 'plain', 'p', 'text'].includes(lower)) {
        resetTimer();
        await msg.reply('❌ Reply **`embed`** or **`plain`**. Type **`cancel`** to abort.');
        return;
      }

      session.format = ['embed', 'e'].includes(lower) ? 'embed' : 'plain';
      session.state = 'awaiting_mention';
      resetTimer();
      await msg.reply(
        '🔔 **Who should be mentioned?**\n\n' +
        'Reply **`@everyone`**, **`@here`**, a role mention, or **`none`** for no ping.\n\n' +
        'Type **`cancel`** to abort.'
      );
      return;
    }

    // Step 4 — mention / ping
    if (session.state === 'awaiting_mention') {
      if (lower === 'cancel') { await cancel(); return; }
      session.mention = lower === 'none' ? '' : msg.content.trim();
      session.state = 'awaiting_time';
      resetTimer();
      await msg.reply(
        '⏰ **When should this post?**\n\n' +
        'Reply **`now`** to post immediately, or a time like **`6:00pm`** or **`8:30am`** (CT).\n\n' +
        'Type **`cancel`** to abort.'
      );
      return;
    }

    // Step 5 — schedule or post now
    if (session.state === 'awaiting_time') {
      if (lower === 'cancel') { await cancel(); return; }

      const announceCh = await client.channels.fetch(session.channelId).catch(() => null);
      if (!announceCh) {
        _pendingAnnouncements.delete(msg.author.id);
        await msg.reply('❌ Could not fetch the target channel. Announcement aborted.');
        return;
      }

      const buildEmbed = (text) => new EmbedBuilder()
        .setColor('#c9a84c').setTitle('📢 Announcement')
        .setDescription(text).setFooter({ text: "Bully's World" }).setTimestamp();

      const mention  = session.mention || '';
      const payload  = session.format === 'embed'
        ? { content: mention || null, embeds: [buildEmbed(session.text)] }
        : { content: mention ? `${mention}\n\n${session.text}` : session.text };

      if (lower === 'now') {
        _pendingAnnouncements.delete(msg.author.id);
        await announceCh.send(payload);
        await msg.reply(`✅ Announcement posted in <#${session.channelId}>!`);
      } else {
        const postAt = parseShutdownTime(lower);
        if (!postAt) {
          resetTimer();
          await msg.reply("❌ Couldn't parse that time. Try **`now`**, **`6:00pm`**, or **`14:30`**. Or type **`cancel`** to abort.");
          return;
        }
        _pendingAnnouncements.delete(msg.author.id);
        const unix = Math.floor(postAt.getTime() / 1000);
        const queuedId = scheduleAnnouncement(session.text, postAt, mention, session.channelId, session.format);
        await msg.reply(
          `✅ Announcement **#${queuedId}** queued for <t:${unix}:F> (<t:${unix}:R>) in <#${session.channelId}>.\n` +
          `Use \`!announcementqueue\` to view all queued, or \`!cancelannouncement ${queuedId}\` to remove it.`
        );
      }
      return;
    }
  }

  // ── DM blast flow — capture mid-session replies ──
  if (_pendingDMs.has(msg.author.id) && !lower.startsWith('!')) {
    const session = _pendingDMs.get(msg.author.id);
    clearTimeout(session.timer);

    if (session.state === 'awaiting_text') {
      session.text = msg.content.trim();
      session.state = 'awaiting_recipients';
      session.timer = setTimeout(() => _pendingDMs.delete(msg.author.id), 5 * 60 * 1000);
      await msg.reply('📋 Who should receive this DM?\n\nReply **`@everyone`**, a role mention like **`@Rookie`**, or tag specific users.\n\nType **`cancel`** to abort.');
      return;
    }

    if (session.state === 'awaiting_recipients') {
      if (lower === 'cancel') { _pendingDMs.delete(msg.author.id); await msg.reply('❌ DM blast cancelled.'); return; }
      const result = await resolveRecipients(msg.guild, msg);
      if (!result || result.ids.length === 0) {
        session.timer = setTimeout(() => _pendingDMs.delete(msg.author.id), 5 * 60 * 1000);
        await msg.reply("❌ Couldn't identify any recipients. Use `@everyone`, a role mention, or tag specific users. Type `cancel` to abort.");
        return;
      }
      session.recipientIds = result.ids;
      session.recipientLabel = result.label;
      session.state = 'awaiting_time';
      session.timer = setTimeout(() => _pendingDMs.delete(msg.author.id), 5 * 60 * 1000);
      await msg.reply(`✅ Recipients: **${result.label}** (${result.ids.length} member${result.ids.length !== 1 ? 's' : ''})\n\n⏰ When should this be sent?\n\nReply **\`now\`** to send immediately, or a time like **\`6:00pm\`** or **\`8:30am\`** (CT).\n\nType **\`cancel\`** to abort.`);
      return;
    }

    if (session.state === 'awaiting_time') {
      if (lower === 'cancel') { _pendingDMs.delete(msg.author.id); await msg.reply('❌ DM blast cancelled.'); return; }
      if (lower === 'now') {
        _pendingDMs.delete(msg.author.id);
        await msg.reply(`📨 Sending DMs to **${session.recipientLabel}** (${session.recipientIds.length} member${session.recipientIds.length !== 1 ? 's' : ''})...`);
        executeDMBlast(session.text, session.recipientIds, msg.author.id);
      } else {
        const postAt = parseShutdownTime(lower);
        if (!postAt) {
          session.timer = setTimeout(() => _pendingDMs.delete(msg.author.id), 5 * 60 * 1000);
          await msg.reply("❌ Couldn't parse that time. Try **`now`**, **`6:00pm`**, or **`14:30`**. Or type **`cancel`** to abort.");
          return;
        }
        _pendingDMs.delete(msg.author.id);
        const unix = Math.floor(postAt.getTime() / 1000);
        const queuedId = scheduleDMBlast(session.text, session.recipientIds, session.recipientLabel, msg.author.id, postAt);
        await msg.reply(`✅ DM blast **#${queuedId}** scheduled for <t:${unix}:F> (<t:${unix}:R>) → **${session.recipientLabel}** (${session.recipientIds.length} members).\nUse \`!dmqueue\` to view all queued, or \`!canceldm ${queuedId}\` to remove it.`);
      }
      return;
    }
  }

  // ── Auction setup flow — capture mid-session replies ─────────────────────────
  if (_pendingAuctionSetups.has(msg.author.id) && !lower.startsWith('!')) {
    const session = _pendingAuctionSetups.get(msg.author.id);
    clearTimeout(session.timer);
    const resetTimer = () => { session.timer = setTimeout(() => _pendingAuctionSetups.delete(msg.author.id), 5 * 60 * 1000); };

    if (lower === 'cancel') {
      _pendingAuctionSetups.delete(msg.author.id);
      await msg.reply('❌ Auction setup cancelled.');
      return;
    }

    if (session.state === 'awaiting_image') {
      const attachment = msg.attachments.first();
      if (!attachment || !attachment.contentType?.startsWith('image')) {
        resetTimer();
        await msg.reply('❌ Please upload an image file. Try again or type `cancel` to abort.');
        return;
      }
      session.imageUrl = attachment.url;
      session.state = 'awaiting_title';
      resetTimer();
      await msg.reply('✏️ **Step 2/4** — What\'s the title of this piece?');
      return;
    }

    if (session.state === 'awaiting_title') {
      session.title = msg.content.trim();
      session.state = 'awaiting_timing';
      resetTimer();
      await msg.reply(
        '📅 **Step 3/4** — When should the auction go live?\n\n' +
        'Type **`now`** to start immediately, or enter a date and time:\n' +
        '**`MM/DD/YYYY HH:MM`** *(Central Time)*\n' +
        'Example: `06/20/2026 18:00`'
      );
      return;
    }

    if (session.state === 'awaiting_timing') {
      if (lower === 'now') {
        session.scheduledStart = new Date();
      } else {
        const parsed = parseCTString(msg.content.trim());
        if (!parsed) {
          resetTimer();
          await msg.reply('❌ Invalid format. Use `MM/DD/YYYY HH:MM` (CT), type `now`, or type `cancel` to abort.');
          return;
        }
        if (parsed.getTime() <= Date.now()) {
          resetTimer();
          await msg.reply('❌ That time is in the past. Enter a future date/time or type `now`.');
          return;
        }
        session.scheduledStart = parsed;
      }
      session.timingInput = msg.content.trim();
      session.state = 'awaiting_duration';
      resetTimer();
      await msg.reply('⏱️ **Step 4/4** — How long should the auction run?\nExamples: `4 hours` · `12 hours` · `24 hours` · `2 days`');
      return;
    }

    if (session.state === 'awaiting_duration') {
      const durationMins = parseDuration(msg.content.trim());
      if (!durationMins) {
        resetTimer();
        await msg.reply('❌ Invalid duration. Try `4 hours`, `12 hours`, or `2 days`. Or type `cancel` to abort.');
        return;
      }
      _pendingAuctionSetups.delete(msg.author.id);

      const { imageUrl, title, scheduledStart, timingInput } = session;
      const isNow = scheduledStart.getTime() <= Date.now() + 5000;

      const insertResult = db.prepare(
        `INSERT INTO auctions (title, starting_bid, image_url, status, scheduled_start, duration_minutes, ends_at)
         VALUES (?, 50, ?, 'scheduled', ?, ?, ?)`
      ).run(title, imageUrl, scheduledStart.toISOString(), durationMins, scheduledStart.toISOString());
      const newId = insertResult.lastInsertRowid;

      // Hide the auction channel until the auction goes live
      await setAuctionChannelVisible(false);

      const delay = Math.max(0, scheduledStart.getTime() - Date.now());
      setTimeout(() => startScheduledAuction(newId), delay);

      if (isNow) {
        await msg.reply(`✅ **Auction is going live now!** 🎨 **${title}**`);
      } else {
        const unix = Math.floor(scheduledStart.getTime() / 1000);
        await msg.reply(
          `✅ **Auction scheduled!**\n\n` +
          `🎨 **${title}**\n` +
          `📅 Goes live: <t:${unix}:F> (<t:${unix}:R>)\n` +
          `⏱️ Duration: ${msg.content.trim()}\n` +
          `🆔 ID: \`#${newId}\``
        );
      }
      return;
    }
  }

  // ── !auction ──
  if (lower === '!auction') {
    if (_pendingAuctionSetups.has(msg.author.id)) {
      const old = _pendingAuctionSetups.get(msg.author.id);
      clearTimeout(old.timer);
      _pendingAuctionSetups.delete(msg.author.id);
    }
    const timer = setTimeout(() => _pendingAuctionSetups.delete(msg.author.id), 5 * 60 * 1000);
    _pendingAuctionSetups.set(msg.author.id, { state: 'awaiting_image', timer });
    await msg.reply('📸 **Step 1/4** — Upload the image of the item you\'re auctioning.\n\nType `cancel` at any time to abort.');
    return;
  }

  // ── !selfroles — post or refresh the self-role panels ──
  if (lower === '!selfroles') {
    const ch = await client.channels.fetch(SELF_ROLE_CHANNEL_ID).catch(() => null);
    if (!ch) { await msg.reply('❌ Could not find the self-roles channel.'); return; }
    await ch.send(buildInterestsBanner());
    await ch.send(buildInterestsPanel());
    await ch.send(buildWatchBanner());
    await ch.send(buildWatchPanel());
    await msg.reply(`✅ Self-role panels posted in <#${SELF_ROLE_CHANNEL_ID}>!`);
    return;
  }

  // ── !announcement ──
  if (lower === '!announcement') {
    if (_pendingAnnouncements.has(msg.author.id)) {
      const old = _pendingAnnouncements.get(msg.author.id);
      clearTimeout(old.timer);
      _pendingAnnouncements.delete(msg.author.id);
      await msg.reply('Previous announcement session cleared. Starting fresh.\n\n📢 What would you like to announce? Type your message now.\n\nType **`cancel`** at any point to abort.');
    } else {
      await msg.reply('📢 What would you like to announce? Type your message now.\n\nType **`cancel`** at any point to abort.');
    }
    const timer = setTimeout(() => _pendingAnnouncements.delete(msg.author.id), 5 * 60 * 1000);
    _pendingAnnouncements.set(msg.author.id, { state: 'awaiting_text', text: null, timer });
    return;
  }

  // ── !announcementqueue ──
  if (lower === '!announcementqueue') {
    if (_announcementQueue.length === 0) {
      await msg.reply('📭 No announcements are currently queued.');
      return;
    }
    const lines = _announcementQueue.map(a => {
      const unix = Math.floor(a.postAt / 1000);
      const preview = a.text.length > 80 ? a.text.slice(0, 80) + '…' : a.text;
      const chTag = a.channelId ? `<#${a.channelId}>` : '#announcements';
      const fmt   = a.format === 'plain' ? 'plain text' : 'embed';
      return `**#${a.id}** — <t:${unix}:F> (<t:${unix}:R>) · ${chTag} · ${fmt}\n> ${preview}`;
    });
    const embed = new EmbedBuilder().setColor('#c9a84c').setTitle(`📢 Announcement Queue (${_announcementQueue.length})`)
      .setDescription(lines.join('\n\n'))
      .setFooter({ text: 'Use !cancelannouncement [id] to remove one' }).setTimestamp();
    await msg.reply({ embeds: [embed] });
    return;
  }

  // ── !cancelannouncement [id] ──
  if (lower.startsWith('!cancelannouncement')) {
    const parts = lower.split(' ');
    const id = parseInt(parts[1], 10);
    if (isNaN(id)) { await msg.reply('Usage: `!cancelannouncement [id]` — get IDs from `!announcementqueue`'); return; }
    const idx = _announcementQueue.findIndex(a => a.id === id);
    if (idx === -1) { await msg.reply(`❌ No queued announcement with ID **#${id}**.`); return; }
    clearTimeout(_announcementQueue[idx].timeoutHandle);
    _announcementQueue.splice(idx, 1);
    await msg.reply(`✅ Announcement **#${id}** cancelled and removed from the queue.`);
    return;
  }

  // ── !dm ──
  if (lower === '!dm') {
    if (_pendingDMs.has(msg.author.id)) {
      const old = _pendingDMs.get(msg.author.id);
      clearTimeout(old.timer);
      _pendingDMs.delete(msg.author.id);
      await msg.reply('Previous DM session cleared. Starting fresh.\n\n📬 What message would you like to send? Type it now.\n\nType **`cancel`** at any point to abort.');
    } else {
      await msg.reply('📬 What message would you like to DM? Type it now.\n\nType **`cancel`** at any point to abort.');
    }
    const timer = setTimeout(() => _pendingDMs.delete(msg.author.id), 5 * 60 * 1000);
    _pendingDMs.set(msg.author.id, { state: 'awaiting_text', text: null, recipientIds: [], recipientLabel: '', timer });
    return;
  }

  // ── !dmqueue ──
  if (lower === '!dmqueue') {
    if (_dmQueue.length === 0) { await msg.reply('📭 No DM blasts are currently queued.'); return; }
    const lines = _dmQueue.map(d => {
      const unix = Math.floor(d.postAt / 1000);
      const preview = d.text.length > 60 ? d.text.slice(0, 60) + '…' : d.text;
      return `**#${d.id}** → **${d.recipientLabel}** (${d.recipientIds.length}) — <t:${unix}:F> (<t:${unix}:R>)\n> ${preview}`;
    });
    const embed = new EmbedBuilder().setColor('#c9a84c').setTitle(`📬 DM Queue (${_dmQueue.length})`)
      .setDescription(lines.join('\n\n'))
      .setFooter({ text: 'Use !canceldm [id] to remove one' }).setTimestamp();
    await msg.reply({ embeds: [embed] });
    return;
  }

  // ── !canceldm [id] ──
  if (lower.startsWith('!canceldm')) {
    const id = parseInt(lower.split(' ')[1], 10);
    if (isNaN(id)) { await msg.reply('Usage: `!canceldm [id]` — get IDs from `!dmqueue`'); return; }
    const idx = _dmQueue.findIndex(d => d.id === id);
    if (idx === -1) { await msg.reply(`❌ No queued DM blast with ID **#${id}**.`); return; }
    clearTimeout(_dmQueue[idx].timeoutHandle);
    _dmQueue.splice(idx, 1);
    await msg.reply(`✅ DM blast **#${id}** cancelled and removed from the queue.`);
    return;
  }

  // ── !adminhelp ──
  if (lower === '!adminhelp') {
    const embed = new EmbedBuilder()
      .setColor('#FF4500')
      .setTitle("🛠️ Bully's World — Admin Panel")
      .setDescription('Pick a category to see its commands. All responses are visible only to you.')
      .setFooter({ text: "Bully's World Admin • Use responsibly." })
      .setTimestamp();
    const row1 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('admin.bb').setLabel('💰 BB Control').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('admin.events').setLabel('📅 Events').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('admin.games').setLabel('🎮 Games').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('admin.clubs').setLabel('👥 Clubs').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('admin.comms').setLabel('📣 Comms').setStyle(ButtonStyle.Secondary),
    );
    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('admin.dailyq').setLabel('🗓️ Daily Q').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('admin.auction').setLabel('🔨 Auction').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('admin.system').setLabel('🔧 System').setStyle(ButtonStyle.Secondary),
    );
    await msg.reply({ embeds: [embed], components: [row1, row2] }); return;
  }

  // ── !set @user [amount] ──
  if (lower.startsWith('!set ')) {
    const target = msg.mentions.users.first();
    const parts = content.split(' ');
    const amount = parseInt(parts[parts.length - 1]);
    if (!target) { await msg.reply('Usage: `!set @user [amount]`'); return; }
    if (isNaN(amount) || amount < 0) { await msg.reply('Usage: `!set @user [amount]` — amount must be 0 or more'); return; }
    getUser(target.id, target.username); // ensure row exists
    db.prepare('UPDATE balances SET balance = ? WHERE user_id = ?').run(amount, target.id);
    await msg.reply(`✅ **${target.username}'s** balance set to **${amount} BB**.`);
    return;
  }

  // ── !resetall ──
  if (lower === '!resetall') {
    await msg.reply("⚠️ Are you sure you want to set **EVERYONE's** balance to 0? Type `!resetall confirm` to proceed.");
    return;
  }
  if (lower === '!resetall confirm') {
    const count = db.prepare('SELECT COUNT(*) as c FROM balances').get()?.c || 0;
    db.prepare('UPDATE balances SET balance = 0').run();
    await msg.reply(`✅ Reset **${count}** user balance${count !== 1 ? 's' : ''} to **0 BB**.`);
    return;
  }

  // ── !giftall [amount] — gift every server member (creates records if needed) ──
  if (lower.startsWith('!giftall ') && !lower.endsWith(' confirm') && !msg.mentions.roles.size) {
    const amount = parseInt(content.split(' ')[1]);
    if (isNaN(amount) || amount < 1) { await msg.reply('Usage: `!giftall [amount]` — gifts every server member. Add **confirm** to proceed.'); return; }
    const guild = await client.guilds.fetch(CONFIG.GUILD_ID);
    const members = await guild.members.fetch();
    const humans = members.filter(m => !m.user.bot);
    await msg.reply(`⚠️ Gift **${amount} BB** to all **${humans.size}** server members? Type **!giftall ${amount} confirm** to proceed.`);
    return;
  }
  if (lower.startsWith('!giftall ') && lower.endsWith(' confirm') && !msg.mentions.roles.size) {
    const amount = parseInt(content.split(' ')[1]);
    if (isNaN(amount) || amount < 1) { await msg.reply('Usage: `!giftall [amount] confirm`'); return; }
    const guild = await client.guilds.fetch(CONFIG.GUILD_ID);
    const members = await guild.members.fetch();
    const humans = members.filter(m => !m.user.bot);
    humans.forEach(m => addBB(m.id, m.user.username, amount, 'mass gift from admin'));
    await msg.reply(`✅ Gifted **${amount} BB** to **${humans.size}** server members.`);
    return;
  }

  // ── !giveall [amount] — confirm must be checked FIRST ──
  if (lower.startsWith('!giveall ') && lower.endsWith(' confirm')) {
    const amount = parseInt(content.split(' ')[1]);
    if (isNaN(amount) || amount < 1) { await msg.reply('Usage: `!giveall [amount] confirm`'); return; }
    db.prepare('UPDATE balances SET balance = balance + ?, total_earned = total_earned + ?').run(amount, amount);
    const count = db.prepare('SELECT COUNT(*) as c FROM balances').get()?.c || 0;
    await msg.reply(`✅ Gave **${amount} BB** to **${count}** users.`);
    return;
  }
  if (lower.startsWith('!giveall ')) {
    const amount = parseInt(content.split(' ')[1]);
    if (isNaN(amount) || amount < 1) { await msg.reply('Usage: `!giveall [amount]`'); return; }
    await msg.reply(`⚠️ Give **${amount} BB** to every user in the DB? Type **!giveall ${amount} confirm** to proceed.`);
    return;
  }

  // ── !giverole @role [amount] ──
  if (lower.startsWith('!giverole ')) {
    const role = msg.mentions.roles.first();
    const parts = content.trim().split(/\s+/);
    const amount = parseInt(parts[parts.length - 1]);
    if (!role) { await msg.reply('Usage: `!giverole @role [amount]`'); return; }
    if (isNaN(amount) || amount < 1) { await msg.reply('Usage: `!giverole @role [amount]`'); return; }

    await msg.reply(`⏳ Fetching members with **${role.name}**...`);
    const guild = await client.guilds.fetch(CONFIG.GUILD_ID);
    await guild.members.fetch(); // pull full member list
    const members = guild.members.cache.filter(m => m.roles.cache.has(role.id) && !m.user.bot);
    if (!members.size) { await msg.reply(`No members found with the **${role.name}** role.`); return; }

    let count = 0;
    for (const [, member] of members) {
      addBB(member.user.id, member.user.username, amount, `admin gift to ${role.name}`);
      count++;
    }
    await msg.reply(`✅ Gave **${amount} BB** to **${count}** member${count !== 1 ? 's' : ''} with the **${role.name}** role.`);
    return;
  }

  // ── !testgive ──
  if (lower.startsWith('!testgive')) {
    const parts = content.split(' '), target = msg.mentions.users.first();
    const amount = parseInt(parts[target ? 2 : 1]);
    if (isNaN(amount) || amount < 1) { await msg.reply('Usage: `!testgive [amount]` or `!testgive @user [amount]`'); return; }
    const tid = target?.id || msg.author.id, tname = target?.username || msg.author.username;
    addBB(tid, tname, amount, '[ADMIN] gift');
    await msg.reply(`✅ Gave **${amount} BB** to **${tname}**. Balance: **${db.prepare('SELECT balance FROM balances WHERE user_id = ?').get(tid)?.balance || 0} BB**`); return;
  }

  // ── !testtake ──
  if (lower.startsWith('!testtake')) {
    const amount = parseInt(content.split(' ')[1]);
    if (isNaN(amount) || amount < 1) { await msg.reply('Usage: `!testtake [amount]`'); return; }
    db.prepare('UPDATE balances SET balance = MAX(0, balance - ?) WHERE user_id = ?').run(amount, msg.author.id);
    await msg.reply(`✅ Removed **${amount} BB**. Balance: **${db.prepare('SELECT balance FROM balances WHERE user_id = ?').get(msg.author.id)?.balance || 0} BB**`); return;
  }

  if (lower === '!testbalance') { const r = db.prepare('SELECT balance, total_earned FROM balances WHERE user_id = ?').get(msg.author.id); await msg.reply(`💰 Balance: **${r?.balance || 0} BB** · Total earned: **${r?.total_earned || 0} BB**`); return; }
  if (lower === '!testreset') { db.prepare('UPDATE balances SET balance = 0 WHERE user_id = ?').run(msg.author.id); await msg.reply('✅ Balance reset to **0 BB**.'); return; }

  if (lower === '!testcasino') { if (!activeCasino) { await openCasino(); await msg.reply('✅ Casino opened!'); } else { await msg.reply('Casino is already open.'); } return; }
  if (lower === '!testshop') { await refreshShop(); await msg.reply('✅ Shop refreshed!'); return; }
  if (lower === '!testshopview') { if (!activeShop.length) { await msg.reply('Shop empty — run `!testshop` first.'); return; } await msg.reply(activeShop.map((e, i) => `**${i + 1}.** ${e.roleName || e.item.label} — **${e.item.cost} BB** [${e.item.type}]`).join('\n')); return; }

  if (lower === '!testheiststart') {
    if (!activeHeists.size) { await msg.reply('❌ No active heist. Start one via `!bullygames` → Heist.'); return; }
    const firstId = activeHeists.keys().next().value;
    const t = heistTimers.get(firstId); if (t) { clearTimeout(t); heistTimers.delete(firstId); }
    await msg.reply('🚀 Force-launching heist!'); await executeHeist(firstId, msg.channel); return;
  }
  if (lower === '!testheistcancel') {
    if (!activeHeists.size) { await msg.reply('❌ No active heist.'); return; }
    const firstId = activeHeists.keys().next().value;
    const hData = activeHeists.get(firstId);
    hData.crew.forEach(m => addBB(m.id, m.username, hData.heist.entry, 'admin cancel — refund'));
    const t = heistTimers.get(firstId); if (t) { clearTimeout(t); heistTimers.delete(firstId); }
    const name = hData.heist.name; activeHeists.delete(firstId); await cleanupHeistMessages(firstId);
    await msg.reply(`✅ **${name}** cancelled and fees refunded.`); return;
  }
  if (lower === '!testingmode on' || lower === '!testingmodeon') { TESTING_MODE = true; await msg.reply('🔒 Testing mode **ON** — only admins and @tester can use the bot.'); return; }
  if (lower === '!testingmode off' || lower === '!testingmodeoff') { TESTING_MODE = false; await msg.reply('✅ Testing mode **OFF** — bot is open to everyone.'); return; }

  // ── Neighborhood Watch admin commands ─────────────────────────────────────────
  if (lower === '!postnw') {
    await msg.reply('♻️ Re-posting Neighborhood Watch ticket button...');
    await postNWChannelButton();
    await msg.reply('✅ Done.');
    return;
  }

  if (lower.startsWith('!nwstrikes')) {
    const target = msg.mentions.users.first();
    const targetId = target?.id || parts[1];
    if (!targetId) { await msg.reply('Usage: `!nwstrikes @user`'); return; }
    const now = new Date().toISOString();
    const allStrikes = db.prepare('SELECT * FROM nw_strikes WHERE user_id = ? ORDER BY issued_at DESC').all(targetId);
    const activeStrikes = allStrikes.filter(s => s.expires_at > now && s.appeal_outcome !== 'overturned');
    if (!allStrikes.length) { await msg.reply(`No strikes found for <@${targetId}>.`); return; }
    const lines = allStrikes.map(s => {
      const active = s.expires_at > now && s.appeal_outcome !== 'overturned';
      return `• Report #${s.report_id} — ${active ? '🔴 Active' : '⚫ Expired/Overturned'} | Issued <t:${Math.floor(new Date(s.issued_at).getTime()/1000)}:D> | Expires <t:${Math.floor(new Date(s.expires_at).getTime()/1000)}:D>`;
    });
    await msg.reply(`**Strikes for <@${targetId}>:** ${activeStrikes.length} active / ${allStrikes.length} total\n${lines.join('\n')}`);
    return;
  }

  if (lower.startsWith('!nwclearstrikes')) {
    const target = msg.mentions.users.first();
    if (!target) { await msg.reply('Usage: `!nwclearstrikes @user`'); return; }
    db.prepare('DELETE FROM nw_strikes WHERE user_id = ?').run(target.id);
    await msg.reply(`✅ All strikes cleared for <@${target.id}>.`);
    return;
  }

  if (lower.startsWith('!nwresolve')) {
    const reportId = parseInt(parts[1]);
    if (isNaN(reportId)) { await msg.reply('Usage: `!nwresolve <reportId>`'); return; }
    const report = db.prepare('SELECT * FROM nw_reports WHERE id = ?').get(reportId);
    if (!report) { await msg.reply(`❌ Report #${reportId} not found.`); return; }
    if (report.status !== 'voting') { await msg.reply(`ℹ️ Report #${reportId} is already resolved (status: \`${report.status}\`).`); return; }
    await msg.reply(`⏩ Force-resolving Report #${reportId}…`);
    await resolveNWReport(reportId);
    const updated = db.prepare('SELECT status FROM nw_reports WHERE id = ?').get(reportId);
    await msg.reply(`✅ Report #${reportId} resolved → status: \`${updated?.status}\``);
    return;
  }

  if (lower === '!nwlist') {
    const reports = db.prepare('SELECT id, status, accused_info, created_at FROM nw_reports ORDER BY id DESC LIMIT 10').all();
    if (!reports.length) { await msg.reply('No NW reports in the database.'); return; }
    const lines = reports.map(r => `**#${r.id}** \`${r.status}\` — accused: ${r.accused_info || '_unknown_'} — <t:${Math.floor(new Date(r.created_at).getTime()/1000)}:R>`).join('\n');
    await msg.reply({ embeds: [new EmbedBuilder().setColor('#1E3A5F').setTitle('👮‍♀️ Recent NW Reports').setDescription(lines)] });
    return;
  }

  // ── !superfan add/remove/list ──────────────────────────────────────────────
  if (lower.startsWith('!superfan')) {
    const superfanRoleId = process.env.ROLE_SUPERFAN;
    if (!superfanRoleId) { await msg.reply('❌ `ROLE_SUPERFAN` is not set in your environment variables. Create a Superfan role in Discord, copy its ID, and add it as `ROLE_SUPERFAN` in Railway.'); return; }
    const sub    = lower.split(' ')[1];
    const target = msg.mentions.members.first();
    const guild  = await client.guilds.fetch(CONFIG.GUILD_ID);
    const role   = guild.roles.cache.get(superfanRoleId) || await guild.roles.fetch(superfanRoleId).catch(() => null);
    if (!role) { await msg.reply('❌ Superfan role not found. Check `ROLE_SUPERFAN` in Railway.'); return; }

    if (sub === 'add') {
      if (!target) { await msg.reply('Usage: `!superfan add @user`'); return; }
      await target.roles.add(role).catch(() => {});
      // guildMemberUpdate fires automatically and handles the paycheck + DM
      await msg.reply(`✅ <@${target.id}> has been added to the Superfan Club. They'll receive a welcome DM and their first paycheck.`);
      return;
    }

    if (sub === 'remove') {
      if (!target) { await msg.reply('Usage: `!superfan remove @user`'); return; }
      await target.roles.remove(role).catch(() => {});
      await msg.reply(`✅ Removed Superfan Club status from <@${target.id}>.`);
      return;
    }

    if (sub === 'list') {
      await guild.members.fetch();
      const superfans = guild.members.cache.filter(m => m.roles.cache.has(superfanRoleId));
      if (!superfans.size) { await msg.reply('No current superfans.'); return; }
      const lines = [...superfans.values()].map(m => `• ${m.user.username}`).join('\n');
      await msg.reply({ embeds: [new EmbedBuilder().setColor('#ff6b35').setTitle(`🔥 Superfan Club (${superfans.size})`).setDescription(lines).setTimestamp()] });
      return;
    }

    await msg.reply('Usage: `!superfan add @user` · `!superfan remove @user` · `!superfan list`');
    return;
  }

  // ── !boosterlist ──────────────────────────────────────────────────────────
  if (lower === '!boosterlist') {
    const boosterRoleId = process.env.ROLE_BOOSTER;
    if (!boosterRoleId) { await msg.reply('❌ `ROLE_BOOSTER` is not set in env vars.'); return; }
    const guild = await client.guilds.fetch(CONFIG.GUILD_ID);
    await guild.members.fetch();
    const boosters = guild.members.cache.filter(m => m.roles.cache.has(boosterRoleId) && !m.user.bot);
    if (!boosters.size) { await msg.reply('No active boosters right now.'); return; }
    const lines = [...boosters.values()].map(m => `• ${m.user.username}`).join('\n');
    await msg.reply({ embeds: [new EmbedBuilder().setColor('#f47fff').setTitle(`🧡 Booster Club (${boosters.size})`).setDescription(lines).setTimestamp()] });
    return;
  }

  // ── !payboost / !paysuperfan — manual trigger ─────────────────────────────
  if (lower === '!payboost') {
    await msg.reply('⏳ Running booster payouts…');
    const r = await runBoosterPayouts();
    if (r.error)               await msg.reply(`❌ Booster payout failed: \`${r.error}\``);
    else if (r.reason === 'no_boosters') await msg.reply('ℹ️ No active server boosters found — nothing to pay.');
    else                       await msg.reply(`✅ Booster payouts complete — **${r.paid} paid**, ${r.skipped} already paid this week.`);
    return;
  }
  if (lower === '!paysuperfan') {
    await msg.reply('⏳ Running superfan payouts…');
    const r = await runSuperfanPayouts();
    if (r.error)               await msg.reply(`❌ Superfan payout failed: \`${r.error}\``);
    else if (r.reason === 'missing_env') await msg.reply('❌ **`ROLE_SUPERFAN` is not set** in your environment variables — payouts are disabled.\n\nAdd `ROLE_SUPERFAN=<role_id>` in Railway → Variables, then re-deploy.');
    else if (r.reason === 'no_members') await msg.reply('ℹ️ No members with the Superfan role found — nothing to pay.');
    else                       await msg.reply(`✅ Superfan payouts complete — **${r.paid} paid**, ${r.skipped} already paid this week.`);
    return;
  }

  if (lower === '!testlottery') { await msg.reply('🎟️ Triggering lottery...'); await runLottery(); return; }
  if (lower === '!testchest') { await msg.reply('📦 Spawning chest...'); await spawnTreasureChest(); return; }
  if (lower === '!testdrop') { await msg.reply('✨ Triggering drop...'); await postMysteryDrop(); return; }
  if (lower === '!testcheckin') { db.prepare('UPDATE balances SET last_checkin = NULL WHERE user_id = ?').run(msg.author.id); await msg.reply('✅ Check-in cooldown cleared. Use `!checkin` now.'); return; }

  if (lower === '!adminstatus') {
    const users = db.prepare('SELECT COUNT(*) as c FROM balances').get()?.c || 0;
    const totalBB = db.prepare('SELECT SUM(balance) as s FROM balances').get()?.s || 0;
    await msg.reply({ embeds: [new EmbedBuilder().setColor('#c9a84c').setTitle('🛠️ Bot Status')
      .addFields(
        { name: '👥 Users', value: `${users}`, inline: true },
        { name: '💰 BB in Economy', value: `${totalBB.toLocaleString()} BB`, inline: true },
        { name: '🎰 Casino', value: activeCasino ? '🟢 Open' : '🔴 Closed', inline: true },
        { name: '🦹 Heists', value: activeHeists.size ? `${activeHeists.size} running` : 'None', inline: true },
        { name: '🏇 Races', value: `${_races.size} running`, inline: true },
        { name: '🛍️ Shop', value: `${activeShop.length} items`, inline: true },
        { name: '🔒 Test Mode', value: TESTING_MODE ? '✅ ON' : '❌ OFF', inline: true },
      ).setFooter({ text: "Bully's World Admin" }).setTimestamp()] }); return;
  }
});

// ============================================================================
// CONSTRUCTION ZONE SYSTEM
// ============================================================================

const CONSTRUCTION_CHANNEL_ID = process.env.CHANNEL_CONSTRUCTION || '1498196898677395609';
const _EVERYONE_ID = CONFIG.EVERYONE_ROLE_ID;

let _constructionActive = false;
let _constructionMsgId  = null;
let _scheduledStart     = null;
let _scheduledEnd       = null;
let _savedOverwrites    = [];

function parseShutdownTime(str) {
  if (!str) return null;
  str = str.trim().toLowerCase();
  let hours, minutes;
  const ampm = str.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)$/);
  const mil   = str.match(/^(\d{1,2}):(\d{2})$/);
  if (ampm) {
    hours   = parseInt(ampm[1]);
    minutes = parseInt(ampm[2] || '0');
    if (ampm[3] === 'pm' && hours !== 12) hours += 12;
    if (ampm[3] === 'am' && hours === 12) hours = 0;
  } else if (mil) {
    hours   = parseInt(mil[1]);
    minutes = parseInt(mil[2]);
  } else {
    return null;
  }
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const p = Object.fromEntries(fmt.formatToParts(now).map(x => [x.type, x.value]));
  const ctNowHour = parseInt(p.hour === '24' ? '0' : p.hour);
  const ctNowMin  = parseInt(p.minute);
  let daysToAdd = (hours < ctNowHour || (hours === ctNowHour && minutes <= ctNowMin)) ? 1 : 0;
  const dd = String(parseInt(p.day) + daysToAdd).padStart(2, '0');
  const hh = String(hours).padStart(2, '0');
  const mm = String(minutes).padStart(2, '0');
  const isoLike = `${p.year}-${p.month}-${dd}T${hh}:${mm}:00`;
  const tempDate = new Date(isoLike + 'Z');
  const tzName = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', timeZoneName: 'shortOffset' }).formatToParts(tempDate).find(x => x.type === 'timeZoneName')?.value || 'GMT-5';
  const offsetMatch = tzName.match(/GMT([+-])(\d+)(?::(\d+))?/);
  const offsetHours = offsetMatch ? parseInt(offsetMatch[1] + offsetMatch[2]) : -5;
  const target = new Date(isoLike + 'Z');
  target.setUTCHours(target.getUTCHours() - offsetHours);
  return target;
}

async function activateConstructionZone(returnMessage) {
  if (_constructionActive) return;
  _constructionActive = true;
  console.log('[Construction] Activating...');
  try {
    const guild = await client.guilds.fetch(CONFIG.GUILD_ID);
    const channels = await guild.channels.fetch();
    _savedOverwrites = [];
    for (const [id, ch] of channels) {
      if (!ch || id === CONSTRUCTION_CHANNEL_ID) continue;
      const ow = ch.permissionOverwrites?.cache.get(_EVERYONE_ID);
      _savedOverwrites.push({ channelId: id, allow: ow?.allow?.bitfield ?? 0n, deny: ow?.deny?.bitfield ?? 0n });
      await ch.permissionOverwrites.edit(_EVERYONE_ID, { ViewChannel: false }).catch(() => {});
    }
    const cch = await guild.channels.fetch(CONSTRUCTION_CHANNEL_ID).catch(() => null);
    if (cch) {
      await cch.permissionOverwrites.edit(_EVERYONE_ID, { ViewChannel: true, SendMessages: false });
      const returnStr = returnMessage ? `\n\n🕐 **Expected return:** ${returnMessage}` : '\n\n⏳ We\'ll be back soon. Sit tight.';
      const embed = new EmbedBuilder().setColor('#FF6B1A').setTitle('🚧  BULLY\'S WORLD IS UNDER CONSTRUCTION')
        .setDescription('We\'re making some big changes behind the scenes.\n\nThe server will be back up shortly with new updates and improvements.' + returnStr + '\n\nThank you for your patience! 🧡')
        .setFooter({ text: "Bully's World • Back soon." }).setTimestamp();
      try { await cch.bulkDelete(10).catch(() => {}); } catch (_) {}
      const m = await cch.send({ embeds: [embed] });
      _constructionMsgId = m.id;
      await m.pin().catch(() => {});
    }
    console.log('[Construction] Server shut down.');
  } catch (err) {
    console.error('[Construction] Error activating:', err.message);
    _constructionActive = false;
  }
}

async function deactivateConstructionZone() {
  if (!_constructionActive) return;
  _constructionActive = false;
  console.log('[Construction] Restoring...');
  try {
    const guild = await client.guilds.fetch(CONFIG.GUILD_ID);
    for (const saved of _savedOverwrites) {
      const ch = await guild.channels.fetch(saved.channelId).catch(() => null);
      if (!ch) continue;
      await ch.permissionOverwrites.edit(_EVERYONE_ID, { ViewChannel: null }).catch(() => {});
    }
    _savedOverwrites = [];
    const cch = await guild.channels.fetch(CONSTRUCTION_CHANNEL_ID).catch(() => null);
    if (cch) {
      await cch.permissionOverwrites.edit(_EVERYONE_ID, { ViewChannel: false });
      if (_constructionMsgId) {
        const m = await cch.messages.fetch(_constructionMsgId).catch(() => null);
        if (m) await m.delete().catch(() => {});
        _constructionMsgId = null;
      }
    }
    const general = await client.channels.fetch(CONFIG.CHANNELS.GENERAL).catch(() => null);
    if (general) {
      const embed = new EmbedBuilder().setColor('#3B6D11').setTitle("🎉 Bully's World is back!")
        .setDescription("We're back online. Thanks for your patience!\n\nCheck out what's new and get back in the game. 🧡")
        .setFooter({ text: "Bully's World • We're live." }).setTimestamp();
      await general.send({ content: GAMER_PING, embeds: [embed] });
    }
    console.log('[Construction] Server restored.');
  } catch (err) {
    console.error('[Construction] Error deactivating:', err.message);
  }
}

client.on('messageCreate', async msg => {
  if (msg.author?.bot || !msg.guild) return;
  const isAdmin = msg.author.id === process.env.OWNER_ID || msg.member?.permissions?.has(PermissionsBitField.Flags.Administrator);
  if (!isAdmin) return;
  const raw   = msg.content.trim();
  const lower = raw.toLowerCase();
  const parts = raw.split(/\s+/);

  if (lower.startsWith('!servershutdown')) {
    const quotedMatch = raw.match(/"([^"]+)"/);
    const returnMessage = quotedMatch ? quotedMatch[1] : null;
    const timeStr = parts[1] && !parts[1].startsWith('"') ? parts[1] : null;
    if (timeStr) {
      const startAt = parseShutdownTime(timeStr);
      if (!startAt) { await msg.reply('❌ Bad time format. Use: `6:00am`, `11:30pm`, or `14:00`.'); return; }
      const msUntil = startAt - Date.now();
      if (_scheduledStart) clearTimeout(_scheduledStart);
      _scheduledStart = setTimeout(() => activateConstructionZone(returnMessage), msUntil);
      await msg.reply(`✅ Shutdown scheduled for <t:${Math.floor(startAt.getTime()/1000)}:F> (<t:${Math.floor(startAt.getTime()/1000)}:R>).\nReturn message: *${returnMessage || 'none'}*\n\nCancel with \`!cancelschedule\``);
    } else {
      await msg.reply('✅ Activating construction zone now...');
      await activateConstructionZone(returnMessage);
    }
    return;
  }

  if (lower === '!serverrestore') {
    if (!_constructionActive) { await msg.reply('❌ Server is not in construction mode.'); return; }
    await msg.reply('✅ Restoring server...');
    await deactivateConstructionZone();
    return;
  }

  if (lower.startsWith('!schedulerestore')) {
    const timeStr = parts[1];
    if (!timeStr) { await msg.reply('Usage: `!schedulerestore 8:00am`'); return; }
    const endAt = parseShutdownTime(timeStr);
    if (!endAt) { await msg.reply('❌ Bad time format. Use: `8:00am`, `12:00pm`, or `20:00`.'); return; }
    if (_scheduledEnd) clearTimeout(_scheduledEnd);
    _scheduledEnd = setTimeout(() => deactivateConstructionZone(), endAt - Date.now());
    await msg.reply(`✅ Restore scheduled for <t:${Math.floor(endAt.getTime()/1000)}:F> (<t:${Math.floor(endAt.getTime()/1000)}:R>).\n\nCancel with \`!cancelschedule\``);
    return;
  }

  if (lower === '!cancelschedule') {
    const cancelled = [];
    if (_scheduledStart) { clearTimeout(_scheduledStart); _scheduledStart = null; cancelled.push('scheduled shutdown'); }
    if (_scheduledEnd)   { clearTimeout(_scheduledEnd);   _scheduledEnd   = null; cancelled.push('scheduled restore'); }
    await msg.reply(cancelled.length ? `✅ Cancelled: **${cancelled.join(' and ')}**.` : 'Nothing was scheduled.');
    return;
  }

  if (lower === '!constructionstatus') {
    await msg.reply([
      `**Construction mode:** ${_constructionActive ? '🚧 ACTIVE' : '✅ Off'}`,
      `**Scheduled shutdown:** ${_scheduledStart ? '⏳ Pending' : 'None'}`,
      `**Scheduled restore:**  ${_scheduledEnd   ? '⏳ Pending' : 'None'}`,
    ].join('\n'));
    return;
  }
});

// Hide construction channel on boot if not active
client.once('ready', async () => {
  if (!_constructionActive) {
    try {
      const guild = await client.guilds.fetch(CONFIG.GUILD_ID);
      const cch = await guild.channels.fetch(CONSTRUCTION_CHANNEL_ID).catch(() => null);
      if (cch) await cch.permissionOverwrites.edit(_EVERYONE_ID, { ViewChannel: false }).catch(() => {});
    } catch (_) {}
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ─── NEIGHBORHOOD WATCH ────────────────────────────────────────────────────────
// Anonymous community moderation: ticket → NW member votes → strikes → appeals
// ═══════════════════════════════════════════════════════════════════════════════

db.exec(`
  CREATE TABLE IF NOT EXISTS nw_reports (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    reporter_id    TEXT NOT NULL,
    description    TEXT NOT NULL,
    accused_info   TEXT DEFAULT '',
    accused_id     TEXT DEFAULT '',
    evidence_urls  TEXT DEFAULT '[]',
    status         TEXT DEFAULT 'voting',
    vote_messages  TEXT DEFAULT '[]',
    created_at     TEXT DEFAULT CURRENT_TIMESTAMP,
    voting_ends_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS nw_votes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    report_id  INTEGER NOT NULL,
    voter_id   TEXT NOT NULL,
    vote       TEXT NOT NULL,
    voted_at   TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(report_id, voter_id)
  );
  CREATE TABLE IF NOT EXISTS nw_strikes (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id          TEXT NOT NULL,
    username         TEXT DEFAULT '',
    report_id        INTEGER,
    issued_at        TEXT DEFAULT CURRENT_TIMESTAMP,
    expires_at       TEXT NOT NULL,
    appealed         INTEGER DEFAULT 0,
    appeal_resolved  INTEGER DEFAULT 0,
    appeal_outcome   TEXT DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS nw_missed_votes (
    voter_id           TEXT PRIMARY KEY,
    consecutive_misses INTEGER DEFAULT 0,
    last_updated       TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

const NW_ROLE_ID          = process.env.ROLE_NEIGHBORHOOD_WATCH    || '1494499384618909716';
const NW_CHANNEL_ID       = process.env.CHANNEL_NEIGHBORHOOD_WATCH || '1509648000866062427';
const NW_MOD_CHANNEL_ID   = process.env.CHANNEL_MOD                || '1357502855078088814';
const NW_VOTE_HOURS       = 24;
const NW_STRIKE_LIMIT     = 3;
const NW_STRIKE_EXPIRY_MS = 90 * 86400000; // 90 days
const NW_MAX_MISSES       = 2;
const NW_DM_TIMEOUT_MS    = 10 * 60000;    // 10 min to complete DM flow

// In-memory: active DM report flows
// Map<userId, { stage, description, accusedInfo, accusedId, timeoutHandle }>
const nwPendingReports = new Map();

// In-memory: pending resolution timers
// Map<reportId, TimeoutHandle>
const nwResolutionTimers = new Map();

// ── Post (or refresh) the Submit-a-Ticket button in the NW channel ─────────────
async function postNWChannelButton() {
  try {
    const ch = await client.channels.fetch(NW_CHANNEL_ID).catch(() => null);
    if (!ch) { console.log('[NW] Submit-a-ticket channel not found.'); return; }

    // Remove old bot messages so the channel stays clean
    const old = await ch.messages.fetch({ limit: 20 }).catch(() => null);
    if (old) {
      for (const m of old.values()) {
        if (m.author.id === client.user.id) await m.delete().catch(() => {});
      }
    }

    const embed = new EmbedBuilder()
      .setColor('#1E3A5F')
      .setTitle('👮‍♀️  Bullyland\'s Neighborhood Watch')
      .setDescription(
        '**See something? Say something.**\n\n' +
        'All reports are **completely anonymous** — no one will ever know you filed a ticket.\n\n' +
        '**To submit a report you\'ll need:**\n' +
        '• A clear description of what happened\n' +
        '• The **Discord User ID** of the person being reported (right-click their name → Copy User ID)\n' +
        '• Screenshot or video evidence\n\n' +
        'Reports are reviewed by **Neighborhood Watch members** — trusted community volunteers who vote on whether a strike should be issued.\n\n' +
        '⚠️ Submitting false or abusive reports may result in consequences.'
      )
      .setFooter({ text: 'Bully\'s World • Neighborhood Watch' });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('nw_submit')
        .setLabel('🎫  Submit a Ticket')
        .setStyle(ButtonStyle.Primary)
    );

    await ch.send({ embeds: [embed], components: [row] });
    console.log('[NW] Submit-a-Ticket button posted.');
  } catch (e) {
    console.error('[NW] postNWChannelButton error:', e.message);
  }
}

// ── Distribute a report DM to every current NW member ──────────────────────────
async function distributeNWReport(reportId) {
  const report = db.prepare('SELECT * FROM nw_reports WHERE id = ?').get(reportId);
  if (!report) return;

  const guild = await client.guilds.fetch(CONFIG.GUILD_ID).catch(() => null);
  if (!guild) return;
  await guild.members.fetch().catch(() => {});

  const nwMembers    = guild.members.cache.filter(m =>
    m.roles.cache.has(NW_ROLE_ID) && !m.user.bot && m.id !== report.reporter_id
  );
  const evidenceUrls = JSON.parse(report.evidence_urls || '[]');
  const deadlineTs   = Math.floor(new Date(report.voting_ends_at).getTime() / 1000);

  const mainEmbed = new EmbedBuilder()
    .setColor('#FFB347')
    .setTitle('👮‍♀️  New Neighborhood Watch Report')
    .setDescription(
      'An anonymous report has been submitted and needs your review.\n\n' +
      `**Reported User:** ${report.accused_info || '_Not specified_'}\n\n` +
      `**Description:**\n> ${report.description.replace(/\n/g, '\n> ')}`
    )
    .addFields(
      { name: '⏰ Voting Deadline', value: `<t:${deadlineTs}:F>  (<t:${deadlineTs}:R>)` },
      {
        name: '📋 How to Vote',
        value:
          '**✅ Issue Strike** — you believe a strike is warranted based on the evidence.\n' +
          '**❌ No Action** — the evidence does not warrant a strike.\n' +
          '**🚩 Flag as Irrelevant** — the ticket appears unnecessary or abusive.\n\n' +
          `A simple majority (>50%) of YES votes issues the strike.\n` +
          `Missing **${NW_MAX_MISSES} consecutive** votes will remove your Neighborhood Watch role.`
      }
    )
    .setFooter({ text: `Report #${reportId} • Bully's World Neighborhood Watch` });

  const voteRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`nw_vote_yes.${reportId}`).setLabel('✅  Issue Strike').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`nw_vote_no.${reportId}`).setLabel('❌  No Action').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`nw_vote_flag.${reportId}`).setLabel('🚩  Flag as Irrelevant').setStyle(ButtonStyle.Secondary)
  );

  const voteMessages = [];

  for (const [, member] of nwMembers) {
    try {
      const embeds = [mainEmbed];

      if (evidenceUrls.length > 0) {
        embeds.push(
          new EmbedBuilder()
            .setColor('#2b2d31')
            .setTitle('📎  Evidence')
            .setDescription(evidenceUrls.map((u, i) => `[View Evidence ${i + 1}](${u})`).join('\n'))
        );
      }

      const dmMsg = await member.send({ embeds, components: [voteRow] });
      voteMessages.push({ member_id: member.id, message_id: dmMsg.id });
    } catch (e) {
      console.log(`[NW] Could not DM ${member.user.username}: ${e.message}`);
    }
  }

  db.prepare('UPDATE nw_reports SET vote_messages = ? WHERE id = ?')
    .run(JSON.stringify(voteMessages), reportId);

  console.log(`[NW] Report #${reportId} → distributed to ${voteMessages.length} NW member(s).`);
}

// ── Resolve voting when the 24-hour window closes ──────────────────────────────
async function resolveNWReport(reportId) {
  const report = db.prepare('SELECT * FROM nw_reports WHERE id = ?').get(reportId);
  if (!report || report.status !== 'voting') return;

  const votes        = db.prepare('SELECT * FROM nw_votes WHERE report_id = ?').all(reportId);
  const yesCount     = votes.filter(v => v.vote === 'yes').length;
  const voteMessages = JSON.parse(report.vote_messages || '[]');
  const total        = voteMessages.length;
  const strikeIssued = total > 0 && (yesCount / total) > 0.5;

  console.log(`[NW] Resolving Report #${reportId}: ${yesCount}/${total} YES → Strike: ${strikeIssued}`);

  db.prepare('UPDATE nw_reports SET status = ? WHERE id = ?')
    .run(strikeIssued ? 'strike' : 'no_action', reportId);

  // Disable vote buttons on all NW member DMs
  const disabledRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`nw_vote_yes.${reportId}`).setLabel('✅  Issue Strike').setStyle(ButtonStyle.Danger).setDisabled(true),
    new ButtonBuilder().setCustomId(`nw_vote_no.${reportId}`).setLabel('❌  No Action').setStyle(ButtonStyle.Secondary).setDisabled(true),
    new ButtonBuilder().setCustomId(`nw_vote_flag.${reportId}`).setLabel('🚩  Flag as Irrelevant').setStyle(ButtonStyle.Secondary).setDisabled(true)
  );
  for (const { member_id, message_id } of voteMessages) {
    try {
      const u   = await client.users.fetch(member_id).catch(() => null);
      const dm  = u ? await u.createDM().catch(() => null) : null;
      const msg = dm ? await dm.messages.fetch(message_id).catch(() => null) : null;
      if (msg) await msg.edit({ components: [disabledRow] }).catch(() => {});
    } catch (_) {}
  }

  // ── Track missed voters — remove NW role after NW_MAX_MISSES consecutive misses ──
  const guild    = await client.guilds.fetch(CONFIG.GUILD_ID).catch(() => null);
  const voterIds = new Set(votes.map(v => v.voter_id));

  if (guild) {
    await guild.members.fetch().catch(() => {});
    for (const { member_id } of voteMessages) {
      if (voterIds.has(member_id)) {
        // Voted → reset consecutive miss counter
        db.prepare(`
          INSERT INTO nw_missed_votes (voter_id, consecutive_misses)
          VALUES (?, 0)
          ON CONFLICT(voter_id) DO UPDATE SET consecutive_misses = 0, last_updated = CURRENT_TIMESTAMP
        `).run(member_id);
      } else {
        // Missed → increment
        const existing = db.prepare('SELECT consecutive_misses FROM nw_missed_votes WHERE voter_id = ?').get(member_id);
        const nextMiss = (existing?.consecutive_misses || 0) + 1;
        db.prepare(`
          INSERT INTO nw_missed_votes (voter_id, consecutive_misses)
          VALUES (?, ?)
          ON CONFLICT(voter_id) DO UPDATE SET consecutive_misses = ?, last_updated = CURRENT_TIMESTAMP
        `).run(member_id, nextMiss, nextMiss);

        if (nextMiss >= NW_MAX_MISSES) {
          const gm = guild.members.cache.get(member_id);
          if (gm) {
            await gm.roles.remove(NW_ROLE_ID).catch(() => {});
            db.prepare('UPDATE nw_missed_votes SET consecutive_misses = 0 WHERE voter_id = ?').run(member_id);
            await gm.send(
              '**👮‍♀️ Neighborhood Watch Role Removed**\n\n' +
              `You've missed **${NW_MAX_MISSES} consecutive** Neighborhood Watch votes without responding.\n\n` +
              'Your **👮 Neighborhood Watch** role has been removed. You\'re welcome to re-apply by picking up the role again in the server.'
            ).catch(() => {});
            console.log(`[NW] Removed NW role from ${member_id} — ${nextMiss} consecutive misses.`);
          }
        }
      }
    }
  }

  // ── Issue strike if majority voted yes ────────────────────────────────────────
  if (strikeIssued) {
    const expiresAt = new Date(Date.now() + NW_STRIKE_EXPIRY_MS).toISOString();
    const now       = new Date().toISOString();

    if (report.accused_id) {
      db.prepare('INSERT INTO nw_strikes (user_id, username, report_id, expires_at) VALUES (?, ?, ?, ?)')
        .run(report.accused_id, report.accused_info || '', reportId, expiresAt);

      const activeStrikes = db.prepare(`
        SELECT COUNT(*) AS cnt FROM nw_strikes
        WHERE user_id = ? AND expires_at > ? AND appeal_outcome != 'overturned'
      `).get(report.accused_id, now)?.cnt || 0;

      const isKick = activeStrikes >= NW_STRIKE_LIMIT;

      // DM the accused
      try {
        const accused = await client.users.fetch(report.accused_id).catch(() => null);
        if (accused) {
          const strikeEmbed = new EmbedBuilder()
            .setColor('#FF4444')
            .setTitle('⚠️  Strike Issued — Bullyland Neighborhood Watch')
            .setDescription(
              'The Neighborhood Watch reviewed a complaint and issued a strike against your account.\n\n' +
              `**Your Active Strikes:** ${activeStrikes} / ${NW_STRIKE_LIMIT}\n` +
              `**This strike expires:** <t:${Math.floor(new Date(expiresAt).getTime() / 1000)}:D>\n\n` +
              (isKick
                ? '⛔ **You have reached the maximum number of strikes and have been removed from the server.**'
                : 'If you believe this was issued in error, you may appeal using the button below.\nYour appeal will be reviewed by the server moderators.')
            )
            .setFooter({ text: 'Bully\'s World Neighborhood Watch' });

          const appealRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`nw_appeal.${reportId}`)
              .setLabel('📬  Appeal This Strike')
              .setStyle(ButtonStyle.Primary)
              .setDisabled(isKick)
          );

          await accused.send({ embeds: [strikeEmbed], components: [appealRow] });
        }
      } catch (e) { console.error(`[NW] Could not DM accused (${report.accused_id}):`, e.message); }

      // Kick on 3rd strike
      if (isKick && guild) {
        const gm = guild.members.cache.get(report.accused_id);
        if (gm) {
          await gm.kick('Bullyland Neighborhood Watch: 3 strikes reached.').catch(e => console.error('[NW] Kick failed:', e.message));
          console.log(`[NW] Kicked ${report.accused_id} — ${activeStrikes} active strikes.`);
        }
      }
    } else {
      // accused_id not resolved — escalate to mods for manual action
      const modCh = await client.channels.fetch(NW_MOD_CHANNEL_ID).catch(() => null);
      if (modCh) {
        await modCh.send({
          embeds: [new EmbedBuilder()
            .setColor('#FF6600')
            .setTitle('⚠️  NW Strike Voted — Manual Action Required')
            .setDescription(
              `Report **#${reportId}** received a majority YES vote but the accused user couldn't be resolved automatically.\n\n` +
              `**Reported As:** ${report.accused_info || '_Unknown_'}\n\n` +
              `**Description:**\n> ${report.description}\n\n` +
              'Please manually identify the user and take action.'
            )
            .setFooter({ text: 'Bully\'s World Neighborhood Watch' })
          ]
        }).catch(() => {});
      }
    }
  }

  // ── Notify reporter of outcome (no vote details, stays fully anonymous) ────────
  try {
    const reporter = await client.users.fetch(report.reporter_id).catch(() => null);
    if (reporter) {
      await reporter.send({
        embeds: [new EmbedBuilder()
          .setColor(strikeIssued ? '#3B6D11' : '#888888')
          .setTitle('📋  Your Report Has Been Reviewed')
          .setDescription(
            strikeIssued
              ? '✅ The Neighborhood Watch completed their review of your anonymous report.\n\n**A strike has been issued** to the reported user.'
              : 'ℹ️ The Neighborhood Watch completed their review of your anonymous report.\n\n**No action was taken** at this time.'
          )
          .setFooter({ text: 'Bully\'s World Neighborhood Watch' })
        ]
      }).catch(() => {});
    }
  } catch (_) {}

  nwResolutionTimers.delete(reportId);
}

// ── Schedule a report's vote resolution ────────────────────────────────────────
function scheduleNWResolve(reportId, votingEndsAt) {
  const delay = Math.max(0, new Date(votingEndsAt).getTime() - Date.now());
  if (delay === 0) { resolveNWReport(reportId); return; }
  const t = setTimeout(() => resolveNWReport(reportId), delay);
  nwResolutionTimers.set(reportId, t);
}

// ── Handle all NW button interactions ──────────────────────────────────────────
async function handleNWInteraction(interaction) {
  const { customId, user } = interaction;
  const userId = user.id;

  // ── 🎫 SUBMIT A TICKET (guild channel button) ──────────────────────────────
  if (customId === 'nw_submit') {
    if (nwPendingReports.has(userId)) {
      await interaction.reply({ content: '📨 You already have a report in progress — check your DMs!', ephemeral: true });
      return;
    }

    try {
      await user.send({
        embeds: [new EmbedBuilder()
          .setColor('#1E3A5F')
          .setTitle('👮‍♀️  Anonymous Ticket — Step 1 of 3')
          .setDescription(
            'Thank you for reaching out. Your report is **completely anonymous** — your identity will never be shared.\n\n' +
            '**Please describe the situation clearly.**\n' +
            '_What happened? When? Include any relevant context._\n\n' +
            '> Reply to this message with your description.\n\n' +
            '💡 Type `cancel` at any time to cancel.'
          )
        ]
      });

      await interaction.reply({ content: '📨 Check your DMs! We\'ve opened a private ticket for you.', ephemeral: true });

      const timeoutHandle = setTimeout(() => {
        if (nwPendingReports.has(userId)) {
          nwPendingReports.delete(userId);
          user.send('⏰ Your ticket timed out after 10 minutes with no response. Feel free to start again anytime.').catch(() => {});
        }
      }, NW_DM_TIMEOUT_MS);

      nwPendingReports.set(userId, { stage: 'description', description: '', accusedInfo: '', accusedId: '', timeoutHandle });
    } catch (e) {
      await interaction.reply({
        content: '❌ I couldn\'t send you a DM. Please enable **"Allow Direct Messages from Server Members"** in your Discord privacy settings, then try again.',
        ephemeral: true
      }).catch(() => {});
    }
    return;
  }

  // ── ✅/❌/🚩 VOTE — Step 1: show confirmation screen ─────────────────────────
  if (customId.startsWith('nw_vote_') && !customId.startsWith('nw_vote_confirm.') && !customId.startsWith('nw_vote_back.')) {
    const [action, reportIdStr] = customId.split('.');
    const voteType = action.replace('nw_vote_', ''); // yes | no | flag
    const reportId = parseInt(reportIdStr);

    if (isNaN(reportId)) { await interaction.reply({ content: '❌ Invalid report.', ephemeral: true }); return; }

    const report = db.prepare('SELECT * FROM nw_reports WHERE id = ?').get(reportId);
    if (!report) { await interaction.reply({ content: '❌ Report not found.', ephemeral: true }); return; }
    if (report.status !== 'voting') {
      await interaction.reply({ content: 'ℹ️ Voting on this report is already closed.', ephemeral: true }); return;
    }
    if (new Date() > new Date(report.voting_ends_at)) {
      await interaction.reply({ content: '⏰ The voting window for this report has expired.', ephemeral: true }); return;
    }

    // Already voted?
    const alreadyVoted = db.prepare('SELECT 1 FROM nw_votes WHERE report_id = ? AND voter_id = ?').get(reportId, userId);
    if (alreadyVoted) { await interaction.reply({ content: '✅ You\'ve already cast your vote on this report.', ephemeral: true }); return; }

    const voteLabels  = { yes: '✅  Issue Strike', no: '❌  No Action', flag: '🚩  Flag as Irrelevant' };
    const voteColors  = { yes: 0xFF4444, no: 0x5865F2, flag: 0xFFA500 };
    const voteWarning = { yes: 'This will count as a **YES** vote to issue a strike.', no: 'This will count as a **NO** vote — no action taken.', flag: 'This will flag the ticket as unnecessary or irrelevant.' };

    const pendingEmbed = new EmbedBuilder()
      .setColor(voteColors[voteType] || 0x888888)
      .setTitle('⚠️  Confirm Your Vote')
      .setDescription(
        `You selected: **${voteLabels[voteType]}**\n\n${voteWarning[voteType]}\n\n` +
        '**This cannot be undone.** Press **Confirm** to submit your vote, or **Go Back** to change it.'
      );

    const confirmRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`nw_vote_confirm.${reportId}.${voteType}`)
        .setLabel('Confirm Vote')
        .setStyle(voteType === 'yes' ? ButtonStyle.Danger : ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`nw_vote_back.${reportId}`)
        .setLabel('↩️  Go Back')
        .setStyle(ButtonStyle.Secondary)
    );

    await interaction.update({
      embeds: [...interaction.message.embeds, pendingEmbed],
      components: [confirmRow]
    });
    return;
  }

  // ── ✅/❌/🚩 VOTE — Step 2: confirmed, record the vote ────────────────────────
  if (customId.startsWith('nw_vote_confirm.')) {
    const parts    = customId.split('.');
    const reportId = parseInt(parts[1]);
    const voteType = parts[2]; // yes | no | flag

    if (isNaN(reportId)) { await interaction.reply({ content: '❌ Invalid report.', ephemeral: true }); return; }

    const report = db.prepare('SELECT * FROM nw_reports WHERE id = ?').get(reportId);
    if (!report || report.status !== 'voting') {
      await interaction.reply({ content: 'ℹ️ Voting on this report is already closed.', ephemeral: true }); return;
    }

    try {
      db.prepare('INSERT INTO nw_votes (report_id, voter_id, vote) VALUES (?, ?, ?)').run(reportId, userId, voteType);
    } catch (e) {
      if (e.message.includes('UNIQUE')) {
        await interaction.reply({ content: '✅ Your vote was already recorded.', ephemeral: true }); return;
      }
      throw e;
    }

    const voteLabels = { yes: 'Issue Strike', no: 'No Action', flag: 'Flag as Irrelevant' };
    const voteColors = { yes: 0xFF4444, no: 0x888888, flag: 0xFFA500 };

    const doneEmbed = new EmbedBuilder()
      .setColor(voteColors[voteType] || 0x888888)
      .setDescription(`✅ **Vote recorded: ${voteLabels[voteType] || voteType}**\n\nThank you for your contribution to the Neighborhood Watch.`);

    const disabledRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`nw_vote_yes.${reportId}`).setLabel('✅  Issue Strike').setStyle(ButtonStyle.Danger).setDisabled(true),
      new ButtonBuilder().setCustomId(`nw_vote_no.${reportId}`).setLabel('❌  No Action').setStyle(ButtonStyle.Secondary).setDisabled(true),
      new ButtonBuilder().setCustomId(`nw_vote_flag.${reportId}`).setLabel('🚩  Flag as Irrelevant').setStyle(ButtonStyle.Secondary).setDisabled(true)
    );

    // Replace all embeds with just the done embed (cleans up the confirmation screen)
    await interaction.update({ embeds: [doneEmbed], components: [disabledRow] });
    return;
  }

  // ── ↩️ VOTE — Go Back: restore original vote buttons ─────────────────────────
  if (customId.startsWith('nw_vote_back.')) {
    const reportId = parseInt(customId.split('.')[1]);

    const originalRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`nw_vote_yes.${reportId}`).setLabel('✅  Issue Strike').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`nw_vote_no.${reportId}`).setLabel('❌  No Action').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`nw_vote_flag.${reportId}`).setLabel('🚩  Flag as Irrelevant').setStyle(ButtonStyle.Secondary)
    );

    // Strip the confirmation embed (last one) and restore the original embeds + buttons
    const restoredEmbeds = interaction.message.embeds.slice(0, -1);
    await interaction.update({ embeds: restoredEmbeds, components: [originalRow] });
    return;
  }

  // ── 📬 APPEAL (accused's DM) ───────────────────────────────────────────────────
  if (customId.startsWith('nw_appeal.')) {
    const reportId = parseInt(customId.split('.')[1]);
    const report   = db.prepare('SELECT * FROM nw_reports WHERE id = ?').get(reportId);

    if (!report) { await interaction.reply({ content: '❌ Report not found.', ephemeral: true }); return; }
    if (report.status !== 'strike') {
      await interaction.reply({ content: 'ℹ️ This report is not eligible for appeal.', ephemeral: true }); return;
    }

    const strikeRow = db.prepare('SELECT * FROM nw_strikes WHERE report_id = ? AND user_id = ?').get(reportId, userId);
    if (strikeRow?.appealed) {
      await interaction.reply({ content: '✅ You\'ve already submitted an appeal for this strike.', ephemeral: true }); return;
    }

    db.prepare('UPDATE nw_strikes SET appealed = 1 WHERE report_id = ? AND user_id = ?').run(reportId, userId);
    db.prepare('UPDATE nw_reports SET status = ? WHERE id = ?').run('appealed', reportId);

    // Send appeal to mod channel
    try {
      const modCh = await client.channels.fetch(NW_MOD_CHANNEL_ID).catch(() => null);
      if (modCh) {
        const appealEmbed = new EmbedBuilder()
          .setColor('#FFD700')
          .setTitle('📬  Neighborhood Watch — Strike Appeal')
          .setDescription(
            `<@${userId}> has appealed a strike issued by the Neighborhood Watch.\n\n` +
            `**Report #${reportId}**\n` +
            `**Reported User:** ${report.accused_info || `<@${userId}>`}\n\n` +
            `**Original Description:**\n> ${report.description}\n\n` +
            'Please review and issue a final ruling below.'
          )
          .setFooter({ text: 'Bully\'s World Neighborhood Watch • Appeal' });

        const modRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`nw_mod_uphold.${reportId}.${userId}`).setLabel('⚖️  Uphold Strike').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId(`nw_mod_overturn.${reportId}.${userId}`).setLabel('✅  Overturn Strike').setStyle(ButtonStyle.Success)
        );

        await modCh.send({ embeds: [appealEmbed], components: [modRow] });
      }
    } catch (e) { console.error('[NW] Could not post appeal to mod channel:', e.message); }

    await interaction.update({
      embeds: [new EmbedBuilder()
        .setColor('#FFD700')
        .setTitle('📬  Appeal Submitted')
        .setDescription(
          'Your appeal has been forwarded to the server moderators for review.\n\n' +
          'You will be notified of their decision.'
        )
        .setFooter({ text: 'Bully\'s World Neighborhood Watch' })
      ],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`nw_appeal.${reportId}`).setLabel('📬  Appeal Submitted').setStyle(ButtonStyle.Secondary).setDisabled(true)
      )]
    });
    return;
  }

  // ── ⚖️ MOD DECISION (mod channel) ────────────────────────────────────────────
  if (customId.startsWith('nw_mod_uphold.') || customId.startsWith('nw_mod_overturn.')) {
    const parts     = customId.split('.');
    const decision  = parts[0].replace('nw_mod_', ''); // uphold | overturn
    const reportId  = parseInt(parts[1]);
    const accusedId = parts[2];

    const report = db.prepare('SELECT * FROM nw_reports WHERE id = ?').get(reportId);
    if (!report) { await interaction.reply({ content: '❌ Report not found.', ephemeral: true }); return; }

    const strike = db.prepare('SELECT * FROM nw_strikes WHERE report_id = ? AND user_id = ?').get(reportId, accusedId);
    if (strike?.appeal_resolved) {
      await interaction.reply({ content: 'ℹ️ This appeal has already been resolved.', ephemeral: true }); return;
    }

    const outcome = decision === 'uphold' ? 'upheld' : 'overturned';
    db.prepare('UPDATE nw_strikes SET appeal_resolved = 1, appeal_outcome = ? WHERE report_id = ? AND user_id = ?')
      .run(outcome, reportId, accusedId);
    db.prepare('UPDATE nw_reports SET status = ? WHERE id = ?').run('appeal_resolved', reportId);

    // DM the accused with the final ruling
    try {
      const accused = await client.users.fetch(accusedId).catch(() => null);
      if (accused) {
        await accused.send({
          embeds: [new EmbedBuilder()
            .setColor(outcome === 'overturned' ? '#3B6D11' : '#FF4444')
            .setTitle('⚖️  Appeal Decision — Neighborhood Watch')
            .setDescription(
              outcome === 'overturned'
                ? '✅ **Your appeal was successful.**\n\nThe moderators reviewed your case and **overturned the strike**. It has been removed from your record.'
                : '❌ **Your appeal was denied.**\n\nThe moderators reviewed your case and **upheld the strike**. It remains on your record.'
            )
            .setFooter({ text: 'Bully\'s World Neighborhood Watch' })
          ]
        }).catch(() => {});
      }
    } catch (_) {}

    // Also notify the reporter
    try {
      const reporter = await client.users.fetch(report.reporter_id).catch(() => null);
      if (reporter) {
        await reporter.send({
          embeds: [new EmbedBuilder()
            .setColor(outcome === 'upheld' ? '#3B6D11' : '#888888')
            .setTitle('📋  Appeal Outcome — Your Report')
            .setDescription(
              outcome === 'upheld'
                ? '✅ The moderators reviewed the appeal on your report and **upheld the strike**.'
                : 'ℹ️ The moderators reviewed the appeal on your report and **overturned the strike**.'
            )
            .setFooter({ text: 'Bully\'s World Neighborhood Watch' })
          ]
        }).catch(() => {});
      }
    } catch (_) {}

    // Update the mod channel message
    await interaction.update({
      embeds: [new EmbedBuilder()
        .setColor(outcome === 'upheld' ? '#FF4444' : '#3B6D11')
        .setTitle(`⚖️  Appeal ${outcome === 'upheld' ? 'Upheld' : 'Overturned'} — Report #${reportId}`)
        .setDescription(
          `Decision made by <@${userId}>.\n\n` +
          `**Outcome:** ${outcome === 'upheld' ? '❌ Strike upheld' : '✅ Strike overturned'}\n` +
          `**Accused:** ${report.accused_info || `<@${accusedId}>`}`
        )
        .setFooter({ text: 'Bully\'s World Neighborhood Watch • Resolved' })
      ],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`nw_mod_uphold.${reportId}.${accusedId}`).setLabel('⚖️  Uphold Strike').setStyle(ButtonStyle.Danger).setDisabled(true),
        new ButtonBuilder().setCustomId(`nw_mod_overturn.${reportId}.${accusedId}`).setLabel('✅  Overturn Strike').setStyle(ButtonStyle.Success).setDisabled(true)
      )]
    });
    return;
  }
}

// ── DM message handler: collect report info across 3 stages ────────────────────
client.on('messageCreate', async msg => {
  if (msg.author.bot) return;
  if (msg.channel.type !== 1) return;          // DMs only (type 1 = DM channel)
  if (!nwPendingReports.has(msg.author.id)) return;

  const state  = nwPendingReports.get(msg.author.id);
  const userId = msg.author.id;
  const text   = msg.content.trim();

  // Allow cancellation at any stage
  if (text.toLowerCase() === 'cancel') {
    clearTimeout(state.timeoutHandle);
    nwPendingReports.delete(userId);
    await msg.reply('🚫 Ticket cancelled. You can start a new one anytime from the server.');
    return;
  }

  // Reset the 10-minute timeout on each message
  clearTimeout(state.timeoutHandle);
  state.timeoutHandle = setTimeout(() => {
    if (nwPendingReports.has(userId)) {
      nwPendingReports.delete(userId);
      msg.author.send('⏰ Your ticket timed out. Feel free to start again anytime.').catch(() => {});
    }
  }, NW_DM_TIMEOUT_MS);

  // ── Stage 1: Description ─────────────────────────────────────────────────────
  if (state.stage === 'description') {
    if (text.length < 10) {
      await msg.reply('⚠️ Please provide a more detailed description (at least 10 characters).'); return;
    }
    state.description = text;
    state.stage = 'accused';
    nwPendingReports.set(userId, state);

    await msg.reply({
      embeds: [new EmbedBuilder()
        .setColor('#1E3A5F')
        .setTitle('👮‍♀️  Step 2 of 3 — Who Are You Reporting?')
        .setDescription(
          'Please provide the **Discord User ID** of the person you\'re reporting.\n\n' +
          '**How to get a User ID:**\n' +
          '1. Open Discord → **Settings** (⚙️) → **Advanced**\n' +
          '2. Turn on **Developer Mode**\n' +
          '3. Go to the server, **right-click** the person\'s name\n' +
          '4. Click **Copy User ID**\n' +
          '5. Paste the ID here\n\n' +
          '_The ID will be a long number like: `742271263892045824`_\n\n' +
          '> Reply to this message with the User ID.'
        )
      ]
    });
    return;
  }

  // ── Stage 2: Accused User ID ─────────────────────────────────────────────────
  if (state.stage === 'accused') {
    const idMatch = text.trim().match(/^(\d{17,19})$/);
    if (!idMatch) {
      await msg.reply(
        '⚠️ That doesn\'t look like a valid User ID.\n\n' +
        'A User ID is a **17–19 digit number** (e.g. `742271263892045824`).\n' +
        'To find it: Discord Settings → Advanced → turn on **Developer Mode**, ' +
        'then right-click the person\'s name → **Copy User ID**.\n\n' +
        'Please try again.'
      );
      return;
    }

    const accusedId = idMatch[1];

    // Prevent reporting yourself
    if (accusedId === userId) {
      await msg.reply('⚠️ You cannot report yourself. Please provide a different User ID.');
      return;
    }

    // Confirm the user exists via Discord API
    const fetchedUser = await client.users.fetch(accusedId).catch(() => null);
    if (!fetchedUser) {
      await msg.reply(
        '⚠️ Could not find a Discord user with that ID.\n\n' +
        'Double-check the ID and try again, or make sure Developer Mode is enabled.'
      );
      return;
    }

    state.accusedId   = accusedId;
    state.accusedInfo = fetchedUser.username;
    state.stage       = 'evidence';
    nwPendingReports.set(userId, state);

    await msg.reply({
      embeds: [new EmbedBuilder()
        .setColor('#1E3A5F')
        .setTitle('👮‍♀️  Step 3 of 3 — Evidence')
        .setDescription(
          `Got it — you're reporting **${fetchedUser.username}**.\n\n` +
          'Almost done! Please share your **evidence**.\n\n' +
          '• **Attach a file** (screenshot or video) directly to your reply, **or**\n' +
          '• **Paste a direct link** to the evidence\n\n' +
          '_Reports without evidence may not result in action._'
        )
      ]
    });
    return;
  }

  // ── Stage 3: Evidence ────────────────────────────────────────────────────────
  if (state.stage === 'evidence') {
    const evidenceUrls = [];

    // Collect file attachments
    for (const [, att] of msg.attachments) evidenceUrls.push(att.url);

    // Collect URLs from text
    const urlMatches = text.match(/https?:\/\/[^\s]+/g) || [];
    evidenceUrls.push(...urlMatches);

    if (evidenceUrls.length === 0) {
      await msg.reply('⚠️ No evidence detected. Please attach a file or paste a direct link.'); return;
    }

    clearTimeout(state.timeoutHandle);
    nwPendingReports.delete(userId);

    // Create the report record
    const votingEndsAt = new Date(Date.now() + NW_VOTE_HOURS * 3600000).toISOString();
    const ins = db.prepare(`
      INSERT INTO nw_reports (reporter_id, description, accused_info, accused_id, evidence_urls, voting_ends_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(userId, state.description, state.accusedInfo, state.accusedId || '', JSON.stringify(evidenceUrls), votingEndsAt);

    const reportId = ins.lastInsertRowid;
    console.log(`[NW] Report #${reportId} created by ${userId} — accused: "${state.accusedInfo}" (ID: ${state.accusedId || 'unresolved'})`);

    // Confirm to reporter
    await msg.reply({
      embeds: [new EmbedBuilder()
        .setColor('#3B6D11')
        .setTitle('✅  Report Submitted')
        .setDescription(
          'Your anonymous report has been submitted successfully.\n\n' +
          'The **Neighborhood Watch** will review the evidence and vote within **24 hours**.\n\n' +
          'You will receive a DM when a decision has been made.'
        )
        .setFooter({ text: `Report #${reportId} • Bully's World Neighborhood Watch` })
      ]
    });

    // Distribute to NW members and schedule resolution
    await distributeNWReport(reportId);
    scheduleNWResolve(reportId, votingEndsAt);
  }
});

// ─── GLOBAL ERROR GUARDS ───────────────────────────────────────────────────
// Without these, Discord gateway errors (rate limits, reconnects) throw an
// unhandled 'error' event that kills the entire Node process.
client.on('error', err => {
  console.error(`[Discord] Client error (handled — bot stays up): ${err.message}`);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('[Process] Unhandled promise rejection (handled — bot stays up):', reason?.message ?? reason);
});
process.on('uncaughtException', err => {
  console.error('[Process] Uncaught exception (handled — bot stays up):', err.message);
});

client.login(process.env.DISCORD_TOKEN);
