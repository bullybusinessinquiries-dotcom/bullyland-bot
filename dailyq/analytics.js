'use strict';
// ─── DAILY Q ANALYTICS — Google Sheets integration ────────────────────────────
// Logs questions, responses, and psychology data to a dedicated Google Sheet.
// Set GOOGLE_DQ_SHEET_ID in Railway variables to enable.
// If the env var is missing, all functions silently no-op.
// ─────────────────────────────────────────────────────────────────────────────

const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT }               = require('google-auth-library');

let doc = null; // cached spreadsheet instance

// ─── Sheet tab names ──────────────────────────────────────────────────────────
const SHEETS = {
  QUESTIONS: 'Questions',
  RESPONSES: 'Responses',
  PSYCHOLOGY: 'Psychology',
  STREAKS: 'Streaks',
};

// ─── Expected headers per tab ─────────────────────────────────────────────────
const HEADERS = {
  [SHEETS.QUESTIONS]:  ['date', 'question_id', 'tone', 'category', 'question', 'message_id', 'channel_id'],
  [SHEETS.RESPONSES]:  ['timestamp', 'user_id', 'username', 'question_id', 'tone', 'category', 'response', 'length', 'bb_earned', 'streak'],
  [SHEETS.PSYCHOLOGY]: ['user_id', 'username', 'archetype', 'top_category', 'top_tone', 'total_responses', 'updated_at'],
  [SHEETS.STREAKS]:    ['user_id', 'username', 'current_streak', 'longest_streak', 'total_responses', 'last_date'],
};

// ─── Init / connect ───────────────────────────────────────────────────────────
async function getDoc() {
  if (!process.env.GOOGLE_DQ_SHEET_ID) return null;
  if (doc) return doc;

  try {
    const jwt = new JWT({
      email: process.env.GOOGLE_SERVICE_EMAIL,
      key:   (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const d = new GoogleSpreadsheet(process.env.GOOGLE_DQ_SHEET_ID, jwt);
    await d.loadInfo();
    doc = d;
    return doc;
  } catch (e) {
    console.error('[DailyQ Analytics] Sheet connect failed:', e.message);
    return null;
  }
}

async function getSheet(name) {
  const d = await getDoc();
  if (!d) return null;
  let sheet = d.sheetsByTitle[name];
  if (!sheet) {
    // Create the sheet with headers if it doesn't exist yet
    sheet = await d.addSheet({ title: name, headerValues: HEADERS[name] });
  }
  return sheet;
}

// ─── Public API ───────────────────────────────────────────────────────────────
module.exports = {
  init() {
    if (!process.env.GOOGLE_DQ_SHEET_ID) {
      console.log('[DailyQ Analytics] GOOGLE_DQ_SHEET_ID not set — Sheets logging disabled');
    } else {
      console.log('[DailyQ Analytics] Google Sheets enabled');
    }
  },

  async logQuestion(q, messageId, channelId) {
    const sheet = await getSheet(SHEETS.QUESTIONS).catch(() => null);
    if (!sheet) return;
    await sheet.addRow({
      date:        new Date().toISOString().slice(0, 10),
      question_id: q.id,
      tone:        q.tone,
      category:    q.category,
      question:    q.question,
      message_id:  messageId,
      channel_id:  channelId,
    }).catch(e => console.error('[DailyQ Analytics] logQuestion error:', e.message));
  },

  async logResponse(userId, username, activePost, responseText, bbEarned, streak) {
    const sheet = await getSheet(SHEETS.RESPONSES).catch(() => null);
    if (!sheet) return;
    await sheet.addRow({
      timestamp:   new Date().toISOString(),
      user_id:     userId,
      username,
      question_id: activePost.questionId,
      tone:        activePost.tone,
      category:    activePost.category,
      response:    responseText.slice(0, 500), // cap at 500 chars for Sheets
      length:      responseText.length,
      bb_earned:   bbEarned,
      streak,
    }).catch(e => console.error('[DailyQ Analytics] logResponse error:', e.message));
  },

  async logDailyClose(postId, winner) {
    // Nothing extra to log to Sheets on close — winner is already in Responses tab
    // This hook is here for future extensibility (e.g. logging daily winners to a Winners tab)
  },

  // Called periodically (e.g. on bot ready or monthly) to sync psychology + streaks to Sheets
  async syncPsychology(db) {
    const psychSheet   = await getSheet(SHEETS.PSYCHOLOGY).catch(() => null);
    const streakSheet  = await getSheet(SHEETS.STREAKS).catch(() => null);
    if (!psychSheet && !streakSheet) return;

    const psychRows  = db.prepare('SELECT * FROM dq_psychology ORDER BY total_resp DESC').all();
    const streakRows = db.prepare('SELECT * FROM dq_streaks ORDER BY current_streak DESC').all();

    if (psychSheet && psychRows.length) {
      await psychSheet.clearRows().catch(() => {});
      for (const r of psychRows) {
        const cats = JSON.parse(r.cat_counts || '{}');
        const tons = JSON.parse(r.tone_counts || '{}');
        const topCat  = Object.entries(cats).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
        const topTone = Object.entries(tons).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
        await psychSheet.addRow({
          user_id: r.user_id, username: r.username, archetype: r.archetype,
          top_category: topCat, top_tone: topTone, total_responses: r.total_resp, updated_at: r.updated_at,
        }).catch(() => {});
      }
    }

    if (streakSheet && streakRows.length) {
      await streakSheet.clearRows().catch(() => {});
      for (const r of streakRows) {
        await streakSheet.addRow({
          user_id: r.user_id, username: r.username, current_streak: r.current_streak,
          longest_streak: r.longest_streak, total_responses: r.total_responses, last_date: r.last_date,
        }).catch(() => {});
      }
    }

    console.log('[DailyQ Analytics] Psychology + streaks synced to Sheets');
  },
};
