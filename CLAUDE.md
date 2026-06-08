# Bullyland Bot — Project Rules

## Core Rules (NEVER violate these)

### Code Integrity
- **Do NOT rewrite or refactor already-working code.** Only touch what is required to implement the requested feature. Breaking existing functionality (images, scheduling, etc.) due to unnecessary rewrites is unacceptable and disrupts the owner's marketing schedule.
- When adding a feature, make the smallest possible change. Existing logic stays intact.

### Scheduling & Persistence
- **Updates and redeployments must NEVER wipe scheduled data.** All scheduled features (announcements, DM blasts, drops, etc.) must be persisted to the SQLite database so they survive bot restarts and Railway redeploys.
- Always persist scheduled items to DB **before** the action fires, and delete from DB **after** the action completes — never before.
- On bot `ready`, reload all persisted scheduled items from the DB and re-register them with node-schedule.
- Never use `setTimeout` for scheduling — use `node-schedule` which handles dates months/years ahead without the 32-bit overflow cap (~24 day limit).

### Announcement System
- Announcements are persisted in the `scheduled_announcements` table.
- IDs fill the lowest available slot (no gaps) — never monotonically increment past cancelled entries.
- `_reloadPersistedAnnouncements()` is called on bot ready to restore the queue from DB.
- **Admin** announcements: full flow — channel dropdown, format dropdown, mention dropdown, time prompt. Post in any channel.
- **Mod** announcements: format dropdown + time prompt only. Channel is hardcoded to **lobby** (`CONFIG.CHANNELS.GENERAL`). Mention defaults to **@everyone** automatically. No channel or mention dropdowns for mods.
- Mod announcements require **owner approval** before posting. If owner approves after the scheduled time has passed, the announcement posts immediately.
- If owner approves before the scheduled time, it gets queued normally.

## Project Purpose
Turning Bully's Discord server into a social media platform that retains user engagement and funnels users to external platforms (merch, Twitch, etc.).

## Tech Stack
- Node.js, discord.js v14, better-sqlite3 (SQLite), node-schedule, Railway deployment
- Database: `/app/data/bullyland.db` (Railway persistent volume)
- Main file: `bot.js` (~9000+ lines)
- Modular: `radio/`, `dailyq/`, `fyp.js`, `dashboard.js`

## Deployment
- Hosted on Railway — auto-deploys on GitHub push
- Git remote: `bullybusinessinquiries-dotcom/bullyland-bot`
- Push via: `git push` from `E:\DISCORD\bullyland-bot`
