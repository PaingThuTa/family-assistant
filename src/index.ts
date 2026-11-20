import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createApiServer } from './api.ts';
import { createBot } from './bot.ts';
import { openDb, syncMembers, type MemberConfig, type Role } from './db.ts';
import { startScheduler } from './scheduler.ts';
import { S } from './strings.ts';

const SCHEDULER = { intervalMs: 30_000, repeatMs: 5 * 60_000, maxPings: 6 };

const MEMBERS: { env: string; name: string; role: Role }[] = [
  { env: 'ADMIN_TELEGRAM_ID', name: 'Admin', role: 'admin' },
  { env: 'MOM_TELEGRAM_ID', name: 'Mom', role: 'member' },
  { env: 'DAD_TELEGRAM_ID', name: 'Dad', role: 'member' },
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

// Relative paths resolve from the project folder, not from wherever the bot was started.
const dbPath = resolve(import.meta.dirname, '..', process.env.DB_PATH || 'data/family.db');
mkdirSync(dirname(dbPath), { recursive: true });
const db = openDb(dbPath);
syncMembers(db, readMembers());

const bot = createBot(token, db);
const stopScheduler = startScheduler(db, bot.api, SCHEDULER);

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

const shutdown = () => {
  stopScheduler();
  server.close();
  void bot.stop();
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

await bot.start({ onStart: (me) => console.info(`Bot @${me.username} is running`) });
