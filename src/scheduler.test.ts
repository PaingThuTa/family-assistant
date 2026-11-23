import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GrammyError, HttpError } from 'grammy';
import { createItem, findItem, findMemberByTelegramId, openDb, syncMembers } from './db.ts';
import { earlyPingFor, pingDue, type PingApi } from './scheduler.ts';

const NOW = 1_000_000_000;
const OPTS = { repeatMs: 5 * 60_000, maxPings: 6 };

async function setup(send: () => Promise<unknown>) {
  const db = await openDb(':memory:');
  await syncMembers(db, [{ name: 'Mom', role: 'member', telegramId: 111 }]);
  const mom = (await findMemberByTelegramId(db, 111))!;
  const id = await createItem(db, { ownerId: mom.id, createdById: mom.id, title: 'rice', dueAt: NOW - 1, important: false });
  const sent: number[] = [];
  const api = {
    sendMessage: async (chatId: number | string) => {
      sent.push(Number(chatId));
      return send();
    },
  } as unknown as PingApi;
  return { db, api, id, sent };
}

test('a sent ping is recorded and not sent again', async () => {
  const { db, api, id, sent } = await setup(async () => ({}));
  await pingDue(db, api, OPTS, NOW);
  await pingDue(db, api, OPTS, NOW + 30_000);
  assert.deepEqual(sent, [111]);
  assert.equal((await findItem(db, id))?.pingCount, 1);
});

test('a network error is retried on the next pass', async () => {
  const { db, api, id, sent } = await setup(async () => {
    throw new HttpError('network down', new Error('ECONNRESET'));
  });
  await pingDue(db, api, OPTS, NOW);
  await pingDue(db, api, OPTS, NOW + 30_000);
  assert.equal(sent.length, 2);
  assert.equal((await findItem(db, id))?.pingCount, 0);
});

test('a blocked bot (403) is not retried every pass', async () => {
  const { db, api, id, sent } = await setup(async () => {
    throw new GrammyError('blocked', { ok: false, error_code: 403, description: 'Forbidden' }, 'sendMessage', {});
  });
  await pingDue(db, api, OPTS, NOW);
  await pingDue(db, api, OPTS, NOW + 30_000);
  assert.equal(sent.length, 1);
  assert.equal((await findItem(db, id))?.pingCount, 1);
});

async function setupEarly(dueAt: number, earlyPingAt: number | null) {
  const db = await openDb(':memory:');
  await syncMembers(db, [{ name: 'Mom', role: 'member', telegramId: 111 }]);
  const mom = (await findMemberByTelegramId(db, 111))!;
  const id = await createItem(db, { ownerId: mom.id, createdById: mom.id, title: 'medicine', dueAt, important: false, earlyPingAt });
  const texts: string[] = [];
  const api = {
    sendMessage: async (_chatId: number | string, text: string) => {
      texts.push(text);
      return {};
    },
  } as unknown as PingApi;
  return { db, api, id, texts };
}

test('earlyPingFor gives 10 minutes before, or nothing if that is already past', () => {
  assert.equal(earlyPingFor(NOW + 60 * 60_000, NOW), NOW + 50 * 60_000);
  assert.equal(earlyPingFor(NOW + 5 * 60_000, NOW), null);
});

test('a heads-up is sent once before the due time, then the on-time ping', async () => {
  const due = NOW + 10 * 60_000;
  const { db, api, texts } = await setupEarly(due, NOW);
  await pingDue(db, api, OPTS, NOW);
  await pingDue(db, api, OPTS, NOW + 30_000);
  assert.equal(texts.length, 1);
  assert.match(texts[0]!, /^10 မိနစ်အကြာ/);
  await pingDue(db, api, OPTS, due);
  assert.equal(texts.length, 2);
  assert.match(texts[1]!, /^သတိပေးချက်/);
});

test('a heads-up that is late (bot was down) is skipped', async () => {
  const due = NOW;
  const { db, api, id, texts } = await setupEarly(due, NOW - 10 * 60_000);
  await pingDue(db, api, OPTS, NOW + 1);
  assert.equal(texts.length, 1);
  assert.match(texts[0]!, /^သတိပေးချက်/);
  assert.equal((await findItem(db, id))?.earlyPingAt, null);
});

test('admin is told once when an important item uses up its pings', async () => {
  const db = await openDb(':memory:');
  await syncMembers(db, [
    { name: 'Admin', role: 'admin', telegramId: 999 },
    { name: 'Mom', role: 'member', telegramId: 111 },
  ]);
  const mom = (await findMemberByTelegramId(db, 111))!;
  const id = await createItem(db, { ownerId: mom.id, createdById: mom.id, title: 'rice', dueAt: NOW, important: true });
  const sent: [number, string][] = [];
  const api = {
    sendMessage: async (chatId: number | string, text: string) => {
      sent.push([Number(chatId), text]);
      return {};
    },
  } as unknown as PingApi;
  const opts = { repeatMs: 60_000, maxPings: 2 };

  await pingDue(db, api, opts, NOW); // ping 1
  await pingDue(db, api, opts, NOW + 60_000); // ping 2 (the last)
  await pingDue(db, api, opts, NOW + 90_000); // too soon to alert
  assert.deepEqual(sent.map(([chat]) => chat), [111, 111]);

  await pingDue(db, api, opts, NOW + 120_000); // one interval after the last ping
  await pingDue(db, api, opts, NOW + 180_000); // not again
  assert.deepEqual(sent.map(([chat]) => chat), [111, 111, 999]);
  assert.match(sent[2]![1], /^မေမေ မပြီးသေးပါ/);
  assert.ok((await findItem(db, id))?.status === 'open');
});
