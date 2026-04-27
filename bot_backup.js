require('dotenv').config();
let stripe = null;
try { const Stripe = require('stripe'); stripe = Stripe(process.env.STRIPE_SECRET_KEY); } catch(e) { console.log('[Stripe] Not installed — auction payments disabled.'); }
const Anthropic = require('@anthropic-ai/sdk');
const Database = require('better-sqlite3');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const schedule = require('node-schedule');

const { Client, GatewayIntentBits, EmbedBuilder, PermissionsBitField, Partials } = require('discord.js');
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── DATABASE ──────────────────────────────────────────────────────────────
const db = new Database('bullyland.db');
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
  CREATE TABLE IF NOT EXISTS bounties (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    placer_id TEXT, placer_username TEXT,
    target_id TEXT, target_username TEXT,
    amount INTEGER, claimed INTEGER DEFAULT 0,
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
`);

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
  },

  ROLES: {
    ROOKIE:             process.env.ROLE_ROOKIE,
    ADMIN:              process.env.ROLE_ADMIN,
    LEADERBOARD_LEADER: process.env.ROLE_LEADERBOARD_LEADER,
  },

  // Bully Bucks
  MESSAGE_BB: 1,
  MESSAGE_COOLDOWN_MS: 60 * 1000,
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
  SHOP_ITEMS: [
    { id: '5percent',      label: '5% Discount Code',    cost: 300,  prob: 0.22, type: 'discount' },
    { id: '10percent',     label: '10% Discount Code',   cost: 600,  prob: 0.12, type: 'discount' },
    { id: '15percent',     label: '15% Discount Code',   cost: 1500, prob: 0.05, type: 'discount' },
    { id: 'giveaway1',    label: 'Giveaway Entry x1',   cost: 500,  prob: 0.15, type: 'giveaway', tickets: 1 },
    { id: 'giveaway3',    label: 'Giveaway Entry x3',   cost: 1000, prob: 0.10, type: 'giveaway', tickets: 3 },
    { id: 'priority',     label: 'Stream Priority Pass',cost: 1000, prob: 0.08, type: 'priority' },
    { id: 'role_common',  label: 'Common Role',          cost: 75,   prob: 0.13, type: 'role', rarity: 'Common' },
    { id: 'role_uncommon',label: 'Uncommon Role',        cost: 100,  prob: 0.07, type: 'role', rarity: 'Uncommon' },
    { id: 'role_rare',    label: 'Rare Role',            cost: 125,  prob: 0.04, type: 'role', rarity: 'Rare' },
    { id: 'role_legendary',label:'Legendary Role',       cost: 150,  prob: 0.01, type: 'role', rarity: 'Legendary' },
    { id: '20percent',    label: '20% Discount Code',   cost: 2000, prob: 0.03, type: 'discount' },
  ],

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

// ─── DB HELPERS ────────────────────────────────────────────────────────────
function getUser(userId, username) {
  let user = db.prepare('SELECT * FROM balances WHERE user_id = ?').get(userId);
  if (!user) { db.prepare('INSERT INTO balances (user_id, username) VALUES (?, ?)').run(userId, username); user = db.prepare('SELECT * FROM balances WHERE user_id = ?').get(userId); }
  return user;
}
function addBB(userId, username, amount, reason) {
  getUser(userId, username);
  db.prepare('UPDATE balances SET balance = balance + ?, total_earned = total_earned + ?, username = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?').run(amount, amount > 0 ? amount : 0, username, userId);
  db.prepare('INSERT INTO transactions (user_id, amount, reason) VALUES (?, ?, ?)').run(userId, amount, reason);
  if (amount > 0) {
    const month = new Date().toISOString().slice(0,7);
    const ex = db.prepare('SELECT * FROM monthly_earnings WHERE user_id = ? AND month = ?').get(userId, month);
    if (ex) db.prepare('UPDATE monthly_earnings SET earned_this_month = earned_this_month + ?, username = ? WHERE user_id = ? AND month = ?').run(amount, username, userId, month);
    else db.prepare('INSERT INTO monthly_earnings (user_id, username, earned_this_month, month) VALUES (?, ?, ?, ?)').run(userId, username, amount, month);
  }
}
function spendBB(userId, amount) {
  db.prepare('UPDATE balances SET balance = balance - ? WHERE user_id = ?').run(amount, userId);
  db.prepare('INSERT INTO transactions (user_id, amount, reason) VALUES (?, ?, ?)').run(userId, -amount, 'shop purchase');
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
  const msg = await channel.send({ content: '@everyone', embeds: [embed] });
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
  if (activeCheckin && !activeCheckin.claimed && Date.now() < activeCheckin.expiresAt) return;
  const expiresAt = Date.now() + CONFIG.CHECKIN_WINDOW_MS;
  const embed = new EmbedBuilder().setColor('#c9a84c').setTitle('DAILY CHECK-IN')
    .setDescription(`Type **!checkin** in the next **3 minutes** to claim your daily Bully Bucks.\n\nDon't miss it — your streak is on the line.`)
    .addFields({name:'Expires',value:`<t:${Math.floor(expiresAt/1000)}:R>`,inline:true})
    .setFooter({text:"Bully's World • Show up every day."}).setTimestamp();
  const msg = await channel.send({ content: '@everyone', embeds: [embed] });
  activeCheckin = { messageId: msg.id, expiresAt, claimed: false };
  setTimeout(async () => {
    if (activeCheckin && !activeCheckin.claimed && activeCheckin.messageId === msg.id) {
      activeCheckin = null;
      const exp = new EmbedBuilder().setColor('#444441').setTitle('CHECK-IN EXPIRED').setDescription('Too slow. Come back tomorrow.\n\nSet your alarm.').setFooter({text:"Bully's World • Don't sleep next time."}).setTimestamp();
      await msg.edit({ embeds: [exp] }).catch(()=>{});
    }
  }, CONFIG.CHECKIN_WINDOW_MS);
}

// ─── SHOP ──────────────────────────────────────────────────────────────────
async function loadEventRoles() {
  try {
    const auth = new JWT({ email: process.env.GOOGLE_SERVICE_EMAIL, key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g,'\n'), scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
    const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, auth);
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle['Event Roles'];
    if (!sheet) return [];
    const rows = await sheet.getRows();
    const today = new Date().toISOString().slice(0,10);
    return rows.filter(r=>r.get('Active')==='YES'&&(!r.get('Expiry')||r.get('Expiry')>=today)).map(r=>({name:r.get('Role Name'),rarity:r.get('Rarity')}));
  } catch { return []; }
}
async function refreshShop() {
  const channel = await client.channels.fetch(CONFIG.CHANNELS.SHOP).catch(()=>null);
  if (!channel) return;
  const selected = []; const usedIds = new Set();
  while (selected.length < 5) {
    const roll = Math.random(); let cum = 0;
    for (const item of CONFIG.SHOP_ITEMS) {
      cum += item.prob;
      if (roll < cum && !usedIds.has(item.id)) {
        usedIds.add(item.id);
        let roleName = null;
        if (item.type==='role') roleName = getRandomRole(item.rarity);
        selected.push({ item, roleName });
        break;
      }
    }
    if (selected.length >= CONFIG.SHOP_ITEMS.filter(i=>!usedIds.has(i.id)).length + selected.length) break;
  }
  activeShop = selected;
  const nextRefresh = new Date(Date.now() + 12*60*60*1000);
  shopRefreshTime = nextRefresh;
  const lines = activeShop.map((e,i)=>`${i+1}. ${e.roleName?`${e.roleName} [${e.item.rarity}]`:e.item.label} — ${e.item.cost} BB`).join('\n');
  const embed = new EmbedBuilder().setColor('#1a1a1a').setTitle('SHOP REFRESH')
    .setDescription(`The shop just updated. Here's what's available:\n\n${lines}\n\nType **!shop** to browse anytime.\nType **!buy [number]** to purchase.\nRefreshes <t:${Math.floor(nextRefresh.getTime()/1000)}:R>`)
    .setFooter({text:"Bully's World • Spend wisely."}).setTimestamp();
  // Delete previous shop message
  if (lastShopMessageId) {
    const oldMsg = await channel.messages.fetch(lastShopMessageId).catch(()=>null);
    if (oldMsg) await oldMsg.delete().catch(()=>{});
  }
  const shopMsg = await channel.send({ embeds: [embed] });
  lastShopMessageId = shopMsg.id;
}

