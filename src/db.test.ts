import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createItem, findDueForPing, findMemberByTelegramId, markDone, markPinged, openDb, syncMembers } from './db.ts';

const NOW = 1_000_000_000;
const REPEAT = 5 * 60_000;
const MAX_PINGS = 3;

function setup() {
  const db = openDb(':memory:');
  syncMembers(db, [{ name: 'Mom', role: 'member', telegramId: 111 }]);
  const mom = findMemberByTelegramId(db, 111)!;
  const add = (dueAt: number, important: boolean) =>
    createItem(db, { ownerId: mom.id, createdById: mom.id, title: 'rice', dueAt, important });
  const dueIds = (now = NOW) => findDueForPing(db, now, REPEAT, MAX_PINGS).map((i) => i.id);
  return { db, add, dueIds };
}

test('future and done items are not pinged', () => {
  const { db, add, dueIds } = setup();
  add(NOW + 1, true);
  markDone(db, add(NOW - 1, true));
  assert.deepEqual(dueIds(), []);
});

test('a due item is pinged once, with the owner telegram id', () => {
  const { db, add } = setup();
  const id = add(NOW - 1, false);
  const [item] = findDueForPing(db, NOW, REPEAT, MAX_PINGS);
  assert.equal(item?.id, id);
  assert.equal(item?.ownerTelegramId, 111);
});

test('a normal item is not repeated after its first ping', () => {
  const { db, add, dueIds } = setup();
  markPinged(db, add(NOW - 1, false), NOW);
  assert.deepEqual(dueIds(NOW + REPEAT * 10), []);
});

test('an important item repeats after the interval and stops at the max', () => {
  const { db, add, dueIds } = setup();
  const id = add(NOW - 1, true);
  markPinged(db, id, NOW);
  assert.deepEqual(dueIds(NOW + REPEAT - 1), []);
  assert.deepEqual(dueIds(NOW + REPEAT), [id]);
  markPinged(db, id, NOW + REPEAT);
  markPinged(db, id, NOW + REPEAT * 2);
  assert.deepEqual(dueIds(NOW + REPEAT * 10), []);
});

test('changing an ID in config moves access and keeps items with the member', () => {
  const { db, add } = setup();
  const momId = findMemberByTelegramId(db, 111)!.id;
  add(NOW, false);
  syncMembers(db, [{ name: 'Mom', role: 'member', telegramId: 222 }]);
  assert.equal(findMemberByTelegramId(db, 111), undefined);
  assert.equal(findMemberByTelegramId(db, 222)?.id, momId);
});

test('removing an ID locks the member out, and two members can swap IDs', () => {
  const { db } = setup();
  syncMembers(db, [{ name: 'Mom', role: 'member', telegramId: null }]);
  assert.equal(findMemberByTelegramId(db, 111), undefined);

  syncMembers(db, [
    { name: 'Mom', role: 'member', telegramId: 1 },
    { name: 'Dad', role: 'member', telegramId: 2 },
  ]);
  syncMembers(db, [
    { name: 'Mom', role: 'member', telegramId: 2 },
    { name: 'Dad', role: 'member', telegramId: 1 },
  ]);
  assert.equal(findMemberByTelegramId(db, 2)?.name, 'Mom');
  assert.equal(findMemberByTelegramId(db, 1)?.name, 'Dad');
});

test('an existing database gets the new early_ping_at column', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'fa-')), 'old.db');
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE items (id INTEGER PRIMARY KEY, owner_id INTEGER NOT NULL, created_by_id INTEGER NOT NULL,
    title TEXT NOT NULL, due_at INTEGER NOT NULL, important INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'open',
    ping_count INTEGER NOT NULL DEFAULT 0, last_pinged_at INTEGER, created_at INTEGER NOT NULL, done_at INTEGER)`);
  old.close();
  const db = openDb(path);
  const columns = db.prepare('PRAGMA table_info(items)').all().map((c) => String(c.name));
  assert.ok(columns.includes('early_ping_at'));
});
