import { InlineKeyboard, type Bot } from 'grammy';
import type { Ctx } from './bot.ts';
import { first, rows, run, type Db } from './db.ts';
import type { PingApi } from './scheduler.ts';
import { formatTime, yangonParts } from './time.ts';
import { fetchReport, formatReport } from './weather-report.ts';
import {
  distanceKm,
  fetchForecast,
  fetchQuakes,
  nearbyRecentQuakes,
  rainSoon,
  type FetchFn,
  type Home,
} from './weather.ts';

export const ALERT_KINDS = ['rain', 'daily', 'quake'] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

const WEATHER_EVERY_MINUTES = 15;
const QUAKE_EVERY_MINUTES = 2;
const DAILY_HOUR = 7;
const QUIET_FROM_HOUR = 21;
const QUIET_TO_HOUR = 6;
const KEEP_SENT_MS = 30 * 24 * 60 * 60_000; // de-dup keys older than this are useless

// Burmese alert text. Review the wording with Mom.
const A = {
  intro:
    'သတိပေးချက် ရွေးပါ:\n' +
    '• မိုးရွာမယ် - ၂ နာရီအတွင်း မိုးရွာနိုင်ရင် ပြောမယ်\n' +
    '• နေ့စဉ် ရာသီဥတု - မနက် ၇ နာရီမှာ ဒီနေ့ အပူချိန်နဲ့ မိုး\n' +
    '• ငလျင် - အနီးမှာ ငလျင် လှုပ်ခဲ့ရင် ပြောမယ်\n' +
    'ခလုတ်ကို နှိပ်ပြီး ဖွင့်/ပိတ် လုပ်ပါ။',
  labels: { rain: 'မိုးရွာမယ်', daily: 'နေ့စဉ် ရာသီဥတု', quake: 'ငလျင်' } as Record<AlertKind, string>,
  on: 'ဖွင့်ထား',
  off: 'ပိတ်ထား',
  command: 'ရာသီဥတု နဲ့ ငလျင် သတိပေးချက်',
  rain: 'မကြာခင် မိုးရွာမယ်။ အဝတ်လှန်းထားရင် ရုတ်ထားပါ။ အပြင်ထွက်ရင် ထီး ယူသွားပါ။',
  quake: (magnitude: string, km: number, place: string, time: string) =>
    `ငလျင် လှုပ်ခဲ့ပါတယ် (ဖြစ်ပြီးသား သတင်းပါ)\nအား: ${magnitude}\nအကွာအဝေး: ${km} km\nနေရာ: ${place}\nအချိန်: ${time}`,
} as const;

