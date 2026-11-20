import { Bot, type Context } from 'grammy';
import type { DatabaseSync } from 'node:sqlite';
import { createItem, findItem, findMemberByTelegramId, markDone, type Member } from './db.ts';
import {
  dayKeyboard,
  hourKeyboard,
  importantKeyboard,
  mainKeyboard,
  minuteKeyboard,
  minutesKeyboard,
  REMINDER_MINUTES,
  TIMER_MINUTES,
  timerPresetKeyboard,
} from './keyboards.ts';
import { S } from './strings.ts';
import { earlyPingFor } from './scheduler.ts';
import { formatWhen, yangonHour, yangonTime } from './time.ts';

type Ctx = Context & { member: Member };

type Pending =
  | { step: 'timer-name' }
  | { step: 'timer-minutes'; title: string }
  | { step: 'reminder-text' }
  | { step: 'reminder-day'; title: string }
  | { step: 'reminder-hour'; title: string; dayStart: number }
  | { step: 'reminder-minute'; title: string; dayStart: number; hour: number }
  | { step: 'reminder-important'; title: string; dueAt: number };

const RICE_MINUTES = 20;
const FIRST_HOUR = 5;
const LAST_HOUR = 22;
const MAX_TITLE = 200;

const HOUR_MS = 60 * 60_000;

const hoursFor = (dayStart: number): number[] => {
  const from = dayStart <= Date.now() ? Math.max(FIRST_HOUR, yangonHour()) : FIRST_HOUR;
  return Array.from({ length: Math.max(0, LAST_HOUR - from + 1) }, (_, i) => from + i);
};

