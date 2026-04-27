# Bully's World Bot — Setup Guide

## What this bot does (everything in one place)
- Member Spotlight — every Sunday at 6pm
- Mystery Drops — Mon/Wed/Sat at random times, anonymous !claim
- Daily Check-in — random time 10am-12pm CT, 3 minute window, streak system
- Rotating Shop — 5 items, refreshes every 12 hours, Google Sheet integration
- Bully Bucks economy — tracks every member's balance, transactions, streaks
- Monthly leaderboard reset — top earner wins role + 50 BB
- Quarterly giveaway — automated winner selection + shipping DM flow
- Welcome DM — every new member gets onboarded automatically
- Full admin command suite

---

## Step 1 — Create your Discord Bot

1. Go to https://discord.com/developers/applications
2. Click New Application — name it "Bully's World"
3. Go to the Bot tab → Add Bot
4. Under Privileged Gateway Intents turn ON:
   - Server Members Intent
   - Message Content Intent
5. Click Reset Token and copy it → paste as DISCORD_TOKEN in your .env
6. Go to OAuth2 → URL Generator
7. Check scopes: bot, applications.commands
8. Check permissions: Send Messages, Read Messages, Manage Roles, Embed Links, Add Reactions, Read Message History, Mention Everyone
9. Open the generated URL → add the bot to your BULLYLAND server

---

## Step 2 — Get your Anthropic API Key

1. Go to https://console.anthropic.com
2. Sign up or log in
3. Go to API Keys → Create Key → name it "Bullys World Bot"
4. Copy it → paste as ANTHROPIC_API_KEY in your .env

---

## Step 3 — Set up Google Sheets (for event roles)

1. Go to https://console.cloud.google.com
2. Create a new project named "Bullys World Bot"
3. Enable the Google Sheets API
4. Go to APIs & Services → Credentials → Create Credentials → Service Account
5. Name it "bullys-world-bot" → Create and Continue → Done
6. Click the service account → Keys tab → Add Key → Create New Key → JSON
7. Open the downloaded JSON file:
   - Copy client_email → paste as GOOGLE_SERVICE_EMAIL
   - Copy private_key → paste as GOOGLE_PRIVATE_KEY
8. Go to sheets.google.com → create a new sheet named "Bullys World Bot"
9. Share it with your GOOGLE_SERVICE_EMAIL (Editor access)
10. Copy the Sheet ID from the URL (between /d/ and /edit) → paste as GOOGLE_SHEET_ID
11. Create a tab named exactly: Event Roles
12. Add these column headers: Role Name | Rarity | Active | Expiry

---

## Step 4 — Get your Glow Ups channel ID

1. Right click your #glow-ups channel in Discord
2. Click Copy Channel ID
3. Paste it as CHANNEL_GLOW_UPS in your .env

---

## Step 5 — Fill in your .env file

Copy .env.example → rename to .env
Most values are already filled in. You only need to add:
- DISCORD_TOKEN
- ANTHROPIC_API_KEY
- CHANNEL_GLOW_UPS
- GOOGLE_SHEET_ID
- GOOGLE_SERVICE_EMAIL
- GOOGLE_PRIVATE_KEY

---

## Step 6 — Install and run locally (testing)

Make sure Node.js is installed: https://nodejs.org (download LTS version)

Open terminal in the bot folder and run:
```
npm install
npm start
```

You should see:
```
✅ Bully's World Bot online as Bully's World#1234
[Shop] Refreshed with 5 items
[Scheduler] All jobs started.
```

### Test commands (admin only):
- !testspotlight — triggers Member Spotlight immediately
- !testdrop — triggers Mystery Drop immediately
- !testcheckin — triggers Daily Check-in immediately
- !testshop — refreshes Shop immediately
- !testreset — triggers Monthly Leaderboard Reset
- !testgiveaway — triggers Quarterly Giveaway

---

## Step 7 — Host 24/7 on Railway (~$5/month)

1. Push your bot folder to a private GitHub repo
2. Go to https://railway.app → New Project → Deploy from GitHub
3. Connect your repo
4. Go to Variables tab → add all your .env values
5. Railway runs npm start automatically and keeps it alive 24/7

---

## Admin Commands

| Command | Usage | What it does |
|---|---|---|
| !gift | !gift @user 100 | Give BB to one member |
| !giftall | !giftall @role 50 | Give BB to everyone with a role |
| !createcode | !createcode WIN250 250 | Create a one-time stream event code |
| !balancecheck | !balancecheck @user | Check any member's balance |
| !adjust | !adjust @user 100 | Add or deduct BB manually |
| !resetuser | !resetuser @user | Reset balance and streak to zero |

## Member Commands

| Command | What it does |
|---|---|
| !balance | Your BB balance and streak |
| !checkin | Claim daily BB (during active window) |
| !shop | See current shop rotation (Rookie+) |
| !buy [number] | Purchase shop item |
| !leaderboard | Monthly top earners |
| !history | Last 5 transactions |
| !stats | Server economy overview |
| !claim | Claim an active mystery drop |
| !redeem CODE | Redeem a stream event code |
| !help | Full command guide |

---

## Adding event roles to the shop

When a milestone happens (TikTok milestone, new apparel drop, etc.):
1. Open your Google Sheet → Event Roles tab
2. Add a new row: Role Name | Rarity | YES | expiry date (or leave blank)
3. Bot picks it up on the next shop rotation automatically

To pause a role: change Active from YES to NO.

---

## Streak reward reference

| Streak | Daily reward |
|---|---|
| Day 1-6 | 25 BB |
| Day 7-13 | 50 BB |
| Day 14-20 | 100 BB |
| Day 21-27 | 200 BB |
| Day 28+ | 400 BB |

---

## Schedule reference

| Feature | When |
|---|---|
| Member Spotlight | Every Sunday at 6pm |
| Mystery Drops | Mon, Wed, Sat at random times |
| Daily Check-in | Random time 10am-12pm CT |
| Shop refresh | Every 12 hours |
| Monthly leaderboard reset | 1st of every month at midnight CT |
| Quarterly giveaway | Jan, Apr, Jul, Oct 1st at noon CT |
