import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextReply } from './bot.ts';
import { createItem, findMemberByTelegramId, findWhatsNext, openDb, syncMembers, type Item } from './db.ts';

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

test('11 late tasks do not hide the next upcoming one (review bug)', () => {
  const db = openDb(':memory:');
  syncMembers(db, [{ name: 'Mom', role: 'member', telegramId: 1 }]);
  const mom = findMemberByTelegramId(db, 1)!.id;
  const add = (title: string, dueAt: number) => createItem(db, { ownerId: mom, createdById: mom, title, dueAt, important: false });
  for (let i = 0; i < 11; i++) add(`late ${i}`, NOW - (20 - i) * 60_000);
  const nextId = add('upcoming', NOW + 60_000);
  const { late, next } = findWhatsNext(db, mom, NOW, 3);
  assert.equal(late.length, 3);
  assert.equal(next?.id, nextId);
  assert.match(nextReply(late, next, NOW).text, /နောက်တစ်ခု: upcoming/);
});