export function createBot(token: string, db: DatabaseSync): Bot<Ctx> {
  const bot = new Bot<Ctx>(token);
  // ponytail: drafts live in memory, a restart mid-flow just asks the user to start again.
  const pending = new Map<number, Pending>();

  // Timers ping when they end; scheduled reminders also get a heads-up before.
  const save = async (ctx: Ctx, title: string, dueAt: number, important: boolean, kind: 'timer' | 'reminder') => {
    const earlyPingAt = kind === 'reminder' ? earlyPingFor(dueAt, Date.now()) : null;
    createItem(db, { ownerId: ctx.member.id, createdById: ctx.member.id, title, dueAt, important, earlyPingAt });
    pending.delete(ctx.member.id);
    await ctx.editMessageText(S.saved(title, formatWhen(dueAt)));
  };

  // Only registered family members get past this point.
  bot.use(async (ctx, next) => {
    // Private chats only: in a group, buttons and drafts would get mixed up between people.
    if (!ctx.from || ctx.chat?.type !== 'private') return;
    const member = findMemberByTelegramId(db, ctx.from.id);
    if (!member) {
      await ctx.reply(S.notMember(ctx.from.id));
      return;
    }
    ctx.member = member;
    await next();
  });

  bot.on('callback_query:data', async (ctx, next) => {
    try {
      await ctx.answerCallbackQuery();
    } catch (err: unknown) {
      // Taps queued during an outage are "too old" to answer; still handle the tap itself.
      console.warn('Could not answer callback query', err);
    }
    await next();
  });

  bot.command('start', (ctx) => ctx.reply(S.welcome, { reply_markup: mainKeyboard() }));

  bot.hears(S.timerButton, async (ctx) => {
    pending.delete(ctx.member.id);
    await ctx.reply(S.pickTimer, { reply_markup: timerPresetKeyboard() });
  });

  bot.hears(S.reminderButton, async (ctx) => {
    pending.set(ctx.member.id, { step: 'reminder-text' });
    await ctx.reply(S.askReminderText);
  });

  bot.callbackQuery(/^tp:(rice|curry|laundry|other)$/, async (ctx) => {
    const key = ctx.match[1] as keyof typeof S.presets | 'other';
    if (key === 'rice') return save(ctx, S.presets.rice, Date.now() + RICE_MINUTES * 60_000, true, 'timer');
    if (key === 'other') {
      pending.set(ctx.member.id, { step: 'timer-name' });
      return ctx.editMessageText(S.askTimerName);
    }
    const title = S.presets[key];
    pending.set(ctx.member.id, { step: 'timer-minutes', title });
    return ctx.editMessageText(S.pickMinutes(title), { reply_markup: minutesKeyboard() });
  });

  bot.callbackQuery(/^tm:(\d+)$/, async (ctx) => {
    const p = pending.get(ctx.member.id);
    const minutes = Number(ctx.match[1]);
    if (p?.step !== 'timer-minutes' || !TIMER_MINUTES.includes(minutes)) return ctx.editMessageText(S.expired);
    return save(ctx, p.title, Date.now() + minutes * 60_000, true, 'timer');
  });

  bot.callbackQuery(/^rd:([01])$/, async (ctx) => {
    const p = pending.get(ctx.member.id);
    if (p?.step !== 'reminder-day') return ctx.editMessageText(S.expired);
    // Pin the date now, so a minute picked after midnight still lands on the chosen day.
    const dayStart = yangonTime(Number(ctx.match[1]), 0, 0);
    const hours = hoursFor(dayStart);
    if (hours.length === 0) return ctx.editMessageText(S.timePassed, { reply_markup: dayKeyboard() });
    pending.set(ctx.member.id, { step: 'reminder-hour', title: p.title, dayStart });
    return ctx.editMessageText(S.pickHour, { reply_markup: hourKeyboard(hours) });
  });

  bot.callbackQuery(/^rh:(\d+)$/, async (ctx) => {
    const p = pending.get(ctx.member.id);
    const hour = Number(ctx.match[1]);
    if (p?.step !== 'reminder-hour' || hour < FIRST_HOUR || hour > LAST_HOUR) return ctx.editMessageText(S.expired);
    pending.set(ctx.member.id, { step: 'reminder-minute', title: p.title, dayStart: p.dayStart, hour });
    return ctx.editMessageText(S.pickMinute, { reply_markup: minuteKeyboard(hour) });
  });

  bot.callbackQuery(/^rm:(\d+)$/, async (ctx) => {
    const p = pending.get(ctx.member.id);
    const minute = Number(ctx.match[1]);
    if (p?.step !== 'reminder-minute' || !REMINDER_MINUTES.includes(minute)) return ctx.editMessageText(S.expired);
    // ponytail: no DST in Myanmar, so day start + hours is exact.
    const dueAt = p.dayStart + p.hour * HOUR_MS + minute * 60_000;
    if (dueAt <= Date.now()) {
      pending.set(ctx.member.id, { step: 'reminder-day', title: p.title });
      return ctx.editMessageText(S.timePassed, { reply_markup: dayKeyboard() });
    }
    pending.set(ctx.member.id, { step: 'reminder-important', title: p.title, dueAt });
    return ctx.editMessageText(S.askImportant, { reply_markup: importantKeyboard() });
  });

  bot.callbackQuery(/^ri:([01])$/, async (ctx) => {
    const p = pending.get(ctx.member.id);
    if (p?.step !== 'reminder-important') return ctx.editMessageText(S.expired);
    return save(ctx, p.title, p.dueAt, ctx.match[1] === '1', 'reminder');
  });

  bot.callbackQuery(/^done:(\d+)$/, async (ctx) => {
    const item = findItem(db, Number(ctx.match[1]));
    if (!item) return ctx.editMessageText(S.web.notFound); // deleted in the Mini App
    if (item.ownerId !== ctx.member.id && ctx.member.role !== 'admin') return ctx.editMessageText(S.notAllowed);
    markDone(db, item.id);
    return ctx.editMessageText(S.marked(item.title));
  });

  bot.on('message:text', async (ctx) => {
    const p = pending.get(ctx.member.id);
    const isCommand = ctx.message.text.startsWith('/');
    if (isCommand || (p?.step !== 'timer-name' && p?.step !== 'reminder-text')) {
      return ctx.reply(S.useButtons, { reply_markup: mainKeyboard() });
    }
    const title = ctx.message.text.trim();
    if (title.length === 0 || title.length > MAX_TITLE) return ctx.reply(S.invalidTitle);
    if (p.step === 'timer-name') {
      pending.set(ctx.member.id, { step: 'timer-minutes', title });
      return ctx.reply(S.pickMinutes(title), { reply_markup: minutesKeyboard() });
    }
    pending.set(ctx.member.id, { step: 'reminder-day', title });
    return ctx.reply(S.pickDay(title), { reply_markup: dayKeyboard() });
  });

  bot.catch((err) => console.error('Bot error', err.error));

  return bot;
}
