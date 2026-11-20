# Family Assistant

A small Telegram bot and Mini App that helps a busy family remember things: cooking timers, medicine, pickups, appointments. Built for a Burmese-speaking family, so the whole interface is in Burmese.

The bot nudges each person until the task is done. Everyone can see the family's timeline in a simple Mini App inside Telegram.

## Features

**Telegram bot**
- **+ Timer:** one tap for rice (20 min), or pick a preset and minutes.
- **+ Reminder:** type what, then pick the day, hour and minute with buttons.
- **Pings with a Done button.** Important tasks and timers repeat every 5 minutes until Done (up to 6 times).
- **Heads-up 10 minutes before** each scheduled reminder.
- **Admin alert:** if an important task gets every ping and no Done, the admin is told.

**Mini App (opens from the bot's menu button)**
- One tab per family member, and Today / Tomorrow / 7 days / Calendar views.
- Add, edit and delete tasks. Done comes with a 5-second undo.
- Late tasks are shown in red, and important tasks have an amber bar.
- Follows Telegram's light or dark theme. Large text and big tap targets.

**Who can do what**
- Each member gets their own pings and can change only their own tasks.
- Everyone can see everyone's timeline.
- The admin can see and change everything.

## Tech stack

- **Node.js 22.18+**, running TypeScript directly with no build step
- **SQLite** through the built-in `node:sqlite`
- **[grammY](https://grammy.dev)** for the Telegram bot, the only runtime dependency
- **Plain HTML, CSS and JavaScript** for the Mini App, with no framework
- **`node:test`** for tests

## Getting started

### 1. Create the bot
1. In Telegram, open [@BotFather](https://t.me/BotFather) and send `/newbot`.
2. Copy the token it gives you.

### 2. Install and configure
```bash
npm install
cp .env.example .env
```
Put the token in `.env` as `BOT_TOKEN`.

### 3. Register family members
1. Run `npm start`.
2. Each person sends `/start` to the bot. It replies with their Telegram ID.
3. Add the IDs to `.env`:
   ```
   ADMIN_TELEGRAM_ID=...
   MOM_TELEGRAM_ID=...
   DAD_TELEGRAM_ID=...
   BROTHER_TELEGRAM_ID=...
   ```
4. Restart. Anyone not listed is turned away.

### 4. Turn on the Mini App
Telegram needs an HTTPS address. For local testing, use a free Cloudflare tunnel:
```bash
cloudflared tunnel --url http://localhost:3000
```
Put the printed `https://...trycloudflare.com` link in `.env` as `WEBAPP_URL` and restart. The **အစီအစဉ်** button appears next to the chat input.

## Configuration

| Variable | Required | Description |
|---|---|---|
| `BOT_TOKEN` | yes | Token from @BotFather |
| `ADMIN_TELEGRAM_ID` | no | Sees and manages everyone's tasks and gets missed-task alerts |
| `MOM_TELEGRAM_ID`, `DAD_TELEGRAM_ID`, `BROTHER_TELEGRAM_ID` | no | Family members. Leave one empty to lock that person out. |
| `WEBAPP_URL` | no | Public HTTPS address of this server, for the Mini App button |
| `PORT` | no | HTTP port for the Mini App (default `3000`) |
| `DB_PATH` | no | SQLite file (default `data/family.db`) |

Reminder timing (the 30-second check, 5-minute repeats and 6 pings) is set in `src/index.ts`. The 10-minute heads-up is set in `src/scheduler.ts`.

## Scripts

```bash
npm start       # run the bot and the Mini App server
npm test        # run all tests
npm run check   # type check
```

## Project structure

```
src/
  index.ts        startup: config, database, bot, scheduler, HTTP server
  bot.ts          Telegram chat flows (timer, reminder, Done)
  scheduler.ts    sends heads-up, on-time and repeat pings, and admin alerts
  api.ts          Mini App HTTP server and JSON API
  auth.ts         verifies Telegram Mini App login data
  db.ts           SQLite schema and queries
  time.ts         Myanmar time (Asia/Yangon) helpers
  strings.ts      all Burmese bot text
  keyboards.ts    Telegram button layouts
public/
  index.html      Mini App page
  app.js          timeline, add/edit form, Done and delete
  calendar.js     month grid
  dom.js          small DOM helpers
  style.css       styles
```

## How reminders work

The bot checks for due tasks every 30 seconds.

```
Scheduled reminder, medicine at 6:30 pm:
  6:20  heads-up "in 10 minutes"   (once)
  6:30  on-time ping                (once for normal tasks)
  6:35  repeat ...                  (important tasks only, every 5 min, up to 6 pings)
  7:00  admin alert                 (if still not Done)
```

Timers skip the heads-up, because the end of the timer is the reminder. Tapping Done anywhere, in a ping or in the Mini App, stops everything for that task.

## Security and privacy

- Every Mini App request is checked against Telegram's signed login data, using the bot token.
- Only Telegram IDs listed in `.env` can use the bot or the API.
- All user text is rendered as plain text, never as HTML.
- Family data stays in one local SQLite file. `.env` and `data/` are git-ignored.

## Deployment

The bot must run all the time for reminders to arrive. Running it on your laptop is fine for testing. For real use, run it on a small always-on server, for example a VPS in Singapore for families in Myanmar. Use a process manager such as systemd or pm2 so it restarts after crashes, and back up `data/family.db`.
