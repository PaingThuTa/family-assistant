import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, test } from 'node:test';
import { createApiServer } from './api.ts';
import { verifyInitData } from './auth.ts';
import { createItem, findMemberByTelegramId, openDb, syncMembers } from './db.ts';
import { sign, TEST_TOKEN } from './test-helpers.ts';

const TOKEN = TEST_TOKEN;
const MOM = 1;
const DAD = 2;
const ADMIN = 3;
const BROTHER = 4;

const db = await openDb(':memory:');
await syncMembers(db, [
  { name: 'Admin', role: 'admin', telegramId: ADMIN },
  { name: 'Mom', role: 'member', telegramId: MOM },
  { name: 'Dad', role: 'member', telegramId: DAD },
  { name: 'Brother', role: 'member', telegramId: BROTHER },
]);
const momId = (await findMemberByTelegramId(db, MOM))!.id;
const dadId = (await findMemberByTelegramId(db, DAD))!.id;
const dadItem = await createItem(db, { ownerId: dadId, createdById: dadId, title: 'work', dueAt: Date.now() + 3_600_000, important: false });

const server = createApiServer(db, TOKEN, '/nonexistent');
await new Promise<void>((done) => server.listen(0, done));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;
after(() => server.close());

async function call(path: string, as: number | null, body?: unknown) {
  const res = await fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: as === null ? {} : { Authorization: `tma ${sign(as)}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as { success: boolean; data: any; error: string | null } };
}

test('initData: tampered, wrong token, expired and stranger are all rejected', async () => {
  assert.equal(verifyInitData(sign(MOM), TOKEN), MOM);
  assert.equal(verifyInitData(sign(MOM).replace('%22id%22%3A1', '%22id%22%3A2'), TOKEN), null);
  assert.equal(verifyInitData(sign(MOM, undefined, 'other:token'), TOKEN), null);
  assert.equal(verifyInitData(sign(MOM, Math.floor(Date.now() / 1000) - 2 * 86_400), TOKEN), null);
  assert.equal((await call('/api/me', null)).status, 401);
  assert.equal((await call('/api/me', 999)).status, 401);
});

test('mom sees mom and dad, but not the admin', async () => {
  const { body } = await call('/api/me', MOM);
  assert.deepEqual(body.data.members.map((m: { name: string }) => m.name), ['Mom', 'Dad', 'Brother']);
  assert.equal(body.data.ownerId, momId);
  assert.ok(Array.isArray(body.data.items));
});

test("admin's first screen is Mom's list, in the same request", async () => {
  const { body } = await call('/api/me', ADMIN);
  assert.equal(body.data.ownerId, momId);
});

test("mom can view dad's items but not change them", async () => {
  const view = await call(`/api/items?owner=${dadId}&range=week`, MOM);
  assert.equal(view.body.data[0].title, 'work');
  assert.equal(view.body.data[0].canEdit, false);
  assert.equal((await call(`/api/items/${dadItem}/done`, MOM, {})).status, 403);
  const add = await call('/api/items', MOM, { ownerId: dadId, title: 'x', date: '2099-01-01', time: '09:00', important: false });
  assert.equal(add.status, 403);
});

test("admin can add to mom's timeline, and it shows on tomorrow's tab", async () => {
  const { body: me } = await call('/api/me', ADMIN);
  const add = await call('/api/items', ADMIN, { ownerId: momId, title: 'medicine', date: me.data.tomorrow, time: '09:00', important: true });
  assert.equal(add.status, 200);
  const list = await call(`/api/items?owner=${momId}&range=tomorrow`, MOM);
  assert.deepEqual(list.body.data.map((i: { title: string }) => i.title), ['medicine']);
  assert.equal(list.body.data[0].canEdit, true);
});

test('bad input is rejected', async () => {
  const add = (body: unknown) => call('/api/items', MOM, body);
  assert.equal((await add({ ownerId: momId, title: 'x', date: '2020-01-01', time: '09:00', important: false })).status, 400);
  assert.equal((await add({ ownerId: momId, title: 'x', date: '2099-02-30', time: '09:00', important: false })).status, 400);
  assert.equal((await add({ ownerId: momId, title: '  ', date: '2099-01-01', time: '09:00', important: false })).status, 400);
  assert.equal((await add({ ownerId: momId, title: 'x' })).status, 400);
  assert.equal((await call(`/api/items?owner=${momId}&range=year`, MOM)).status, 400);
});

test('done can be undone by the owner, and errors are always Burmese', async () => {
  const { body: me } = await call('/api/me', MOM);
  const { body: added } = await call('/api/items', MOM, { ownerId: momId, title: 'rice', date: me.data.tomorrow, time: '10:00', important: false });
  const id = added.data.id;
  assert.equal((await call(`/api/items/${id}/done`, MOM, {})).body.data.done, true);
  assert.equal((await call(`/api/items/${id}/reopen`, MOM, {})).body.data.done, false);
  assert.equal((await call(`/api/items/${dadItem}/reopen`, MOM, {})).status, 403);
  const bad = await call('/api/items', MOM, { nope: true });
  assert.match(bad.body.error ?? '', /^[က-႟\s။]+$/);
});

async function send(method: string, path: string, as: number, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { Authorization: `tma ${sign(as)}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as { success: boolean; data: any; error: string | null } };
}

test('owner can edit and delete; others cannot', async () => {
  const { body: me } = await call('/api/me', MOM);
  const { body: added } = await call('/api/items', MOM, { ownerId: momId, title: 'old', date: me.data.tomorrow, time: '08:00', important: false });
  const id = added.data.id;

  const edited = await send('PUT', `/api/items/${id}`, MOM, { title: 'new', date: me.data.tomorrow, time: '09:15', important: true });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.data.title, 'new');
  assert.equal(edited.body.data.clock, '09:15');
  assert.equal(edited.body.data.important, true);

  assert.equal((await send('PUT', `/api/items/${id}`, DAD, { title: 'x', date: me.data.tomorrow, time: '09:00', important: false })).status, 403);
  assert.equal((await send('PUT', `/api/items/${id}`, MOM, { title: 'x', date: '2020-01-01', time: '09:00', important: false })).status, 400);
  assert.equal((await send('DELETE', `/api/items/${id}`, DAD)).status, 403);
  assert.equal((await send('DELETE', `/api/items/${id}`, MOM)).status, 200);
  assert.equal((await send('DELETE', `/api/items/${id}`, MOM)).status, 404);
});

test('calendar month listing returns items in the date range only', async () => {
  const { body: me } = await call('/api/me', MOM);
  await call('/api/items', MOM, { ownerId: momId, title: 'in range', date: '2099-03-15', time: '10:00', important: false });
  await call('/api/items', MOM, { ownerId: momId, title: 'next month', date: '2099-04-01', time: '10:00', important: false });
  const list = await call(`/api/items?owner=${momId}&from=2099-03-01&to=2099-04-01`, MOM);
  assert.deepEqual(list.body.data.map((i: { title: string; date: string }) => [i.title, i.date]), [['in range', '2099-03-15']]);
  assert.equal((await call(`/api/items?owner=${momId}&from=2099-01-01&to=2099-12-01`, MOM)).status, 400);
  assert.equal((await call(`/api/items?owner=${momId}&from=bad&to=2099-04-01`, MOM)).status, 400);
  assert.ok(me.success);
});
