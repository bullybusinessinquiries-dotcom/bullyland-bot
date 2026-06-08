# Bullyland Bot — Project Rules

## Core Rules (NEVER violate these)

### Scheduling & Persistence
- **Updates and redeployments must NEVER wipe scheduled data.** All scheduled features (announcements, DM blasts, drops, etc.) must be persisted to the SQLite database so they survive bot restarts and Railway redeploys.
- Always persist scheduled items to DB **before** the action fires, and delete from DB **after** the action completes — never before.
- On bot `ready`, reload all persisted scheduled items from the DB and re-register them with node-schedule.
- Never use `setTimeout` for scheduling — use `node-schedule` which handles dates months/years ahead without the 32-bit overflow cap (~24 day limit).

### Announcement System
- Announcements are persisted in the `scheduled_announcements` table.
- IDs fill the lowest available slot (no gaps) — never monotonically increment past cancelled entries.
- `_reloadPersistedAnnouncements()` is called on bot ready to restore the queue from DB.

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
