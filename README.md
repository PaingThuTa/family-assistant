# Family Assistant

A small Telegram bot and Mini App that helps a busy family remember things: cooking timers, medicine, pickups, appointments. Built for a Burmese-speaking family, so the whole interface is in Burmese.

The bot nudges each person until the task is done. Everyone can see the family's timeline in a simple Mini App inside Telegram.

## Features

**Telegram bot**
- **နောက်ဘာလဲ? (What's next?):** one tap shows unfinished late tasks and the next task, with a Done button.
- **မှတ်စု (Notes):** opens the family notes in the Mini App.
- **ရာသီဥတု (Weather):** a short message in plain words with weather emojis: today's date, sky and rain in words, the temperature now and the day's high, a UV and air-quality (PM2.5) line, which parts of the day may get rain, and what to do (hang the laundry or take an umbrella). Heat, strong sun and bad air get an extra advice line on days they matter. Ends with the next 3 days. Cached for 15 minutes.
- **Pings with a Done button.** Important tasks repeat every 5 minutes until Done (up to 6 times).
- **Heads-up 10 minutes before** each scheduled reminder.
- **Admin alert:** if an important task gets every ping and no Done, the admin is told.
- **Opt-in alerts (`/alerts`):** rain expected within about 2 hours (at most once per morning, afternoon and evening, and silent at night), the full weather report every day at 7:00 (the same message as the Weather button), and reports of nearby M4.5+ earthquakes. The earthquake alert comes from USGS a few minutes **after** a quake. It is a report, not an early warning.

**Mini App (opens from the bot's menu button)**
- One tab per family member, and Today / Tomorrow / 7 days / Calendar views.
- Add, edit and delete tasks. Done comes with a 5-second undo.
- **Notes:** a title plus lines you can tick off, like a shopping list. Each note is shared with the family or private to its creator (hidden even from the admin).
- Late tasks are shown in red, and important tasks have an amber bar.
- Follows Telegram's light or dark theme. Large text and big tap targets.

**Who can do what**
- Each member gets their own pings and can change only their own tasks.
- Everyone can see everyone's timeline.
- The admin can see and change everything.

## Tech stack

- **Node.js 22.18+**, running TypeScript directly with no build step
- **SQLite** through [`@libsql/client`](https://github.com/tursodatabase/libsql-client-ts): a local file in development, [Turso](https://turso.tech) in production
- **[grammY](https://grammy.dev)** for the Telegram bot
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
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | no | Use a Turso database instead of the local file (production) |
| `HOME_LAT`, `HOME_LON` | no | Home location for weather and earthquake alerts. Rounded to about 1 km before it is sent to Open-Meteo. Alerts are off if unset. |

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
  bot.ts          Telegram chat buttons (What's next?, Notes) and Done
  scheduler.ts    sends heads-up, on-time and repeat pings, and admin alerts
  alerts.ts       /alerts subscriptions; rain, daily weather and earthquake passes
  weather.ts      Open-Meteo and USGS fetchers and alert rules
  weather-report.ts  the Weather button's report (forecast + air quality)
  api.ts          Mini App HTTP server and task API
  notes-api.ts    notes API (shared and private notes)
  notes-db.ts     notes queries
  http.ts         shared HTTP helpers
  auth.ts         verifies Telegram Mini App login data
  db.ts           SQLite schema and queries
  time.ts         Myanmar time (Asia/Yangon) helpers
  strings.ts      all Burmese bot text
  keyboards.ts    Telegram button layouts
public/
  index.html      Mini App page
  app.js          timeline, add/edit form, Done and delete
  calendar.js     month grid
  notes.js        notes screen
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

Tapping Done anywhere, in a ping or in the Mini App, stops everything for that task.

## Security and privacy

- Every Mini App request is checked against Telegram's signed login data, using the bot token.
- Only Telegram IDs listed in `.env` can use the bot or the API.
- All user text is rendered as plain text, never as HTML.
- Family data stays in one SQLite database: a local file, or your own Turso database in production. `.env` and `data/` are git-ignored.
- Only city-level coordinates (rounded to about 1 km) are sent to the weather service. Apart from the database, nothing else leaves the server except Telegram messages.

## Deployment

The bot must run all the time for reminders to arrive. The free setup is a Render web service plus a Turso database:

1. Create a Turso database, then copy its URL (`libsql://...`) and an auth token.
2. Create a Render **Web Service** from this repo: build `npm ci --omit=dev`, start `npm start`. Add the variables from `.env.example`: set `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`, and set `WEBAPP_URL` to the service's `https://<name>.onrender.com` address. Leave `PORT` unset; Render provides it.
3. Render's free plan sleeps after 15 minutes without web traffic, which would stop reminders. Point a free uptime monitor (for example UptimeRobot) at the service URL every 5 minutes to keep it awake.

Every push to `main` redeploys. Render's disk is wiped on each deploy, which is why the data lives in Turso.
