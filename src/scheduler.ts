import { GrammyError, type Api } from 'grammy';
import {
  createNextOccurrence,
  findDueForPing,
  findEarlyDue,
  findRepeatsDue,
  findUnanswered,
  listActiveMembers,
  markAlerted,
  markEarlySent,
  markPinged,
  type Db,
  type DueItem,
} from './db.ts';
import { doneKeyboard } from './keyboards.ts';
import { S } from './strings.ts';
import { formatTime } from './time.ts';

export const EARLY_MINUTES = 10;

// Scheduled reminders get a heads-up ping, unless it would already be in the past. Timers never do.
export const earlyPingFor = (dueAt: number, now: number): number | null => {
  const at = dueAt - EARLY_MINUTES * 60_000;
  return at > now ? at : null;
};

export interface SchedulerOptions {
  repeatMs: number;
  maxPings: number;
}

export type PingApi = Pick<Api, 'sendMessage'>;

// 4xx from Telegram (bot blocked, chat not found) will not fix itself by retrying in 30s.
const isPermanent = (err: unknown) =>
  err instanceof GrammyError && err.error_code >= 400 && err.error_code < 500 && err.error_code !== 429;

// Sends one message and records it. Network/server errors are left unrecorded so the next pass
// retries; permanent errors are recorded so they are not retried every 30 seconds.
async function send(api: PingApi, chatId: number, item: DueItem, text: string, record: () => Promise<void>): Promise<void> {
  try {
    await api.sendMessage(chatId, text, { reply_markup: doneKeyboard(item.id) });
    await record();
  } catch (err: unknown) {
    console.error(`Ping failed for item ${item.id}`, err);
    if (isPermanent(err)) await record();
  }
}

// Tells the admin about important items that got every ping and still no Done.
async function alertAdmin(db: Db, api: PingApi, opts: SchedulerOptions, now: number): Promise<void> {
  const unanswered = await findUnanswered(db, now, opts.repeatMs, opts.maxPings);
  if (unanswered.length === 0) return;
  const admin = (await listActiveMembers(db)).find((m) => m.role === 'admin');
  for (const item of unanswered) {
    if (!admin?.telegramId) {
      await markAlerted(db, item.id, now); // nobody to tell; don't re-check it every pass
      continue;
    }
    const text = S.unanswered(S.names[item.ownerName] ?? item.ownerName, item.title, formatTime(item.dueAt));
    await send(api, admin.telegramId, item, text, () => markAlerted(db, item.id, now));
  }
}

const DAY_MS = 24 * 60 * 60_000;

// The next time after now, so days the bot was down are skipped instead of piling up.
const nextDue = (dueAt: number, repeatDays: number, now: number): number => {
  const period = repeatDays * DAY_MS;
  return dueAt + (Math.floor((now - dueAt) / period) + 1) * period;
};

// A repeating item makes its next occurrence when it comes due, Done or not.
async function createRepeats(db: Db, now: number): Promise<void> {
  for (const item of await findRepeatsDue(db, now)) {
    const dueAt = nextDue(item.dueAt, item.repeatDays!, now);
    await createNextOccurrence(db, item.id, dueAt, earlyPingFor(dueAt, now), now);
  }
}

// One pass: next occurrences of repeating items, heads-up pings, on-time and repeat pings, then alerts.
export async function pingDue(db: Db, api: PingApi, opts: SchedulerOptions, now: number): Promise<void> {
  await createRepeats(db, now);
  for (const item of await findEarlyDue(db, now)) {
    const text = S.early(EARLY_MINUTES, item.title, formatTime(item.dueAt));
    await send(api, item.ownerTelegramId, item, text, () => markEarlySent(db, item.id));
  }
  for (const item of await findDueForPing(db, now, opts.repeatMs, opts.maxPings)) {
    await send(api, item.ownerTelegramId, item, S.ping(item.title), () => markPinged(db, item.id, now));
  }
  await alertAdmin(db, api, opts, now);
}