// ─── MONTHLY RESET ─────────────────────────────────────────────────────────
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
  await channel.send({ content: '@everyone', embeds: [embed] });
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
  await channel.send({ content: '@everyone', embeds: [embed] });

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
  if (!activeChest) return;
  if (reaction.message.id !== activeChest.messageId) return;
  if (reaction.emoji.name !== '🧡') return;

  const { tier, messageId } = activeChest;
  activeChest = null;

  const amount = Math.floor(Math.random() * (tier.max - tier.min + 1)) + tier.min;
  const guild = await client.guilds.fetch(CONFIG.GUILD_ID);
  const member = await guild.members.fetch(user.id).catch(()=>null);
  if (!member) return;

  addBB(user.id, user.username, amount, `treasure chest — ${tier.name}`);

  const wonEmbed = new EmbedBuilder().setColor(tier.color)
    .setTitle(`${tier.emoji} ${tier.name} Chest Claimed!`)
    .setDescription(`**${user.username}** found the treasure chest and claimed **${amount} BB**!

Quick eyes. Quick moves.`)
    .setFooter({text:"Bully's World • The riches are theirs."}).setTimestamp();

  const channel = await client.channels.fetch(reaction.message.channelId).catch(()=>null);
  await reaction.message.edit({ embeds: [wonEmbed] }).catch(()=>{});
  await reaction.message.reactions.removeAll().catch(()=>{});

  // Announce in general
  const general = await client.channels.fetch(CONFIG.CHANNELS.GENERAL).catch(()=>null);
  if (general) {
    await general.send({
      embeds: [new EmbedBuilder().setColor(tier.color)
        .setTitle(`${tier.emoji} Treasure Chest Claimed!`)
        .setDescription(`<@${user.id}> found the **${tier.name}** treasure chest and walked away with **${amount} BB**!`)
        .setFooter({text:"Bully's World • Keep exploring."}).setTimestamp()
      ]
    });
  }
});

// ─── WELCOME DM ────────────────────────────────────────────────────────────
client.on('guildMemberAdd', async(member) => {
  try {
    const embed = new EmbedBuilder().setColor('#1a1a1a').setTitle("🎉 Welcome to BULLYLAND!")
      .setDescription(
        `Hey ${member.displayName}! So glad you're here. This is Bully's private community — a place for his biggest supporters to connect, collect exclusive perks and get rewarded just for showing up.\n\n` +
        `─────────────────────\n\n` +
        `**💰 What are Bully Bucks?**\n` +
        `Bully Bucks are our server's currency. You earn them automatically just by chatting in the server. The more you participate the more you earn. You can spend them on discounts for Bully's Apparel, giveaway tickets and exclusive collectible badges.\n\n` +
        `─────────────────────\n\n` +
        `**📅 Daily Check-in**\n` +
        `Every morning between 10am and 12pm CT, the server posts a check-in. When you see it just type **!checkin** and you'll earn Bully Bucks for that day. You have 3 minutes to claim it so keep your notifications on!\n\n` +
        `The longer you check in without missing a day the bigger your daily reward gets.\n\n` +
        `─────────────────────\n\n` +
        `**🛍️ The Shop**\n` +
        `Once you reach Level 1 you'll unlock the shop. It refreshes with new items every 12 hours — things like discount codes for Bully's Apparel, giveaway tickets and exclusive badges only available for a limited time. Type **!shop** to see what's available.\n\n` +
        `─────────────────────\n\n` +
        `**🎰 Mystery Drops**\n` +
        `Every now and then a mystery drop appears in the server. Nobody knows what it is until they claim it — it could be a discount code or even a free item. The first person to type **!claim** gets it. Keep your notifications on so you never miss one!\n\n` +
        `─────────────────────\n\n` +
        `**🏆 Leveling Up**\n` +
        `The more you chat and participate the more you level up. Each new level unlocks new channels and perks inside the server. Your level is tracked automatically — you don't have to do anything special.\n\n` +
        `─────────────────────\n\n` +
        `**📋 Useful Commands**\n` +
        `Think of these like text shortcuts. Just type them in any channel:\n\n` +
        `• **!balance** — see how many Bully Bucks you have\n` +
        `• **!checkin** — claim your daily Bully Bucks\n` +
        `• **!shop** — browse what's available to buy\n` +
        `• **!help** — see this guide again anytime\n\n` +
        `─────────────────────\n\n` +
        `If you ever feel lost just type **!help** and this guide will come back to you. Welcome to the family! 🎨`
      )
      .setFooter({text:"Bully's Apparel • Wear the art."}).setTimestamp();
    await member.send({ embeds: [embed] });
  } catch { console.log(`[Welcome DM] Could not DM ${member.user.username}`); }
});

async function cleanupHeistMessages() {
  if (!heistMessages.length) return;
  await Promise.all(heistMessages.map(m => m.delete().catch(()=>{})));
  heistMessages = [];
}

async function executeHeist(channelArg) {
  if (!activeHeist) return;
  const { heist, crew } = activeHeist;
  // Fetch channel fresh or use stored one from activeHeist
  const channel = activeHeist.channel || channelArg || await client.channels.fetch(CONFIG.CHANNELS.GENERAL).catch(()=>null);
  activeHeist = null;
  heistTimer = null;
  console.log(`[Heist] Executing: ${heist.name} with ${crew.length} crew members`);

  if (crew.length < 2) {
    // Refund solo member
    addBB(crew[0].id, crew[0].username, heist.entry, 'heist refund — not enough crew');
    await channel.send(`🦹 **${heist.name}** was called off — not enough crew members showed up. Entry fee refunded.`);
    return;
  }

  // Calculate success chance with crew bonuses
  let successChance = heist.chance;
  successChance += (crew.length - 1) * 0.03; // +3% per extra member

  // Level bonus — check Lurkr or use BB total as proxy for level
  // +2% for each member with total_earned > 1000 BB (proxy for higher level)
  for (const member of crew) {
    const u = getUser(member.id, member.username);
    if (u.total_earned > 1000) successChance += 0.02;
  }
  successChance = Math.min(successChance, heist.chance + 0.20); // Cap at +20%

  const success = Math.random() < successChance;
  const crewList = crew.map(m => m.username).join(', ');
  const narData = HEIST_NARRATIONS[heist.name];
  const delay = ms => new Promise(res => setTimeout(res, ms));
  const narrationMessages = [];

  // Opening message
  const openingMsg = await channel.send(`🦹 **${heist.name}** — The heist begins...\n*Success chance: ${Math.round(successChance * 100)}%*`);
  narrationMessages.push(openingMsg);
  await delay(2000);

  // Narrate each crew member
  for (const member of crew) {
    const role = member.role || 'mastermind';
    const roleData = HEIST_ROLES[role];
    const lines = narData?.roleLines?.[role] || [`${member.username} does their part...`];
    const line = lines[Math.floor(Math.random() * lines.length)].replace('{user}', `**${member.username}**`);
    const narMsg = await channel.send(`${roleData?.emoji || '🦹'} ${line}`);
    narrationMessages.push(narMsg);
    await delay(2500);
  }

  await delay(60000);
  // Delete narration before posting summary
  await Promise.all(narrationMessages.map(m => m.delete().catch(()=>{})));

  if (success) {
    const share = Math.floor(heist.payout / crew.length);
    crew.forEach(m => addBB(m.id, m.username, share, `heist win — ${heist.name}`));
    const embed = new EmbedBuilder().setColor('#3B6D11').setTitle(`🦹 HEIST SUCCESS — ${heist.name}`)
      .setDescription(
        `The crew pulled it off!

` +
        `**${heist.description}**

` +
        `**Crew:** ${crewList}
` +
        `**Success chance:** ${Math.round(successChance * 100)}%
` +
        `**Payout:** ${heist.payout} BB split — **${share} BB each**`
      )
      .setFooter({text:"Bully's World • Crime paid this time."}).setTimestamp();
    await cleanupHeistMessages();
    await channel.send({ content: '@everyone', embeds: [embed] });
  } else {
    const embed = new EmbedBuilder().setColor('#8B0000').setTitle(`🦹 HEIST FAILED — ${heist.name}`)
      .setDescription(
        `The crew got caught!

` +
        `**${heist.description}**

` +
        `**Crew:** ${crewList}
` +
        `**Success chance was:** ${Math.round(successChance * 100)}%
` +
        `**Entry fees lost:** ${heist.entry} BB each`
      )
      .setFooter({text:"Bully's World • Crime didn't pay this time."}).setTimestamp();
    await cleanupHeistMessages();
    await channel.send({ embeds: [embed] });
  }
}


