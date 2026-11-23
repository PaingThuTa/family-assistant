import { webhookCallback, type Bot } from 'grammy';
import { initAlertTables, registerAlertCommands, runAlertPasses } from './alerts.ts';
import { createApiHandler } from './api.ts';
import { createBot, finishBot, type Ctx } from './bot.ts';
import { readHome, readMembers, required, SCHEDULER, WEBHOOK_PATH, webAppUrl, type Env } from './config.ts';
import { openDb, syncMembers, type Db } from './db.ts';
import { pingDue } from './scheduler.ts';
import type { Home } from './weather.ts';
import { registerWeatherButton } from './weather-report.ts';

interface App {
  db: Db;
  bot: Bot<Ctx>;
  home: Home | null;
  api: (req: Request) => Promise<Response>;
  webhook: (req: Request) => Promise<Response>;
}

async function build(env: Env): Promise<App> {
  const token = required(env, 'BOT_TOKEN');
  const db = await openDb(required(env, 'TURSO_DATABASE_URL'), env.TURSO_AUTH_TOKEN);
  await syncMembers(db, readMembers(env));
  await initAlertTables(db);
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
    // Telegram sends this secret with every update, so nobody else can post fake updates.
    webhook: webhookCallback(bot, 'cloudflare-mod', { secretToken: required(env, 'WEBHOOK_SECRET') }),
  };
}

// One app per Worker instance: set up on the first request or cron, then reused.
let app: Promise<App> | undefined;
const getApp = (env: Env): Promise<App> =>
  (app ??= build(env).catch((err: unknown) => {
    app = undefined; // try again next time instead of caching the failure
    throw err;
  }));

async function logged(name: string, pass: () => Promise<void>): Promise<void> {
  try {
    await pass();
  } catch (err: unknown) {
    console.error(`${name} pass failed`, err);
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const { api, webhook } = await getApp(env);
    if (req.method === 'POST' && new URL(req.url).pathname === WEBHOOK_PATH) return webhook(req);
    return api(req);
  },

  // Runs every minute (wrangler.jsonc). Reminders first, then alerts; one failing does not stop the other.
  // ponytail: no overlap guard; a pass takes seconds, so two never run at once in practice.
  async scheduled(controller: { scheduledTime: number }, env: Env): Promise<void> {
    const { db, bot, home } = await getApp(env);
    const now = controller.scheduledTime;
    await logged('Reminder', () => pingDue(db, bot.api, SCHEDULER, now));
    if (home) await logged('Alert', () => runAlertPasses(db, bot.api, home, now));
  },
};
