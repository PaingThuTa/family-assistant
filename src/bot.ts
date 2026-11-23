import { Bot, type Context } from 'grammy';
import { findItem, findMemberByTelegramId, findWhatsNext, markDone, type Db, type Item, type Member } from './db.ts';
import { doneKeyboard, mainKeyboard, openNotesKeyboard } from './keyboards.ts';
import { S } from './strings.ts';
import { formatWhen } from './time.ts';

export type Ctx = Context & { member: Member };

const MAX_LATE_SHOWN = 3;

// "What's next?": unfinished late tasks first (a few), then the next upcoming one.
export function nextReply(late: Item[], next: Item | undefined, now: number): { text: string; nextId: number | null } {
  const lines = [
    ...(late.length > 0 ? [S.lateHeader, ...late.map((i) => `• ${i.title} (${formatWhen(i.dueAt, now)})`), ''] : []),
    next ? S.next(next.title, formatWhen(next.dueAt, now)) : S.nothingNext,
  ];
  return { text: lines.join('\n'), nextId: next?.id ?? null };
}

export function createBot(token: string, db: Db, webAppUrl: string | null): Bot<Ctx> {
  const bot = new Bot<Ctx>(token);

  // Only registered family members get past this point.
  bot.use(async (ctx, next) => {
    // Private chats only: in a group, buttons would get mixed up between people.
    if (!ctx.from || ctx.chat?.type !== 'private') return;
    const member = await findMemberByTelegramId(db, ctx.from.id);
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

  bot.hears(S.nextButton, async (ctx) => {
    const now = Date.now();
    const { late, next } = await findWhatsNext(db, ctx.member.id, now, MAX_LATE_SHOWN);
    const { text, nextId } = nextReply(late, next, now);
    await ctx.reply(text, nextId === null ? {} : { reply_markup: doneKeyboard(nextId) });
  });

  bot.hears(S.notesButton, async (ctx) => {
    if (!webAppUrl) return ctx.reply(S.notesUnavailable);
    return ctx.reply(S.notesIntro, { reply_markup: openNotesKeyboard(webAppUrl) });
  });

  bot.callbackQuery(/^done:(\d+)$/, async (ctx) => {
    const item = await findItem(db, Number(ctx.match[1]));
    if (!item) return ctx.editMessageText(S.web.notFound); // deleted in the Mini App
    if (item.ownerId !== ctx.member.id && ctx.member.role !== 'admin') return ctx.editMessageText(S.notAllowed);
    await markDone(db, item.id);
    return ctx.editMessageText(S.marked(item.title));
  });

  return bot;
}

// Registered last, so feature modules can add handlers between createBot() and this.
export function finishBot(bot: Bot<Ctx>): void {
  bot.on('message', (ctx) => ctx.reply(S.useButtons, { reply_markup: mainKeyboard() }));
  bot.catch((err) => console.error('Bot error', err.error));
}