// ─── MESSAGE HANDLER ───────────────────────────────────────────────────────
client.on('messageCreate', async(message) => {
  if (message.author.bot || !message.guild) return;
  const userId = message.author.id, username = message.author.username;
  const content = message.content.trim().toLowerCase();

  // Passive BB
  const user = getUser(userId, username);
  const lastMsg = user.last_message ? new Date(user.last_message).getTime() : 0;
  if (Date.now() - lastMsg > CONFIG.MESSAGE_COOLDOWN_MS) {
    addBB(userId, username, CONFIG.MESSAGE_BB, 'message');
    db.prepare('UPDATE balances SET last_message = CURRENT_TIMESTAMP WHERE user_id = ?').run(userId);
  }

  // ── !checkin ──
  if (content === '!checkin') {
    if (message.channelId !== CONFIG.CHANNELS.CHECKIN) { const r = await message.reply(`Check-ins only count in <#${CONFIG.CHANNELS.CHECKIN}>.`); setTimeout(()=>r.delete().catch(()=>{}),5000); return; }
    if (!activeCheckin || activeCheckin.claimed || Date.now() > activeCheckin.expiresAt) { const r = await message.reply('No active check-in right now. Stay on your notifications.'); setTimeout(()=>r.delete().catch(()=>{}),5000); await message.delete().catch(()=>{}); return; }
    activeCheckin.claimed = true;
    await message.delete().catch(()=>{});
    const u = getUser(userId, username);
    const lastCI = u.last_checkin ? new Date(u.last_checkin).toISOString().slice(0,10) : null;
    const today = new Date().toISOString().slice(0,10);
    const yesterday = new Date(Date.now()-86400000).toISOString().slice(0,10);
    const newStreak = lastCI === yesterday ? (u.streak||0)+1 : 1;
    const reward = getStreakReward(newStreak);
    addBB(userId, username, reward, `daily check-in (streak: ${newStreak})`);
    db.prepare('UPDATE balances SET streak = ?, last_checkin = ? WHERE user_id = ?').run(newStreak, today, userId);
    try {
      const dmEmbed = new EmbedBuilder().setColor('#c9a84c').setTitle('Check-in claimed!')
        .setDescription(`You got **${reward} BB**.\nStreak: **${newStreak} day${newStreak!==1?'s':''}**\n\n${newStreak>=7?'Your streak doubled your reward. Keep going.':'Hit a 7-day streak to double your daily reward.'}`)
        .setFooter({text:"Bully's World • Show up every day."}).setTimestamp();
      await message.author.send({ embeds: [dmEmbed] });
    } catch {}
    const ch = await client.channels.fetch(CONFIG.CHANNELS.CHECKIN).catch(()=>null);
    const orig = ch ? await ch.messages.fetch(activeCheckin.messageId).catch(()=>null) : null;
    if (orig) { const ce = new EmbedBuilder().setColor('#3B6D11').setTitle('CHECK-IN CLAIMED').setDescription('Someone claimed it. Check your DMs.\n\nCome back tomorrow.').setFooter({text:"Bully's World"}).setTimestamp(); await orig.edit({embeds:[ce]}).catch(()=>{}); }
    activeCheckin = null;
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

  // ── !balance ──
  if (content === '!balance') {
    const u = getUser(userId, username);
    const embed = new EmbedBuilder().setColor('#1a1a1a').setTitle('Your Bully Bucks Balance')
      .addFields({name:'Balance',value:`${u.balance} BB`,inline:true},{name:'Total Earned',value:`${u.total_earned} BB`,inline:true},{name:'Streak',value:`${u.streak||0} days`,inline:true})
      .setFooter({text:"Bully's World • Keep earning."}).setTimestamp();
    await message.reply({ embeds: [embed] }); return;
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
    if (!message.member?.roles.cache.has(CONFIG.SHOP_ACCESS_ROLE)) { await message.reply(CONFIG.SHOP_LOCKED_MSG); return; }
    if (!activeShop.length) { await message.reply('The shop is loading. Check back shortly.'); return; }
    const lines = activeShop.map((e,i)=>{ const name = e.roleName ? `${e.roleName} [${e.item.rarity}]` : e.item.label; return `**${i+1}.** ${name} — ${e.item.cost} BB`; }).join('\n');
    const embed = new EmbedBuilder().setColor('#1a1a1a').setTitle('🛍️ Current Shop')
      .setDescription(`${lines}

Type the **number** of the item you want to buy.
Refreshes <t:${Math.floor(shopRefreshTime.getTime()/1000)}:R>`)
      .setFooter({text:"Bully's World • Spend wisely."}).setTimestamp();
    await message.reply({ embeds: [embed] });
    shopSelectionPending.set(userId, true);
    setTimeout(() => shopSelectionPending.delete(userId), 30000);
    return;
  }

  // ── Shop number selection ──
  if (shopSelectionPending.has(userId) && /^[1-5]$/.test(content)) {
    shopSelectionPending.delete(userId);
    if (!message.member?.roles.cache.has(CONFIG.SHOP_ACCESS_ROLE)) { await message.reply(CONFIG.SHOP_LOCKED_MSG); return; }
    const num = parseInt(content);
    if (num < 1 || num > activeShop.length) { await message.reply(`Pick a number between 1 and ${activeShop.length}.`); return; }
    const { item, roleName } = activeShop[num-1];
    const u = getUser(userId, username);
    if (u.balance < item.cost) { await message.reply(`Not enough BB. You have ${u.balance} BB, this costs ${item.cost} BB.`); return; }
    spendBB(userId, item.cost);
    db.prepare('INSERT INTO shop_purchases (user_id, item_name, cost) VALUES (?, ?, ?)').run(userId, roleName||item.label, item.cost);
    let dmText = '';
    if (item.type==='discount') {
      const code = pickUniqueCode(item.id, userId);
      dmText = `Your ${item.label} discount code: \`${code}\`\nShop: ${CONFIG.SHOP_URL}\n\nDon't share it.`;
    } else if (item.type==='giveaway') {
      const current = getGiveawayEntries(userId);
      const actual = Math.min(item.tickets, CONFIG.GIVEAWAY_MAX_TICKETS - current);
      if (actual <= 0) { await message.reply(`You already have the max ${CONFIG.GIVEAWAY_MAX_TICKETS} tickets this cycle.`); db.prepare('UPDATE balances SET balance = balance + ? WHERE user_id = ?').run(item.cost, userId); return; }
      addGiveawayEntries(userId, username, actual);
      dmText = `You now have ${current+actual} of ${CONFIG.GIVEAWAY_MAX_TICKETS} max tickets this cycle. Good luck!`;
    } else if (item.type==='priority') {
      dmText = `Your Stream Priority Pass is active for the next TikTok live event.`;
    } else if (item.type==='role') {
      const guild = await client.guilds.fetch(CONFIG.GUILD_ID);
      const mem = await guild.members.fetch(userId).catch(()=>null);
      addToInventory(userId, roleName, item.rarity);
      const equipped = getEquippedRoles(userId);
      if (equipped.length <= 3) {
        // Auto equip — under the limit
        if (mem) await equipRole(mem, roleName, item.rarity, userId);
        dmText = `**${roleName}** [${item.rarity}] has been added to your inventory and equipped!\n\nYou have ${equipped.length}/3 roles equipped.\n\nUse **!inventory** to see your collection.`;
      } else {
        // Already at 3 — add to inventory unequipped, ask them to swap
        db.prepare('UPDATE role_inventory SET equipped = 0 WHERE user_id = ? AND role_name = ?').run(userId, roleName);
        const equippedList = equipped.map((r,i)=>`${i+1}. ${r.role_name} [${r.rarity}]`).join('\n');
        dmText = `**${roleName}** [${item.rarity}] has been added to your inventory!\n\nYou already have 3 roles equipped. Use **!equip ${roleName}** to swap one out.\n\nCurrently equipped:\n${equippedList}`;
      }
    }
    try {
      const dmEmbed = new EmbedBuilder().setColor('#c9a84c').setTitle('Purchase confirmed').setDescription(dmText).setFooter({text:"Bully's World • Good buy."}).setTimestamp();
      await message.author.send({ embeds: [dmEmbed] });
    } catch {}
    await message.reply('Purchase confirmed. Check your DMs.');
    return;
  }

  // ── !buy (fallback) ──
  if (content.startsWith('!buy ')) {
    if (!message.member?.roles.cache.has(CONFIG.SHOP_ACCESS_ROLE)) { await message.reply(CONFIG.SHOP_LOCKED_MSG); return; }
    const num = parseInt(content.split(' ')[1]);
    if (isNaN(num)||num<1||num>activeShop.length) { await message.reply(`Pick a number between 1 and ${activeShop.length}.`); return; }
    await message.reply('Type **!shop** first to browse the shop, then type the item number to buy.');
    return;
  }

  // ── !leaderboard ──
  if (content === '!leaderboard') {
    const month = new Date().toISOString().slice(0,7);
    const top = db.prepare('SELECT * FROM monthly_earnings WHERE month = ? ORDER BY earned_this_month DESC LIMIT 10').all(month);
    if (!top.length) { await message.reply('No earnings recorded yet this month. Start chatting and checking in to earn Bully Bucks!'); return; }
    const embed = new EmbedBuilder().setColor('#c9a84c').setTitle('Monthly Leaderboard')
      .setDescription(top.map((u,i)=>`${i+1}. ${u.username} — ${u.earned_this_month} BB`).join('\n')+'\n\nTop earner at month end wins the **BIG BALLER💴** role + bonus BB.')
      .setFooter({text:"Bully's World • Come for that top spot."}).setTimestamp();
    await message.reply({ embeds: [embed] }); return;
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
    const embed = new EmbedBuilder().setColor('#1a1a1a').setTitle("Bully's World — How It Works")
      .setDescription(`**Earning Bully Bucks:**\n• Chat — 1 BB per message (1 min cooldown)\n• Daily check-in — 25-400 BB depending on streak\n• Win on-stream TikTok events — gifted by Bully\n\n**Commands:**\n!balance — your BB & streak\n!checkin — claim daily BB\n!shop — browse current shop (Rookie+)\n!buy [number] — purchase item\n!leaderboard — monthly top earners\n!history — last 5 transactions\n!stats — server economy\n!claim — claim a mystery drop\n!redeem CODE — redeem a stream event code\n\n**Streaks double every 7 days:** 25 → 50 → 100 → 200 → 400 BB`)
      .setFooter({text:"Bully's World • Now get to earning."}).setTimestamp();
    await message.reply({ embeds: [embed] }); return;
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

  // ── !inventory ──
  if (content === '!inventory') {
    const inv = getRoleInventory(userId);
    if (!inv.length) { await message.reply("Your inventory is empty. Buy roles from the shop with **!shop**."); return; }
    const equipped = inv.filter(r=>r.equipped===1);
    const unequipped = inv.filter(r=>r.equipped===0);
    let desc = '';
    if (equipped.length) desc += `**Equipped (${equipped.length}/3):**\n${equipped.map(r=>`✅ ${r.role_name} [${r.rarity}]`).join('\n')}\n\n`;
    if (unequipped.length) desc += `**Unequipped:**\n${unequipped.map(r=>`📦 ${r.role_name} [${r.rarity}]`).join('\n')}\n\n`;
    desc += `Use **!equip [role name]** or **!unequip [role name]** to manage your roles.`;
    const embed = new EmbedBuilder().setColor('#c9a84c').setTitle(`${username}'s Role Inventory`)
      .setDescription(desc).setFooter({text:"Bully's World • Collect them all."}).setTimestamp();
    await message.reply({ embeds: [embed] });
    return;
  }

  // ── !equip ──
  if (content.startsWith('!equip ')) {
    const roleName = message.content.trim().slice(7).trim();
    if (!roleName) { await message.reply('Usage: `!equip [role name]`'); return; }
    const owned = ownsRole(userId, roleName);
    if (!owned) { await message.reply(`You don't own **${roleName}**. Check your inventory with **!inventory**.`); return; }
    if (owned.equipped) { await message.reply(`**${roleName}** is already equipped.`); return; }
    const equipped = getEquippedRoles(userId);
    if (equipped.length >= 3) {
      const equippedList = equipped.map((r,i)=>`${i+1}. ${r.role_name}`).join('\n');
      await message.reply(`You already have 3 roles equipped:\n${equippedList}\n\nUse **!unequip [role name]** to remove one first.`);
      return;
    }
    const guild = await client.guilds.fetch(CONFIG.GUILD_ID);
    const mem = await guild.members.fetch(userId).catch(()=>null);
    if (mem) await equipRole(mem, roleName, owned.rarity, userId);
    await message.reply(`✅ **${roleName}** [${owned.rarity}] is now equipped! You have ${equipped.length+1}/3 roles equipped.`);
    return;
  }

  // ── !unequip ──
  if (content.startsWith('!unequip ')) {
    const roleName = message.content.trim().slice(9).trim();
    if (!roleName) { await message.reply('Usage: `!unequip [role name]`'); return; }
    const owned = ownsRole(userId, roleName);
    if (!owned) { await message.reply(`You don't own **${roleName}**. Check your inventory with **!inventory**.`); return; }
    if (!owned.equipped) { await message.reply(`**${roleName}** is already unequipped.`); return; }
    const guild = await client.guilds.fetch(CONFIG.GUILD_ID);
    const mem = await guild.members.fetch(userId).catch(()=>null);
    if (mem) await unequipRole(mem, roleName, userId);
    const equipped = getEquippedRoles(userId);
    await message.reply(`📦 **${roleName}** has been unequipped and stored in your inventory. You now have ${equipped.length}/3 roles equipped.`);
    return;
  }

  // ── !lottery ──
  if (content.startsWith('!lottery')) {
    const parts = content.split(' ');
    const qty = parseInt(parts[1]) || 1;
    if (isNaN(qty) || qty < 1) { await message.reply('Usage: `!lottery [amount]` — buy lottery tickets for 30 BB each. Example: `!lottery 5`'); return; }
    const cost = qty * 30;
    const u = getUser(userId, username);
    if (u.balance < cost) { await message.reply(`Not enough BB. ${qty} ticket${qty !== 1 ? 's' : ''} costs **${cost} BB** and you have **${u.balance} BB**.`); return; }
    spendBB(userId, cost);
    const week = getCurrentLotteryWeek();
    const ex = db.prepare('SELECT * FROM lottery_tickets WHERE user_id = ? AND week = ?').get(userId, week);
    if (ex) db.prepare('UPDATE lottery_tickets SET tickets = tickets + ? WHERE user_id = ? AND week = ?').run(qty, userId, week);
    else db.prepare('INSERT INTO lottery_tickets (user_id, username, tickets, week) VALUES (?, ?, ?, ?)').run(userId, username, qty, week);
    const total = (ex ? ex.tickets : 0) + qty;
    const pot = db.prepare('SELECT SUM(tickets) as t FROM lottery_tickets WHERE week = ?').get(week).t || 0;
    const embed = new EmbedBuilder().setColor('#FFD700').setTitle('🎟️ Lottery Tickets Purchased!')
      .setDescription(`You bought **${qty} ticket${qty !== 1 ? 's' : ''}** for **${cost} BB**!

You now have **${total} tickets** this week.
Current pot: **${pot * 30} BB**

Draw is every Sunday at 8pm CT. Good luck!`)
      .setFooter({ text: "Bully's World • May the odds be in your favor." }).setTimestamp();
    await message.reply({ embeds: [embed] });
    return;
  }

  // ── !shield ──
  if (content === '!shield') {
    const u = getUser(userId, username);
    if (hasShield(userId)) {
      const row = db.prepare('SELECT expires_at FROM shields WHERE user_id = ?').get(userId);
      await message.reply(`You already have an active shield! It expires <t:${Math.floor(new Date(row.expires_at).getTime()/1000)}:R>.`);
      return;
    }
    if (u.balance < 100) { await message.reply("A protection shield costs **100 BB** and you don't have enough."); return; }
    spendBB(userId, 100);
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    db.prepare('INSERT OR REPLACE INTO shields (user_id, expires_at) VALUES (?, ?)').run(userId, expires);
    const embed = new EmbedBuilder().setColor('#4169E1').setTitle('🛡️ Shield Activated!')
      .setDescription(`You're protected from steals for the next **24 hours**.

Expires <t:${Math.floor(new Date(expires).getTime()/1000)}:R>`)
      .setFooter({ text: "Bully's World • No one's touching your BB." }).setTimestamp();
    await message.reply({ embeds: [embed] });
    return;
  }

  // ── !bounty ──
  if (content.startsWith('!bounty ')) {
    const target = message.mentions.users.first();
    const amount = parseInt(message.content.trim().split(' ')[2]);
    if (!target) { await message.reply('Usage: `!bounty @user amount`'); return; }
    if (target.id === userId) { await message.reply("You can't put a bounty on yourself."); return; }
    if (target.bot) { await message.reply("You can't put a bounty on a bot."); return; }
    if (isNaN(amount) || amount < 250) { await message.reply('Minimum bounty is **250 BB**. Usage: `!bounty @user 250`'); return; }
    const u = getUser(userId, username);
    if (u.balance < amount) { await message.reply(`Not enough BB. You have **${u.balance} BB**.`); return; }
    spendBB(userId, amount);
    db.prepare('INSERT INTO bounties (placer_id, placer_username, target_id, target_username, amount) VALUES (?, ?, ?, ?, ?)').run(userId, username, target.id, target.username, amount);
    const embed = new EmbedBuilder().setColor('#FF4500').setTitle('🎯 BOUNTY POSTED!')
      .setDescription(`**${username}** has placed a **${amount} BB** bounty on <@${target.id}>!

First person to successfully steal from **${target.username}** collects the bounty on top of what they steal.

Type **!steal @${target.username}** to try your luck.`)
      .setFooter({ text: "Bully's World • Someone's got a target on their back." }).setTimestamp();
    await message.channel.send({ embeds: [embed] });
    try { await target.send(`🎯 **${username}** just put a **${amount} BB** bounty on you in Bully's World. Watch your back!`); } catch {}
    return;
  }

  // ── !rain ──
  if (content.startsWith('!rain ')) {
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
        if (prevMember) await prevMember.send(`⚠️ You've been outbid on **${auction.title}**! The new leading bid is **$${amount.toFixed(2)}**. Type **!bid [amount]** to bid again.`);
      } catch {}
    }
    return;
  }

  // ── ADMIN AUCTION COMMANDS ──
  if (content.startsWith('!auction ')) {
    if (!message.member?.permissions.has(PermissionsBitField.Flags.Administrator)) return;
    const parts = message.content.trim().split(' ');
    const subcommand = parts[1]?.toLowerCase();

    // !auction start [title] | [description] | [image url]
    if (subcommand === 'start') {
      if (activeAuction) { await message.reply('An auction is already running. End it first with `!auction end`.'); return; }
      const auctionInput = message.content.slice('!auction start '.length).split('|').map(s => s.trim());
      const title = auctionInput[0];
      const description = auctionInput[1] || '';
      const imageUrl = auctionInput[2] || null;
      if (!title) { await message.reply('Usage: `!auction start [title] | [description] | [image url]`'); return; }

      const endsAt = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();
      const result = db.prepare('INSERT INTO auctions (title, description, image_url, starting_bid, current_bid, ends_at) VALUES (?, ?, ?, 50, null, ?)').run(title, description, imageUrl, endsAt);
      const auctionId = result.lastInsertRowid;
      activeAuction = auctionId;

      const channel = await client.channels.fetch(CONFIG.CHANNELS.AUCTION).catch(()=>null);
      if (!channel) { await message.reply('Auction channel not found. Check CHANNEL_AUCTION in your .env'); return; }

      const endsAtTs = Math.floor(new Date(endsAt).getTime() / 1000);
      const embed = new EmbedBuilder().setColor('#c9a84c').setTitle(`🎨 AUCTION — ${title}`)
        .setDescription(
          `${description}

` +
          `**Starting Bid:** $50.00
` +
          `**Leading Bidder:** No bids yet
` +
          `**Minimum Bid:** $50.00

` +
          `Type **!bid [amount]** to place your bid.
Example: \`!bid 50\`

` +
          `⏰ Ends <t:${endsAtTs}:R>`
        )
        .setFooter({text:"Bully's World • Highest bid wins."}).setTimestamp();
      if (imageUrl) embed.setImage(imageUrl);
      const auctionMsg = await channel.send({ content: '@everyone', embeds: [embed] });
      db.prepare('UPDATE auctions SET message_id = ? WHERE id = ?').run(auctionMsg.id, auctionId);

      auctionTimer = setTimeout(() => endAuction(auctionId, true), 4 * 60 * 60 * 1000);
      await message.reply(`✅ Auction started for **${title}**! Ends in 4 hours.`);
      return;
    }

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
  }

  // ── !duel ──
  if (content.startsWith('!duel ')) {
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

  // ── !heist ──
  if (content === '!heist') {
    if (activeHeist) { await message.reply('A heist is already in progress. Type your role name to join — **driller**, **lookout**, **distraction**, **mastermind** or **getaway**.'); return; }
    if (heistSelectionPending?.userId === userId) { await message.reply('You already have a heist selection open. Type a number to choose.'); return; }

    // Check 3 minute cooldown
    const heistCooldownRow = db.prepare('SELECT last_heist FROM heist_cooldown WHERE user_id = ?').get(userId);
    if (heistCooldownRow) {
      const lastHeist = new Date(heistCooldownRow.last_heist).getTime();
      const remaining = 3 * 60 * 1000 - (Date.now() - lastHeist);
      if (remaining > 0) {
        const mins = Math.floor(remaining / 60000);
        const secs = Math.ceil((remaining % 60000) / 1000);
        await message.reply(`You need to wait **${mins > 0 ? mins + 'm ' : ''}${secs}s** before starting another heist.`);
        return;
      }
    }

    // Check 3 heists per 12 hours
    const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
    const heistCount = db.prepare("SELECT COUNT(*) as c FROM heist_log WHERE user_id = ? AND created_at > ?").get(userId, twelveHoursAgo);
    if (heistCount.c >= 3) {
      await message.reply("You've led **3 heists** in the last 12 hours. Come back later.");
      return;
    }

    const memberRoles = message.member?.roles.cache;
    const heistMinRoles = [null, null, process.env.ROLE_ROOKIE, process.env.ROLE_VETERAN, process.env.ROLE_OG, process.env.ROLE_VIP];
    const roleNames = [null, null, 'Rookie', 'Veteran', 'OG', 'VIP'];

    const availableHeists = HEISTS.filter((h, i) => {
      const reqRole = heistMinRoles[i];
      return !reqRole || memberRoles?.has(reqRole);
    });

    const heistList = availableHeists.map((h, i) => `**${i+1}.** ${h.name} — Entry: ${h.entry} BB | Odds: ${Math.round(h.chance * 100)}% | Payout: ${h.payout} BB\n*${h.description}*`).join('\n\n');

    const lockedHeists = HEISTS.filter((h, i) => {
      const reqRole = heistMinRoles[i];
      return reqRole && !memberRoles?.has(reqRole);
    });
    const lockedText = lockedHeists.length ? `

🔒 **Locked:** ${lockedHeists.map((h, i) => `${h.name} (needs ${roleNames[HEISTS.indexOf(h)]})`).join(', ')}` : '';

    const embed = new EmbedBuilder().setColor('#FF4500').setTitle('🦹 CHOOSE YOUR HEIST')
      .setDescription(`${heistList}${lockedText}

Type the **number** of the heist you want to run.`)
      .setFooter({text:"Bully's World • Choose wisely."}).setTimestamp();
    const heistListMsg = await message.channel.send({ embeds: [embed] });
    heistMessages = [heistListMsg];

    heistSelectionPending = { userId, username, channel: message.channel, availableHeists };
    setTimeout(() => {
      if (heistSelectionPending?.userId === userId) {
        heistSelectionPending = null;
        message.channel.send('⏰ Heist selection timed out. Type **!heist** to try again.').catch(()=>{});
      }
    }, 30000);
    return;
  }

  // ── Heist number selection ──
  if (heistSelectionPending && heistSelectionPending.userId === userId && /^[1-6]$/.test(content)) {
    const idx = parseInt(content) - 1;
    const { availableHeists, channel } = heistSelectionPending;
    if (idx < 0 || idx >= availableHeists.length) { await message.reply(`Please type a number between 1 and ${availableHeists.length}.`); return; }
    const heist = availableHeists[idx];
    const u = getUser(userId, username);
    if (u.balance < heist.entry) { await message.reply(`Not enough BB. This heist costs **${heist.entry} BB** to join.`); heistSelectionPending = null; return; }
    spendBB(userId, heist.entry);
    heistSelectionPending = null;

    const heistChannel = channel;
    activeHeist = {
      heist,
      crew: [{ id: userId, username, role: 'mastermind' }],
      expiresAt: Date.now() + 2 * 60 * 1000,
      channel: heistChannel,
    };
    // Log heist and set cooldown
    db.prepare('INSERT OR REPLACE INTO heist_cooldown (user_id, last_heist) VALUES (?, ?)').run(userId, new Date().toISOString());
    db.prepare('INSERT INTO heist_log (user_id) VALUES (?)').run(userId);

    const endsAt = Math.floor((Date.now() + 2 * 60 * 1000) / 1000);
    const roleList = Object.entries(HEIST_ROLES)
      .map(([key, r]) => `${r.emoji} **${key}** — ${r.label}`)
      .join('\n');

    const embed = new EmbedBuilder().setColor('#FF4500').setTitle(`🦹 HEIST RECRUITING — ${heist.name}`)
      .setDescription(
        `*${heist.description}*

` +
        `**Entry cost:** ${heist.entry} BB
` +
        `**Base success chance:** ${Math.round(heist.chance * 100)}%
` +
        `**Payout if successful:** ${heist.payout} BB split among crew

` +
        `**Crew (1/5):** ${username} 💼 Mastermind

` +
        `**Want in? Just type !join and pick your role:**
${roleList}

` +
        `*(Each role can only be taken once. First come, first served.)*

` +
        `Heist launches <t:${endsAt}:R>`
      )
      .setFooter({text:"Bully's World • The more the merrier... maybe."}).setTimestamp();
    const recruitMsg = await channel.send({ content: '@here', embeds: [embed] });
    heistMessages.push(recruitMsg);
    heistTimer = setTimeout(() => executeHeist(channel), 2 * 60 * 1000);
    return;
  }

  // ── !join (heist role selection) ──
  if (content === '!join') {
    if (!activeHeist) { await message.reply('No heist is being planned right now. Type **!heist** to start one.'); return; }
    if (activeHeist.crew.find(m => m.id === userId)) { await message.reply("You're already in the crew."); return; }
    if (activeHeist.crew.length >= 5) { await message.reply('The crew is full — 5 members max.'); return; }
    const roleList = Object.entries(HEIST_ROLES)
      .filter(([key]) => !activeHeist.crew.find(m => m.role === key))
      .map(([key, r]) => `${r.emoji} **${key}** — ${r.label}`)
      .join('\n');
    if (!roleList) { await message.reply('All roles are taken.'); return; }
    const embed = new EmbedBuilder().setColor('#FF4500').setTitle('🦹 Pick Your Role')
      .setDescription(`Type the role name to claim it:\n\n${roleList}`)
    const roleMsg = await message.reply({ embeds: [embed] });
    heistMessages.push(roleMsg);
    return;
  }

  // ── !starthere (early heist launch) ──
  if (content === '!starthere') {
    if (!activeHeist) { await message.reply('No active heist to start.'); return; }
    const isAdmin = message.member?.permissions.has(PermissionsBitField.Flags.Administrator);
    const isLeader = activeHeist.crew[0]?.id === userId;
    if (!isAdmin && !isLeader) { await message.reply('Only the heist leader or an admin can launch the heist early.'); return; }
    if (activeHeist.crew.length < 2) { await message.reply('You need at least 2 crew members before launching.'); return; }
    if (heistTimer) { clearTimeout(heistTimer); heistTimer = null; }
    await message.reply('🚀 Launching the heist early!');
    await executeHeist(message.channel);
    return;
  }

  // ── !startheist ──
  if (content === '!startheist') {
    if (!activeHeist) { await message.reply('No active heist to start. Type **!heist** to plan one first.'); return; }
    const isAdmin = message.member?.permissions.has(PermissionsBitField.Flags.Administrator);
    const isLeader = activeHeist.crew[0]?.id === userId;
    if (!isAdmin && !isLeader) { await message.reply('Only the heist leader or an admin can start the heist early.'); return; }
    if (activeHeist.crew.length < 2) { await message.reply('You need at least 2 crew members before starting.'); return; }
    if (heistTimer) { clearTimeout(heistTimer); heistTimer = null; }
    await message.reply('🦹 Starting the heist now!');
    await executeHeist(message.channel);
    return;
  }

  // ── !cancelheist ──
  if (content === '!cancelheist') {
    if (!activeHeist) { await message.reply('No active heist to cancel.'); return; }
    const isAdmin = message.member?.permissions.has(PermissionsBitField.Flags.Administrator);
    const isLeader = activeHeist.crew[0]?.id === userId;
    if (!isAdmin && !isLeader) { await message.reply('Only the heist leader or an admin can cancel the heist.'); return; }

    // Refund all crew members
    activeHeist.crew.forEach(m => addBB(m.id, m.username, activeHeist.heist.entry, 'heist cancelled — refund'));

    if (heistTimer) { clearTimeout(heistTimer); heistTimer = null; }
    const heistName = activeHeist.heist.name;
    activeHeist = null;

    await cleanupHeistMessages();
    await message.channel.send(`🚫 **${heistName}** has been cancelled. All entry fees have been refunded.`);
    return;
  }

  // ── Heist role name typing ──
  if (activeHeist && Object.keys(HEIST_ROLES).includes(content)) {
    if (activeHeist.crew.find(m => m.id === userId)) { await message.reply("You're already in the crew."); return; }
    if (activeHeist.crew.length >= 5) { await message.reply('The crew is full.'); return; }
    if (activeHeist.crew.find(m => m.role === content)) {
      const takenBy = activeHeist.crew.find(m => m.role === content)?.username;
      await message.reply(`**${HEIST_ROLES[content].label}** is already taken by ${takenBy}. Pick another.`);
      return;
    }
    const u = getUser(userId, username);
    if (u.balance < activeHeist.heist.entry) { await message.reply(`Not enough BB. This heist costs **${activeHeist.heist.entry} BB** to join.`); return; }
    spendBB(userId, activeHeist.heist.entry);
    activeHeist.crew.push({ id: userId, username, role: content });
    const roleData = HEIST_ROLES[content];
    const joinMsg = await message.reply(`${roleData.emoji} **${username}** joined the crew as **${roleData.label}**! (${activeHeist.crew.length}/5 members)`);
    heistMessages.push(joinMsg);

    // If crew is now full — notify and prompt early start
    if (activeHeist.crew.length === 5) {
      const fullEmbed = new EmbedBuilder().setColor('#c9a84c').setTitle('🦹 CREW IS FULL!')
        .setDescription(`The crew is at max capacity — 5 members ready to roll.

**The heist leader can type \`!starthere\` to launch early**, or the heist will begin automatically when the timer runs out.`)
        .setFooter({text:"Bully's World • The crew is assembled."}).setTimestamp();
      const fullMsg = await message.channel.send({ embeds: [fullEmbed] });
      heistMessages.push(fullMsg);
    }
    return;
  }

  // ── !steal ──
  if (content.startsWith('!steal ')) {
    const parts = message.content.trim().split(' ');
    const target = message.mentions.users.first();
    const stealAmount = parseInt(parts[2]);
    if (!target) { await message.reply('Usage: `!steal @user [amount]` — Example: `!steal @user 50`'); return; }
    if (isNaN(stealAmount) || stealAmount < 1) { await message.reply('Please specify an amount. Example: `!steal @user 50`'); return; }
    if (target.id === userId) { await message.reply("You can't steal from yourself."); return; }
    if (target.bot) { await message.reply("You can't steal from a bot."); return; }

    // Check cooldown (1 hour)
    const cooldownRow = db.prepare('SELECT last_steal FROM steal_cooldown WHERE user_id = ?').get(userId);
    if (cooldownRow) {
      const lastSteal = new Date(cooldownRow.last_steal).getTime();
      const remaining = 3 * 60 * 1000 - (Date.now() - lastSteal);
      if (remaining > 0) {
        const mins = Math.ceil(remaining / 60000);
        await message.reply(`You need to wait **${mins} more minute${mins !== 1 ? 's' : ''}** before stealing again.`);
        return;
      }
    }

    // Check max 5 total steal attempts per day
    const today = new Date().toISOString().slice(0, 10);
    const totalSteals = db.prepare("SELECT COUNT(*) as c FROM steal_log WHERE stealer_id = ? AND DATE(created_at) = ?").get(userId, today);
    if (totalSteals.c >= 10) {
      await message.reply("You've used all 10 of your steal attempts for today. Come back tomorrow.");
      return;
    }

    // Check shield
    if (hasShield(target.id)) {
      await message.reply(`**${target.username}** is protected by a shield. You can't steal from them right now.`);
      return;
    }

    // Check target has BB to steal
    const targetUser = getUser(target.id, target.username);
    if (targetUser.balance < 1) {
      await message.reply(`**${target.username}** is broke. Nothing to steal.`);
      return;
    }

    // Update cooldown and log
    db.prepare('INSERT OR REPLACE INTO steal_cooldown (user_id, last_steal) VALUES (?, ?)').run(userId, new Date().toISOString());
    db.prepare('INSERT INTO steal_log (stealer_id, target_id) VALUES (?, ?)').run(userId, target.id);

    // Tiered odds based on steal amount
    let successChance;
    if (stealAmount <= 25) successChance = 0.50;
    else if (stealAmount <= 50) successChance = 0.35;
    else if (stealAmount <= 100) successChance = 0.20;
    else successChance = 0.05;

    const success = Math.random() < successChance;
    const amount = stealAmount;

    if (success) {
      const actualStolen = Math.min(amount, targetUser.balance);
      db.prepare('UPDATE balances SET balance = balance - ? WHERE user_id = ?').run(actualStolen, target.id);
      db.prepare('INSERT INTO transactions (user_id, amount, reason) VALUES (?, ?, ?)').run(target.id, -actualStolen, `stolen by ${username}`);
      addBB(userId, username, actualStolen, `stolen from ${target.username}`);
      const embed = new EmbedBuilder().setColor('#3B6D11').setTitle('🤫 Successful Steal!')
        .setDescription(`**${username}** successfully stole **${actualStolen} BB** from **${target.username}**!

Slick moves.`)
        .addFields(
          { name: `${username}'s balance`, value: `${getUser(userId, username).balance} BB`, inline: true },
          { name: `${target.username}'s balance`, value: `${targetUser.balance - actualStolen} BB`, inline: true }
        )
        .setFooter({ text: "Bully's World • Watch your pockets." }).setTimestamp();
      await message.reply({ embeds: [embed] });
      // Check and pay bounty
      const bounties = getActiveBounties(target.id);
      if (bounties.length) {
        const totalBounty = bounties.reduce((sum, b) => sum + b.amount, 0);
        bounties.forEach(b => db.prepare('UPDATE bounties SET claimed = 1 WHERE id = ?').run(b.id));
        addBB(userId, username, totalBounty, `bounty collected on ${target.username}`);
        await message.channel.send(`🎯 **${username}** collected a **${totalBounty} BB** bounty on **${target.username}**!`);
      }
      try {
        await target.send(`🚨 **${username}** just stole **${actualStolen} BB** from you in Bully's World! Watch your back.`);
      } catch {}
    } else {
      const penalty = Math.max(1, Math.floor(amount * 0.5));
      const u = getUser(userId, username);
      const actualPenalty = Math.min(penalty, u.balance);
      db.prepare('UPDATE balances SET balance = balance - ? WHERE user_id = ?').run(actualPenalty, userId);
      db.prepare('INSERT INTO transactions (user_id, amount, reason) VALUES (?, ?, ?)').run(userId, -actualPenalty, `caught stealing from ${target.username}`);
      const embed = new EmbedBuilder().setColor('#8B0000').setTitle('🚨 Caught Red Handed!')
        .setDescription(`**${username}** tried to steal from **${target.username}** and got caught!

**${actualPenalty} BB** was taken as a penalty.`)
        .addFields(
          { name: `${username}'s balance`, value: `${u.balance - actualPenalty} BB`, inline: true },
          { name: `${target.username}'s balance`, value: `${targetUser.balance} BB`, inline: true }
        )
        .setFooter({ text: "Bully's World • Crime doesn't pay." }).setTimestamp();
      await message.reply({ embeds: [embed] });
    }
    return;
  }

  // ── !give ──
  if (content.startsWith('!give ')) {
    const mention = message.mentions.users.first();
    const amount = parseInt(message.content.trim().split(' ')[2]);
    if (!mention) { await message.reply('Usage: `!give @user amount`'); return; }
    if (mention.id === userId) { await message.reply("You can't give BB to yourself."); return; }
    if (mention.bot) { await message.reply("You can't give BB to a bot."); return; }
    if (isNaN(amount) || amount < 1) { await message.reply('Please enter a valid amount. Example: `!give @user 100`'); return; }
    const u = getUser(userId, username);
    if (u.balance < amount) { await message.reply(`Not enough BB. You have **${u.balance} BB**.`); return; }
    db.prepare('UPDATE balances SET balance = balance - ? WHERE user_id = ?').run(amount, userId);
    db.prepare('INSERT INTO transactions (user_id, amount, reason) VALUES (?, ?, ?)').run(userId, -amount, `sent to ${mention.username}`);
    addBB(mention.id, mention.username, amount, `received from ${username}`);
    const embed = new EmbedBuilder().setColor('#c9a84c').setTitle('💸 Bully Bucks Sent!')
      .setDescription(`**${username}** sent **${amount} BB** to **${mention.username}**!

That's love right there.`)
      .addFields(
        {name:`${username}'s new balance`, value:`${u.balance - amount} BB`, inline:true},
        {name:`${mention.username}'s new balance`, value:`${getUser(mention.id, mention.username).balance} BB`, inline:true}
      )
      .setFooter({text:"Bully's World • Spread the wealth."}).setTimestamp();
    await message.reply({ embeds: [embed] });
    try {
      const dmEmbed = new EmbedBuilder().setColor('#c9a84c').setTitle('💸 You received Bully Bucks!')
        .setDescription(`**${username}** just sent you **${amount} BB**!

Check your balance with !balance.`)
        .setFooter({text:"Bully's World • Someone's feeling generous."}).setTimestamp();
      await mention.send({ embeds: [dmEmbed] });
    } catch {}
    return;
  }

  // ── !bet ──
  if (content.startsWith('!bet ')) {
    if (!activeCasino) { const r = await message.reply("Bully's Casino is closed right now. Come back tonight between 7pm and 10pm CT."); setTimeout(()=>r.delete().catch(()=>{}),6000); await message.delete().catch(()=>{}); return; }
    const amount = parseInt(content.split(' ')[1]);
    if (isNaN(amount) || amount < 1) { await message.reply('Type `!bet [amount]` — example: `!bet 100`'); return; }
    if (amount > 500) { await message.reply('Maximum bet is **500 BB** per game.'); return; }
    const u = getUser(userId, username);
    if (u.balance < amount) { await message.reply(`Not enough BB. You have **${u.balance} BB**.`); return; }
    const won = Math.random() < 0.5;
    if (won) {
      addBB(userId, username, amount, "Bully's Casino win");
      const embed = new EmbedBuilder().setColor('#3B6D11').setTitle('🎰  YOU WON!')
        .setDescription(`**${username}** bet **${amount} BB** and doubled it!\n\n+${amount} BB added to your balance.\n\nNew balance: **${u.balance + amount} BB**`)
        .setFooter({text:"Bully's Casino • Luck is on your side."}).setTimestamp();
      await message.reply({ embeds: [embed] });
    } else {
      db.prepare('UPDATE balances SET balance = balance - ? WHERE user_id = ?').run(amount, userId);
      db.prepare('INSERT INTO transactions (user_id, amount, reason) VALUES (?, ?, ?)').run(userId, -amount, "Bully's Casino loss");
      const embed = new EmbedBuilder().setColor('#8B0000').setTitle('🎰  YOU LOST.')
        .setDescription(`**${username}** bet **${amount} BB** and lost it all.\n\n-${amount} BB removed from your balance.\n\nNew balance: **${u.balance - amount} BB**`)
        .setFooter({text:"Bully's Casino • The house wins this time."}).setTimestamp();
      await message.reply({ embeds: [embed] });
    }
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
    await message.channel.send({ content: '@everyone', embeds: [embed] });
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
    if (activeHeist) { await message.reply('A heist is already active. Cancel it first with !cancelheist.'); return; }
    const heistNum = parseInt(content.split(' ')[1]);
    let testHeist;
    if (!isNaN(heistNum) && heistNum >= 1 && heistNum <= HEISTS.length) {
      testHeist = HEISTS[heistNum - 1];
    } else {
      // Show list if no number given
      const list = HEISTS.map((h, i) => `**${i+1}.** ${h.name}`).join('\n');
      await message.reply(`Choose a heist to test:
${list}

Usage: \`!testheist [number]\``);
      return;
    }
    activeHeist = {
      heist: testHeist,
      crew: [{ id: userId, username, role: 'mastermind' }, { id: '000000000000000001', username: 'TestCrewmate', role: 'driller' }],
      expiresAt: Date.now() + 5000,
      channel: message.channel,
    };
    await message.reply(`🧪 Test heist starting: **${testHeist.name}** with dummy crew...`);
    await executeHeist(message.channel);
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

  // Announce in general chat
  const general = await client.channels.fetch(CONFIG.CHANNELS.GENERAL).catch(()=>null);
  if (general) {
    await general.send({
      embeds: [new EmbedBuilder().setColor(tier.color)
        .setTitle('📦 A treasure chest has appeared in BULLYLAND!')
        .setDescription(`A **${tier.name}** treasure chest has been hidden somewhere in the server...

Find it and react with 🧡 to claim the riches!

⏰ It disappears <t:${Math.floor(expiresAt/1000)}:R>`)
        .setFooter({text:"Bully's World • Explore the server to find it."}).setTimestamp()
      ]
    });
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

  activeChest = { messageId: chestMsg.id, channelId, tier, expiresAt };

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

let activeHeist = null;
let heistTimer = null;
let heistSelectionPending = null;
let heistMessages = []; // track all heist messages for cleanup // { userId, channel } waiting for heist number selection
let shopSelectionPending = new Map(); // userId -> waiting for shop item number
let lotterySelectionPending = new Map(); // userId -> waiting for ticket count
let activeDuels = new Map(); // challenged_id -> duel info

let activeAuction = null;
let auctionTimer = null;

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
    activeAuction = null;
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
}

async function processAuctionWinner(auction, winnerId, winnerUsername, winningBid) {
  try {
    const guild = await client.guilds.fetch(CONFIG.GUILD_ID);
    const winMember = await guild.members.fetch(winnerId).catch(()=>null);
    if (!winMember) return;

    // Create Stripe payment link
    let paymentUrl = null;
    try {
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: [{
          price_data: {
            currency: 'usd',
            product_data: {
              name: auction.title,
              description: `Original painting by Bully — auction winning bid`,
            },
            unit_amount: Math.round(winningBid * 100),
          },
          quantity: 1,
        }],
        mode: 'payment',
        success_url: 'https://bullysapparel.fourthwall.com',
        cancel_url: 'https://bullysapparel.fourthwall.com',
        metadata: { auction_id: String(auction.id), winner_id: winnerId },
      });
      paymentUrl = session.url;
    } catch(e) { console.error('[Auction] Stripe error:', e.message); }

    const dmEmbed = new EmbedBuilder().setColor('#c9a84c').setTitle(`🎨 You won the auction — ${auction.title}!`)
      .setDescription(
        `Congratulations! Your winning bid was **$${winningBid.toFixed(2)}**.

` +
        `─────────────────────

` +
        `**Step 1 — Complete your payment:**
` +
        `${paymentUrl ? `[Click here to pay securely](${paymentUrl})` : 'Payment link will be sent shortly.'}

` +
        `**Step 2 — Submit your shipping info:**
` +
        `Please reply to this DM with the form below filled out:

` +
        `**Full Name:**

` +
        `**Address Line 1:**

` +
        `**Address Line 2** *(type N/A if none)*:

` +
        `**City:**

` +
        `**State/Province:**

` +
        `**ZIP/Postal Code:**

` +
        `**Country:**

` +
        `**Phone Number:**

` +
        `─────────────────────

` +
        `You have **48 hours** to complete payment and submit shipping info or your win will be forfeited and the next highest bidder will be contacted.

` +
        `⚠️ Please fill out every field.`
      )
      .setFooter({text:"Bully's Apparel • You earned this."}).setTimestamp();
    await winMember.send({ embeds: [dmEmbed] });

    // Collect shipping and forward to owner
    const dmChannel = await winMember.createDM();
    const owner = await client.users.fetch(CONFIG.OWNER_ID).catch(()=>null);

    // Store active auction session for owner confirm flow
    activeGiveawaySessions.set(CONFIG.OWNER_ID, { winnerMember: winMember, cycle: `auction-${auction.id}` });

    const winnerCollector = dmChannel.createMessageCollector({
      filter: m => m.author.id === winnerId,
      time: 48 * 60 * 60 * 1000,
    });

    winnerCollector.on('collect', async(msg) => {
      if (!owner) return;
      const ownerEmbed = new EmbedBuilder().setColor('#1a1a1a')
        .setTitle(`📦 Auction Shipping — ${auction.title}`)
        .setDescription(
          `**Winner:** ${winnerUsername} (<@${winnerId}>)
` +
          `**Winning bid:** $${winningBid.toFixed(2)}

` +
          `─────────────────────

` +
          `${msg.content}

` +
          `─────────────────────

` +
          `Type **!confirm** to confirm or reply with what's missing to forward back to the winner.`
        )
        .setFooter({text:"Bully's World — Auction System"}).setTimestamp();
      await owner.send({ embeds: [ownerEmbed] });
    });

    winnerCollector.on('end', async(col) => {
      if (!col.size) {
        // Winner didn't respond — apply warning and move to runner up
        await applyAuctionWarning(winnerId, winnerUsername, winMember);
        await winMember.send("Your auction win has been forfeited due to no response within 48 hours.").catch(()=>{});
        activeGiveawaySessions.delete(CONFIG.OWNER_ID);

        // Move to runner up
        if (auction.second_bidder_id) {
          const channel = await client.channels.fetch(CONFIG.CHANNELS.AUCTION).catch(()=>null);
          if (channel) {
            const embed = new EmbedBuilder().setColor('#FF4500').setTitle(`🎨 RUNNER UP CONTACTED — ${auction.title}`)
              .setDescription(`The original winner forfeited. <@${auction.second_bidder_id}> is now being contacted as the runner up.`)
              .setFooter({text:"Bully's World • Second chance!"}).setTimestamp();
            await channel.send({ embeds: [embed] });
          }
          const runnerUpAuction = { ...auction, current_bidder_id: auction.second_bidder_id, current_bidder_username: auction.second_bidder_username, current_bid: auction.second_bid };
          await processAuctionWinner(runnerUpAuction, auction.second_bidder_id, auction.second_bidder_username, auction.second_bid);
        }
      }
    });

  } catch(e) { console.error('[Auction] Error processing winner:', e); }
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
    const embed = new EmbedBuilder().setColor('#c9a84c').setTitle(`🎨 AUCTION — ${auction.title}`)
      .setDescription(
        `${auction.description || ''}

` +
        `**Current Bid:** $${auction.current_bid ? auction.current_bid.toFixed(2) : auction.starting_bid.toFixed(2)}
` +
        `**Leading Bidder:** ${auction.current_bidder_username ? `${auction.current_bidder_username}` : 'No bids yet'}
` +
        `**Minimum Bid:** $${auction.current_bid ? (auction.current_bid + 1).toFixed(2) : auction.starting_bid.toFixed(2)}

` +
        `Type **!bid [amount]** to place your bid.
Example: \`!bid ${auction.current_bid ? (auction.current_bid + 1).toFixed(2) : auction.starting_bid.toFixed(2)}\`

` +
        `⏰ Ends <t:${endsAt}:R>`
      )
      .setFooter({text:"Bully's World • Highest bid wins."}).setTimestamp();
    if (auction.image_url) embed.setImage(auction.image_url);
    await msg.edit({ embeds: [embed] });
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
function getActiveBounties(targetId) {
  return db.prepare('SELECT * FROM bounties WHERE target_id = ? AND claimed = 0').all(targetId);
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

  setTimeout(async () => {
    if (activeCasino) {
      activeCasino = false;
      const closed = new EmbedBuilder().setColor('#444441').setTitle(`🎰  BULLY'S CASINO IS CLOSED`)
        .setDescription(`The house always wins eventually.\n\nCome back tomorrow night.`)
        .setFooter({text:"Bully's Casino • See you next time."}).setTimestamp();
      await channel.send({ embeds: [closed] });
    }
  }, 15 * 60 * 1000);
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
    await channel.send({ content: '@everyone', embeds: [embed] });
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
  schedule.scheduleJob('0 */12 * * *', ()=>refreshShop());
  schedule.scheduleJob({ rule:'0 0 1 * *', tz:CONFIG.TIMEZONE }, ()=>doMonthlyReset());
  // Weekly lottery draw — Sunday at 8pm CT
  schedule.scheduleJob({ rule: '0 20 * * 0', tz: CONFIG.TIMEZONE }, () => runLottery());

  // Bully's Casino — 3 random nights per week at a random time between 7pm-10pm CT
  function scheduleCasinoWeek() {
    const days = [0,1,2,3,4,5,6];
    const shuffled = days.sort(()=>Math.random()-0.5);
    const casinoNights = shuffled.slice(0,3);
    const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    console.log(`[Casino] This week's nights: ${casinoNights.map(d=>dayNames[d]).join(', ')}`);
    casinoNights.forEach(day => {
      const delay = Math.floor(Math.random() * 180);
      schedule.scheduleJob({ rule:`${delay} 19 * * ${day}`, tz:CONFIG.TIMEZONE }, ()=>{
        openCasino();
        console.log(`[Casino] Opening now (${dayNames[day]})`);
      });
    });
  }
  scheduleCasinoWeek();
  // Reschedule every Sunday at midnight for the new week
  schedule.scheduleJob({ rule:'0 0 * * 0', tz:CONFIG.TIMEZONE }, ()=>scheduleCasinoWeek());
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
  console.log('[Scheduler] All jobs started.');
}

// ─── BOOT ──────────────────────────────────────────────────────────────────
client.once('ready', async()=>{
  console.log(`\n✅ Bully's World Bot online as ${client.user.tag}`);
  await setGiveawayChannelVisible(false);
  await refreshShop();
  startScheduler();
});

client.login(process.env.DISCORD_TOKEN);
