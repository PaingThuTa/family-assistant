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

- **[Cloudflare Workers](https://workers.cloudflare.com)** (free plan): the bot gets updates by webhook, a cron runs every minute, and `public/` is served as static files
- **TypeScript** with no build step for tests (Node 22.18+ runs it directly); Wrangler bundles it for deploy
- **[Turso](https://turso.tech)** (SQLite in the cloud, free plan) through [`@libsql/client`](https://github.com/tursodatabase/libsql-client-ts)
- **[grammY](https://grammy.dev)** for the Telegram bot
- **Plain HTML, CSS and JavaScript** for the Mini App, with no framework
- **`node:test`** for tests

## Getting started

### 1. Create the bot
1. In Telegram, open [@BotFather](https://t.me/BotFather) and send `/newbot`.
2. Copy the token it gives you.

### 2. Create the database
Create a free [Turso](https://turso.tech) database. Copy its URL (`libsql://...`) and create a token (Read & Write, never expires).

### 3. Deploy the Worker
```bash
npm install
npx wrangler login
npm run deploy
```
The deploy prints the Worker's address, `https://family-assistant.<subdomain>.workers.dev`.

### 4. Add the settings
In the Cloudflare dashboard, open the Worker, go to **Settings > Variables and Secrets** and add each key from `.env.example` as a **Secret**. `WEBAPP_URL` is the Worker's address. For `WEBHOOK_SECRET`, generate a random value with `openssl rand -hex 32`.

Copy the same values into a local `.env` (git-ignored) and run:
```bash
npm run setup-telegram
```
This points Telegram at the Worker and sets up the **အစီအစဉ်** menu button and the command menu. Run it again if `WEBAPP_URL` or `WEBHOOK_SECRET` changes.

### 5. Register family members
Each person sends `/start` to the bot. It replies with their Telegram ID. Add the IDs as the `*_TELEGRAM_ID` secrets. Anyone not listed is turned away.

## Configuration

| Variable | Required | Description |
|---|---|---|
| `BOT_TOKEN` | yes | Token from @BotFather |
| `ADMIN_TELEGRAM_ID` | no | Sees and manages everyone's tasks and gets missed-task alerts |
| `MOM_TELEGRAM_ID`, `DAD_TELEGRAM_ID`, `BROTHER_TELEGRAM_ID` | no | Family members. Leave one empty to lock that person out. |
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | yes | The Turso database and its token |
| `WEBAPP_URL` | yes | The Worker's HTTPS address, for the Mini App and the webhook |
| `WEBHOOK_SECRET` | yes | Random string Telegram sends with every update, so nobody else can post fake ones |
| `HOME_LAT`, `HOME_LON` | no | Home location for weather and earthquake alerts. Rounded to about 1 km before it is sent to Open-Meteo. Alerts are off if unset. |

Reminder timing (5-minute repeats and 6 pings) is set in `src/config.ts`, the every-minute cron in `wrangler.jsonc`, and the 10-minute heads-up in `src/scheduler.ts`.

## Scripts

```bash
npm test                 # run all tests
npm run check            # type check
npm run deploy           # deploy the Worker to Cloudflare
npm run setup-telegram   # point Telegram at the Worker (reads .env)
npm run dev              # run the Worker locally (reads .dev.vars)
```

## Project structure

```
src/
  worker.ts       Worker entry: webhook, Mini App API and the every-minute cron
  config.ts       settings, family members and reminder timing
  setup-telegram.ts  one-time webhook, menu button and command setup
  bot.ts          Telegram chat buttons (What's next?, Notes) and Done
  scheduler.ts    sends heads-up, on-time and repeat pings, and admin alerts
  alerts.ts       /alerts subscriptions; rain, daily weather and earthquake passes
  weather.ts      Open-Meteo and USGS fetchers and alert rules
  weather-report.ts  the Weather button's report (forecast + air quality)
  api.ts          Mini App task API
  notes-api.ts    notes API (shared and private notes)
  notes-db.ts     notes queries
  http.ts         shared HTTP helpers
  auth.ts         verifies Telegram Mini App login data
  db.ts           SQLite schema and queries
  time.ts         Myanmar time (Asia/Yangon) helpers
  strings.ts      all Burmese bot text
  keyboards.ts    Telegram button layouts
public/
  _headers        security headers for the static files
  index.html      Mini App page
  app.js          timeline, add/edit form, Done and delete
  calendar.js     month grid
  notes.js        notes screen
  dom.js          small DOM helpers
  style.css       styles
```

## How reminders work

The bot checks for due tasks every minute.

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
- Bot updates are accepted only with the webhook secret that Telegram sends.
- Only the Telegram IDs in the settings can use the bot or the API.
- All user text is rendered as plain text, never as HTML.
- Family data stays in your own Turso database. `.env` and `.dev.vars` are git-ignored.
- Only city-level coordinates (rounded to about 1 km) are sent to the weather service. Apart from the database, nothing else leaves the Worker except Telegram messages.

## Deployment

Everything runs on free plans with no card: a Cloudflare Worker and a Turso database. The Worker sleeps between requests, and Telegram (webhook) and the cron (every minute) wake it, so reminders arrive without an always-on server.

To deploy a change, run `npm run deploy`. Or connect the repo under **Workers & Pages > the Worker > Settings > Build** so every push to `main` deploys.

Logs are under **Workers & Pages > the Worker > Observability**.