export const ALERT_COMMANDS = [{ command: 'alerts', description: A.command }];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS alert_subscriptions (
  member_id INTEGER NOT NULL REFERENCES members(id),
  kind TEXT NOT NULL CHECK (kind IN ('rain', 'daily', 'quake')),
  PRIMARY KEY (member_id, kind)
);
CREATE TABLE IF NOT EXISTS sent_alerts (
  key TEXT PRIMARY KEY,
  sent_at INTEGER NOT NULL
);
`;

export async function initAlertTables(db: Db): Promise<void> {
  await db.executeMultiple(SCHEMA);
}

export async function listSubscriptions(db: Db, memberId: number): Promise<AlertKind[]> {
  return (await rows(db, 'SELECT kind FROM alert_subscriptions WHERE member_id = ?', memberId)).map((r) => r.kind as AlertKind);
}

// Returns true if the member is now subscribed.
export async function toggleSubscription(db: Db, memberId: number, kind: AlertKind): Promise<boolean> {
  const removed = await run(db, 'DELETE FROM alert_subscriptions WHERE member_id = ? AND kind = ?', memberId, kind);
  if (removed.rowsAffected > 0) return false;
  // OR IGNORE: a quick double tap must not fail on the primary key.
  await run(db, 'INSERT OR IGNORE INTO alert_subscriptions (member_id, kind) VALUES (?, ?)', memberId, kind);
  return true;
}

// Telegram IDs of active members subscribed to a kind.
export async function listSubscribers(db: Db, kind: AlertKind): Promise<number[]> {
  return (
    await rows(
      db,
      `SELECT m.telegram_id FROM alert_subscriptions s JOIN members m ON m.id = s.member_id
       WHERE s.kind = ? AND m.telegram_id IS NOT NULL ORDER BY m.id`,
      kind,
    )
  ).map((r) => Number(r.telegram_id));
}

export const wasSent = async (db: Db, key: string): Promise<boolean> =>
  (await first(db, 'SELECT 1 FROM sent_alerts WHERE key = ?', key)) !== undefined;

export async function markSent(db: Db, key: string, now: number): Promise<void> {
  await run(db, 'INSERT OR IGNORE INTO sent_alerts (key, sent_at) VALUES (?, ?)', key, now);
}

const pruneSent = (db: Db, now: number) => run(db, 'DELETE FROM sent_alerts WHERE sent_at < ?', now - KEEP_SENT_MS);

const hasSubscribers = async (db: Db, kind: AlertKind) => (await listSubscribers(db, kind)).length > 0;

// At most one rain alert per part of the day (morning / afternoon / evening).
const dayPart = (hour: number) => (hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening');

async function alertKeyboard(db: Db, memberId: number): Promise<InlineKeyboard> {
  const on = await listSubscriptions(db, memberId);
  return ALERT_KINDS.reduce(
    (kb, kind) => kb.text(`${A.labels[kind]}: ${on.includes(kind) ? A.on : A.off}`, `al:${kind}`).row(),
    new InlineKeyboard(),
  );
}

// Call between createBot() and finishBot().
export function registerAlertCommands(bot: Bot<Ctx>, db: Db): void {
  bot.command('alerts', async (ctx) => ctx.reply(A.intro, { reply_markup: await alertKeyboard(db, ctx.member.id) }));
  bot.callbackQuery(/^al:(rain|daily|quake)$/, async (ctx) => {
    await toggleSubscription(db, ctx.member.id, ctx.match[1] as AlertKind);
    await ctx.editMessageReplyMarkup({ reply_markup: await alertKeyboard(db, ctx.member.id) });
  });
}

// Sends to every subscriber once, then records the key. Failed sends are logged, not retried,
// so one blocked chat does not resend the whole batch every pass.
async function broadcast(
  db: Db,
  api: PingApi,
  kind: AlertKind,
  key: string,
  text: string,
  now: number,
): Promise<void> {
  for (const chatId of await listSubscribers(db, kind)) {
    try {
      await api.sendMessage(chatId, text);
    } catch (err: unknown) {
      console.error(`Alert ${key} failed for chat ${chatId}`, err);
    }
  }
  await markSent(db, key, now);
}

export async function runWeatherPass(
  db: Db,
  api: PingApi,
  home: Home,
  now: number,
  fetchFn: FetchFn,
): Promise<void> {
  await pruneSent(db, now);
  const { date, time } = yangonParts(now);
  const hour = Number(time.slice(0, 2));
  // ponytail: daily also waits for daytime, so a late-night restart does not send "today" at 23:00.
  const quiet = hour >= QUIET_FROM_HOUR || hour < QUIET_TO_HOUR;
  const rainKey = `rain:${date}:${dayPart(hour)}`;
  const dailyKey = `daily:${date}`;
  // Nothing is fetched for an alert nobody has turned on.
  const wantRain = !quiet && (await hasSubscribers(db, 'rain')) && !(await wasSent(db, rainKey));
  const wantDaily = !quiet && hour >= DAILY_HOUR && (await hasSubscribers(db, 'daily')) && !(await wasSent(db, dailyKey));

  if (wantRain) {
    try {
      if (rainSoon(await fetchForecast(home, fetchFn), now)) await broadcast(db, api, 'rain', rainKey, A.rain, now);
    } catch (err: unknown) {
      console.error('Weather fetch failed', err);
    }
  }
  // The daily alert is the same report as the Weather button.
  if (wantDaily) {
    try {
      await broadcast(db, api, 'daily', dailyKey, formatReport(await fetchReport(home, fetchFn)), now);
    } catch (err: unknown) {
      console.error('Daily weather report failed', err);
    }
  }
}

export async function runQuakePass(
  db: Db,
  api: PingApi,
  home: Home,
  now: number,
  fetchFn: FetchFn,
): Promise<void> {
  if (!(await hasSubscribers(db, 'quake'))) return;
  let quakes;
  try {
    quakes = await fetchQuakes(fetchFn);
  } catch (err: unknown) {
    console.error('Quake fetch failed', err);
    return;
  }
  for (const q of nearbyRecentQuakes(quakes, home, now)) {
    const key = `quake:${q.id}`;
    if (await wasSent(db, key)) continue;
    const text = A.quake(q.magnitude.toFixed(1), Math.round(distanceKm(home, q)), q.place, formatTime(q.timeMs));
    await broadcast(db, api, 'quake', key, text, now);
  }
}

// Called by the every-minute cron with its scheduled time: quakes every 2 minutes, weather every 15.
export async function runAlertPasses(db: Db, api: PingApi, home: Home, now: number, fetchFn: FetchFn = fetch): Promise<void> {
  const minute = Math.floor(now / 60_000);
  if (minute % QUAKE_EVERY_MINUTES === 0) await runQuakePass(db, api, home, now, fetchFn);
  if (minute % WEATHER_EVERY_MINUTES === 0) await runWeatherPass(db, api, home, now, fetchFn);
}
