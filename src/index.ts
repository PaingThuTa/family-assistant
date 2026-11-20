import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ALERT_COMMANDS, initAlertTables, registerAlertCommands, startAlerts } from './alerts.ts';
import { createApiServer } from './api.ts';
import { createBot, finishBot } from './bot.ts';
import { openDb, syncMembers, type MemberConfig, type Role } from './db.ts';
import { startScheduler } from './scheduler.ts';
import { S } from './strings.ts';
import type { Home } from './weather.ts';
import { registerWeatherButton } from './weather-report.ts';

const SCHEDULER = { intervalMs: 30_000, repeatMs: 5 * 60_000, maxPings: 6 };

const MEMBERS: { env: string; name: string; role: Role }[] = [
  { env: 'ADMIN_TELEGRAM_ID', name: 'Admin', role: 'admin' },
  { env: 'MOM_TELEGRAM_ID', name: 'Mom', role: 'member' },
  { env: 'DAD_TELEGRAM_ID', name: 'Dad', role: 'member' },
  { env: 'BROTHER_TELEGRAM_ID', name: 'Brother', role: 'member' },
];

const token = process.env.BOT_TOKEN;
if (!token) throw new Error('BOT_TOKEN is missing. Copy .env.example to .env and fill it in.');

const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port)) throw new Error(`PORT must be a number, got "${process.env.PORT}"`);
const webAppUrl = process.env.WEBAPP_URL ?? '';

function readMembers(): MemberConfig[] {
  const members = MEMBERS.map(({ env, name, role }) => {
    const raw = process.env[env];
    if (!raw) {
      console.warn(`${env} is not set, ${name} cannot use the bot.`);
      return { name, role, telegramId: null };
    }
    const telegramId = Number(raw);
    if (!Number.isSafeInteger(telegramId)) throw new Error(`${env} must be a number, got "${raw}"`);
    return { name, role, telegramId };
  });
  const ids = members.flatMap((m) => (m.telegramId === null ? [] : [m.telegramId]));
  if (new Set(ids).size !== ids.length) throw new Error('The same Telegram ID is used twice in .env');
  return members;
}

// Home location for weather and quake alerts, rounded to ~1 km before it is sent to any service.
function readHome(): Home | null {
  const lat = Number(process.env.HOME_LAT);
  const lon = Number(process.env.HOME_LON);
  const valid = process.env.HOME_LAT && process.env.HOME_LON && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
  if (!valid) {
    console.warn('HOME_LAT/HOME_LON are not set, so weather and quake alerts are off.');
    return null;
  }
  const round2 = (n: number) => Math.round(n * 100) / 100;
  return { lat: round2(lat), lon: round2(lon) };
}

// Relative paths resolve from the project folder, not from wherever the bot was started.
const dbPath = resolve(import.meta.dirname, '..', process.env.DB_PATH || 'data/family.db');
mkdirSync(dirname(dbPath), { recursive: true });
const db = openDb(dbPath);
syncMembers(db, readMembers());
initAlertTables(db);
const home = readHome();

const bot = createBot(token, db, webAppUrl.startsWith('https://') ? webAppUrl : null);
// Feature handlers must come before finishBot's catch-all.
registerAlertCommands(bot, db);
registerWeatherButton(bot, home);
finishBot(bot);
const stopScheduler = startScheduler(db, bot.api, SCHEDULER);
const stopAlerts = home ? startAlerts(db, bot.api, home) : () => {};

const server = createApiServer(db, token, resolve(import.meta.dirname, '..', 'public'));
server.listen(port, () => console.info(`Mini App server on http://localhost:${port}`));

// The menu button next to the chat input opens the Mini App. Telegram requires HTTPS.
if (webAppUrl.startsWith('https://')) {
  try {
    await bot.api.setChatMenuButton({
      menu_button: { type: 'web_app', text: S.timelineButton, web_app: { url: webAppUrl } },
    });
  } catch (err: unknown) {
    console.error('Could not set the Timeline menu button', err);
  }
} else {
  console.warn('WEBAPP_URL is not an https:// URL, so the Timeline button is not set.');
}

try {
  // This replaces the whole command menu, so /start must be listed too.
  await bot.api.setMyCommands([{ command: 'start', description: S.startCommand }, ...ALERT_COMMANDS]);
} catch (err: unknown) {
  console.error('Could not set bot commands', err);
}

const shutdown = () => {
  stopScheduler();
  stopAlerts();
  server.close();
  void bot.stop();
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

await bot.start({ onStart: (me) => console.info(`Bot @${me.username} is running`) });
