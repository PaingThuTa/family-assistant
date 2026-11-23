import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBot, nextReply } from './bot.ts';
import { createItem, findMemberByTelegramId, findWhatsNext, openDb, syncMembers, type Item } from './db.ts';
import { S } from './strings.ts';

const NOW = Date.UTC(2026, 10, 20, 3, 0); // 09:30 in Yangon
const item = (id: number, title: string, dueAt: number): Item => ({
  id, ownerId: 1, createdById: 1, title, dueAt, important: false, status: 'open',
  pingCount: 0, lastPingedAt: null, earlyPingAt: null,
});

test('shows the next upcoming task with its Done id', () => {
  const r = nextReply([], item(1, 'rice', NOW + 60 * 60_000), NOW);
  assert.equal(r.text, 'နောက်တစ်ခု: rice\nဒီနေ့ မနက် 10:30');
  assert.equal(r.nextId, 1);
});

test('lists late tasks first, then the next one', () => {
  const r = nextReply([item(1, 'medicine', NOW - 60_000)], item(2, 'market', NOW + 60_000), NOW);
  assert.match(r.text, /^မပြီးသေးတာ:\n• medicine/);
  assert.match(r.text, /နောက်တစ်ခု: market/);
  assert.equal(r.nextId, 2);
});

test('says nothing is left when there are no tasks', () => {
  assert.deepEqual(nextReply([], undefined, NOW), { text: 'လုပ်စရာ မရှိတော့ပါ။', nextId: null });
});

test('11 late tasks do not hide the next upcoming one (review bug)', async () => {
  const db = await openDb(':memory:');
  await syncMembers(db, [{ name: 'Mom', role: 'member', telegramId: 1 }]);
  const mom = (await findMemberByTelegramId(db, 1))!.id;
  const add = (title: string, dueAt: number) => createItem(db, { ownerId: mom, createdById: mom, title, dueAt, important: false });
  for (let i = 0; i < 11; i++) await add(`late ${i}`, NOW - (20 - i) * 60_000);
  const nextId = await add('upcoming', NOW + 60_000);
  const { late, next } = await findWhatsNext(db, mom, NOW, 3);
  assert.equal(late.length, 3);
  assert.equal(next?.id, nextId);
  assert.match(nextReply(late, next, NOW).text, /နောက်တစ်ခု: upcoming/);
});

test('"typing..." is shown before the reply, so a slow answer does not look like nothing happened', async () => {
  const db = await openDb(':memory:');
  await syncMembers(db, [{ name: 'Mom', role: 'member', telegramId: 1 }]);
  const bot = createBot('1:x', db, null);
  bot.botInfo = { id: 9, is_bot: true, first_name: 'bot', username: 'bot' } as typeof bot.botInfo;
  const calls: string[] = [];
  bot.api.config.use(async (_prev, method) => {
    calls.push(method);
    return { ok: true, result: true } as never;
  });
  const message = { message_id: 1, date: 0, chat: { id: 1, type: 'private' as const, first_name: 'Mom' }, from: { id: 1, is_bot: false, first_name: 'Mom' } };
  await bot.handleUpdate({ update_id: 1, message: { ...message, text: S.nextButton } });
  assert.deepEqual(calls, ['sendChatAction', 'sendMessage']);
});
