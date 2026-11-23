import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createItem, findDueForPing, findEarlyDue, findMemberByTelegramId, findUnanswered, markDone, markPinged, openDb, rows, syncMembers } from './db.ts';
import { addNoteItem, createNote, deleteNote } from './notes-db.ts';

const NOW = 1_000_000_000;
const REPEAT = 5 * 60_000;
const MAX_PINGS = 3;

async function setup() {
  const db = await openDb(':memory:');
  await syncMembers(db, [{ name: 'Mom', role: 'member', telegramId: 111 }]);
  const mom = (await findMemberByTelegramId(db, 111))!;
  const add = (dueAt: number, important: boolean) =>
    createItem(db, { ownerId: mom.id, createdById: mom.id, title: 'rice', dueAt, important });
  const dueIds = async (now = NOW) => (await findDueForPing(db, now, REPEAT, MAX_PINGS)).map((i) => i.id);
  return { db, mom, add, dueIds };
}

test('future and done items are not pinged', async () => {
  const { db, add, dueIds } = await setup();
  await add(NOW + 1, true);
  await markDone(db, await add(NOW - 1, true));
  assert.deepEqual(await dueIds(), []);
});

test('a due item is pinged once, with the owner telegram id', async () => {
  const { db, add } = await setup();
  const id = await add(NOW - 1, false);
  const [item] = await findDueForPing(db, NOW, REPEAT, MAX_PINGS);
  assert.equal(item?.id, id);
  assert.equal(item?.ownerTelegramId, 111);
});

test('a normal item is not repeated after its first ping', async () => {
  const { db, add, dueIds } = await setup();
  await markPinged(db, await add(NOW - 1, false), NOW);
  assert.deepEqual(await dueIds(NOW + REPEAT * 10), []);
});

test('an important item repeats after the interval and stops at the max', async () => {
  const { db, add, dueIds } = await setup();
  const id = await add(NOW - 1, true);
  await markPinged(db, id, NOW);
  assert.deepEqual(await dueIds(NOW + REPEAT - 1), []);
  assert.deepEqual(await dueIds(NOW + REPEAT), [id]);
  await markPinged(db, id, NOW + REPEAT);
  await markPinged(db, id, NOW + REPEAT * 2);
  assert.deepEqual(await dueIds(NOW + REPEAT * 10), []);
});

test('changing an ID in config moves access and keeps items with the member', async () => {
  const { db, add } = await setup();
  const momId = (await findMemberByTelegramId(db, 111))!.id;
  await add(NOW, false);
  await syncMembers(db, [{ name: 'Mom', role: 'member', telegramId: 222 }]);
  assert.equal(await findMemberByTelegramId(db, 111), undefined);
  assert.equal((await findMemberByTelegramId(db, 222))?.id, momId);
});

test('removing an ID locks the member out, and two members can swap IDs', async () => {
  const { db } = await setup();
  await syncMembers(db, [{ name: 'Mom', role: 'member', telegramId: null }]);
  assert.equal(await findMemberByTelegramId(db, 111), undefined);

  await syncMembers(db, [
    { name: 'Mom', role: 'member', telegramId: 1 },
    { name: 'Dad', role: 'member', telegramId: 2 },
  ]);
  await syncMembers(db, [
    { name: 'Mom', role: 'member', telegramId: 2 },
    { name: 'Dad', role: 'member', telegramId: 1 },
  ]);
  assert.equal((await findMemberByTelegramId(db, 2))?.name, 'Mom');
  assert.equal((await findMemberByTelegramId(db, 1))?.name, 'Dad');
});

test('an existing database gets the new early_ping_at column', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'fa-')), 'old.db');
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE items (id INTEGER PRIMARY KEY, owner_id INTEGER NOT NULL, created_by_id INTEGER NOT NULL,
    title TEXT NOT NULL, due_at INTEGER NOT NULL, important INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'open',
    ping_count INTEGER NOT NULL DEFAULT 0, last_pinged_at INTEGER, created_at INTEGER NOT NULL, done_at INTEGER)`);
  old.close();
  const db = await openDb(pathToFileURL(path).href);
  const columns = (await rows(db, 'PRAGMA table_info(items)')).map((c) => String(c.name));
  assert.ok(columns.includes('early_ping_at'));
});

test('deleting a note also deletes its lines', async () => {
  const { db, mom } = await setup();
  const noteId = await createNote(db, mom.id, 'shopping', true, NOW);
  await addNoteItem(db, noteId, 'rice', NOW);
  await deleteNote(db, noteId);
  assert.deepEqual(await rows(db, 'SELECT * FROM note_items'), []);
});

test('a locked-out member (no Telegram ID) is never pinged', async () => {
  const { db, mom, dueIds } = await setup();
  const add = (dueAt: number, earlyPingAt: number | null) =>
    createItem(db, { ownerId: mom.id, createdById: mom.id, title: 'rice', dueAt, important: true, earlyPingAt });
  await add(NOW - 1, null); // due now
  await add(NOW + 60_000, NOW - 1); // heads-up due now
  await markPinged(db, await add(NOW - REPEAT, null), NOW - REPEAT); // used up its single ping
  const counts = async () => [(await dueIds()).length, (await findEarlyDue(db, NOW)).length, (await findUnanswered(db, NOW, REPEAT, 1)).length];
  assert.deepEqual(await counts(), [2, 1, 1]);
  await syncMembers(db, [{ name: 'Mom', role: 'member', telegramId: null }]);
  assert.deepEqual(await counts(), [0, 0, 0]);
});
