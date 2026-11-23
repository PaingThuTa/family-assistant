import { timingSafeEqual } from 'node:crypto';
import { webhookCallback, type Bot } from 'grammy';
import { initAlertTables, registerAlertCommands, runAlertPasses } from './alerts.ts';
import { createApiHandler } from './api.ts';
import { createBot, finishBot, type Ctx } from './bot.ts';
import { readHome, readMembers, required, SCHEDULER, WEBHOOK_PATH, webAppUrl, type Env } from './config.ts';
import { connectDb, setupDb, syncMembers, type Db } from './db.ts';
import { pingDue } from './scheduler.ts';
import type { Home } from './weather.ts';
import { registerWeatherButton } from './weather-report.ts';

// Above the 10 s weather fetch timeout, so a slow forecast is not cut off (a cut-off reply makes Telegram retry).
const WEBHOOK_TIMEOUT_MS = 25_000;

interface App {
  db: Db;
  bot: Bot<Ctx>;
  home: Home | null;
  api: (req: Request) => Promise<Response>;
  webhook: (req: Request) => Promise<Response>;
}

// No I/O here: building is instant, and nothing half-finished is shared between requests.
function build(env: Env): App {
  const token = required(env, 'BOT_TOKEN');
  const db = connectDb(required(env, 'TURSO_DATABASE_URL'), env.TURSO_AUTH_TOKEN);
  const home = readHome(env);

  const bot = createBot(token, db, webAppUrl(env));
  // Feature handlers must come before finishBot's catch-all.
  registerAlertCommands(bot, db);
  registerWeatherButton(bot, home);
  finishBot(bot);

  return {
    db,
    bot,
    home,
    api: createApiHandler(db, token),
    // grammY checks the secret too, but only after a getMe call, so worker.fetch checks it first.
    webhook: webhookCallback(bot, 'cloudflare-mod', {
      secretToken: required(env, 'WEBHOOK_SECRET'),
      timeoutMilliseconds: WEBHOOK_TIMEOUT_MS,
    }),
  };
}

// One app per Worker instance, reused by later requests.
let app: App | undefined;
const getApp = (env: Env): App => (app ??= build(env));

// Tables and members are set up by the cron, once per Worker instance, so requests never wait on it.
// After a deploy or a settings change, member changes apply within a minute.
let setUp = false;
async function setUpOnce(db: Db, env: Env): Promise<void> {
  if (setUp) return;
  await setupDb(db);
  await syncMembers(db, readMembers(env));
  await initAlertTables(db);
  setUp = true;
}

const sameSecret = (given: string | null, expected: string | undefined): boolean => {
  if (!given || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

async function logged(name: string, pass: () => Promise<void>): Promise<void> {
  try {
    await pass();
  } catch (err: unknown) {
    console.error(`${name} pass failed`, err);
  }
}

export default {
  // Strangers get their 401/404 before anything is built or any database or Telegram call is made.
  async fetch(req: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(req.url);
    if (req.method === 'POST' && pathname === WEBHOOK_PATH) {
      if (!sameSecret(req.headers.get('x-telegram-bot-api-secret-token'), env.WEBHOOK_SECRET)) {
        return new Response('Unauthorized', { status: 401 });
      }
      return getApp(env).webhook(req);
    }
    if (!pathname.startsWith('/api/')) return new Response('Not found', { status: 404 });
    return getApp(env).api(req);
  },

  // Runs every minute (wrangler.jsonc). Reminders first, then alerts; one failing does not stop the other.
  // ponytail: no overlap guard; a pass takes seconds, so two never run at once in practice.
  async scheduled(controller: { scheduledTime: number }, env: Env): Promise<void> {
    const { db, bot, home } = getApp(env);
    await setUpOnce(db, env);
    const now = controller.scheduledTime;
    await logged('Reminder', () => pingDue(db, bot.api, SCHEDULER, now));
    if (home) await logged('Alert', () => runAlertPasses(db, bot.api, home, now));
  },
};
