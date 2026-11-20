import { InlineKeyboard, type Bot } from 'grammy';
import type { DatabaseSync } from 'node:sqlite';
import type { Ctx } from './bot.ts';
import type { PingApi } from './scheduler.ts';
import { formatTime, yangonParts } from './time.ts';
import {
  distanceKm,
  fetchForecast,
  fetchQuakes,
  nearbyRecentQuakes,
  rainSoon,
  todaySummary,
  type FetchFn,
  type Home,
} from './weather.ts';

export const ALERT_KINDS = ['rain', 'daily', 'quake'] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

const WEATHER_INTERVAL_MS = 15 * 60_000;
const QUAKE_INTERVAL_MS = 2 * 60_000;
const DAILY_HOUR = 7;
const QUIET_FROM_HOUR = 21;
const QUIET_TO_HOUR = 6;

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
  daily: (maxTemp: number, rainChance: number) =>
    `ဒီနေ့ ရာသီဥတု\nအပူဆုံး: ${maxTemp}°C\nမိုးရွာနိုင်ခြေ: ${rainChance}%`,
  heat: 'အရမ်းပူမယ်။ ရေ များများ သောက်ပါ။ နေပူထဲ မထွက်ပါနဲ့။',
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

export function initAlertTables(db: DatabaseSync): void {
  db.exec(SCHEMA);
}

export function listSubscriptions(db: DatabaseSync, memberId: number): AlertKind[] {
  return db
    .prepare('SELECT kind FROM alert_subscriptions WHERE member_id = ?')
    .all(memberId)
    .map((r) => r.kind as AlertKind);
}

// Returns true if the member is now subscribed.
export function toggleSubscription(db: DatabaseSync, memberId: number, kind: AlertKind): boolean {
  const removed = db.prepare('DELETE FROM alert_subscriptions WHERE member_id = ? AND kind = ?').run(memberId, kind);
  if (Number(removed.changes) > 0) return false;
  db.prepare('INSERT INTO alert_subscriptions (member_id, kind) VALUES (?, ?)').run(memberId, kind);
  return true;
}

// Telegram IDs of active members subscribed to a kind.
export function listSubscribers(db: DatabaseSync, kind: AlertKind): number[] {
  return db
    .prepare(
      `SELECT m.telegram_id FROM alert_subscriptions s JOIN members m ON m.id = s.member_id
       WHERE s.kind = ? AND m.telegram_id IS NOT NULL ORDER BY m.id`,
    )
    .all(kind)
    .map((r) => Number(r.telegram_id));
}

export const wasSent = (db: DatabaseSync, key: string): boolean =>
  db.prepare('SELECT 1 FROM sent_alerts WHERE key = ?').get(key) !== undefined;

export function markSent(db: DatabaseSync, key: string, now: number): void {
  db.prepare('INSERT OR IGNORE INTO sent_alerts (key, sent_at) VALUES (?, ?)').run(key, now);
}

function alertKeyboard(db: DatabaseSync, memberId: number): InlineKeyboard {
  const on = listSubscriptions(db, memberId);
  return ALERT_KINDS.reduce(
    (kb, kind) => kb.text(`${A.labels[kind]}: ${on.includes(kind) ? A.on : A.off}`, `al:${kind}`).row(),
    new InlineKeyboard(),
  );
}

// Call between createBot() and finishBot().
export function registerAlertCommands(bot: Bot<Ctx>, db: DatabaseSync): void {
  bot.command('alerts', (ctx) => ctx.reply(A.intro, { reply_markup: alertKeyboard(db, ctx.member.id) }));
  bot.callbackQuery(/^al:(rain|daily|quake)$/, async (ctx) => {
    toggleSubscription(db, ctx.member.id, ctx.match[1] as AlertKind);
    await ctx.editMessageReplyMarkup({ reply_markup: alertKeyboard(db, ctx.member.id) });
  });
}

// Sends to every subscriber once, then records the key. Failed sends are logged, not retried,
// so one blocked chat does not resend the whole batch every pass.
async function broadcast(
  db: DatabaseSync,
  api: PingApi,
  kind: AlertKind,
  key: string,
  text: string,
  now: number,
): Promise<void> {
  for (const chatId of listSubscribers(db, kind)) {
    try {
      await api.sendMessage(chatId, text);
    } catch (err: unknown) {
      console.error(`Alert ${key} failed for chat ${chatId}`, err);
    }
  }
  markSent(db, key, now);
}

export async function runWeatherPass(
  db: DatabaseSync,
  api: PingApi,
  home: Home,
  now: number,
  fetchFn: FetchFn,
): Promise<void> {
  const { date, time } = yangonParts(now);
  const hour = Number(time.slice(0, 2));
  // ponytail: daily also waits for daytime, so a late-night restart does not send "today" at 23:00.
  const quiet = hour >= QUIET_FROM_HOUR || hour < QUIET_TO_HOUR;
  const rainKey = `rain:${date}:${Math.floor(hour / 3)}`;
  const dailyKey = `daily:${date}`;
  const wantRain = !quiet && !wasSent(db, rainKey);
  const wantDaily = !quiet && hour >= DAILY_HOUR && !wasSent(db, dailyKey);
  if (!wantRain && !wantDaily) return;

  let forecast;
  try {
    forecast = await fetchForecast(home, fetchFn);
  } catch (err: unknown) {
    console.error('Weather fetch failed', err);
    return;
  }
  if (wantRain && rainSoon(forecast, now)) await broadcast(db, api, 'rain', rainKey, A.rain, now);
  const summary = wantDaily ? todaySummary(forecast, now) : null;
  if (summary) {
    const text = [A.daily(summary.maxTemp, summary.rainChance), ...(summary.heat ? [A.heat] : [])].join('\n');
    await broadcast(db, api, 'daily', dailyKey, text, now);
  }
}

export async function runQuakePass(
  db: DatabaseSync,
  api: PingApi,
  home: Home,
  now: number,
  fetchFn: FetchFn,
): Promise<void> {
  let quakes;
  try {
    quakes = await fetchQuakes(fetchFn);
  } catch (err: unknown) {
    console.error('Quake fetch failed', err);
    return;
  }
  for (const q of nearbyRecentQuakes(quakes, home, now)) {
    const key = `quake:${q.id}`;
    if (wasSent(db, key)) continue;
    const text = A.quake(q.magnitude.toFixed(1), Math.round(distanceKm(home, q)), q.place, formatTime(q.timeMs));
    await broadcast(db, api, 'quake', key, text, now);
  }
}

// Runs a pass on an interval, never two at once. Returns a stop function.
function every(ms: number, name: string, pass: (now: number) => Promise<void>): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await pass(Date.now());
    } catch (err: unknown) {
      console.error(`${name} pass failed`, err);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, ms);
  void tick();
  return () => clearInterval(timer);
}

export function startAlerts(db: DatabaseSync, api: PingApi, home: Home, fetchFn: FetchFn = fetch): () => void {
  const stopWeather = every(WEATHER_INTERVAL_MS, 'Weather', (now) => runWeatherPass(db, api, home, now, fetchFn));
  const stopQuakes = every(QUAKE_INTERVAL_MS, 'Quake', (now) => runQuakePass(db, api, home, now, fetchFn));
  return () => {
    stopWeather();
    stopQuakes();
  };
}
