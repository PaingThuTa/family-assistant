import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, test } from 'node:test';
import { createApiServer } from './api.ts';
import { openDb, syncMembers } from './db.ts';
import { sign, TEST_TOKEN } from './test-helpers.ts';

const ADMIN = 3;
const MOM = 1;
const DAD = 2;

const db = await openDb(':memory:');
await syncMembers(db, [
  { name: 'Admin', role: 'admin', telegramId: ADMIN },
  { name: 'Mom', role: 'member', telegramId: MOM },
  { name: 'Dad', role: 'member', telegramId: DAD },
]);
const server = createApiServer(db, TEST_TOKEN, '/nonexistent');
await new Promise<void>((done) => server.listen(0, done));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;
after(() => server.close());

interface NoteView {
  id: number;
  title: string;
  shared: boolean;
  canDelete: boolean;
  items: { id: number; text: string; checked: boolean }[];
}

async function req(method: string, path: string, as: number, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { Authorization: `tma ${sign(as)}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json()) as { data: NoteView[] | null; error: string | null };
  return { status: res.status, notes: json.data ?? [], error: json.error };
}

const byTitle = (notes: NoteView[], title: string) => notes.find((n) => n.title === title)!;

test('a shared note is visible and editable by everyone; ticked lines go last', async () => {
  const { notes } = await req('POST', '/api/notes', MOM, { title: 'ဈေးဝယ်', shared: true });
  const market = byTitle(notes, 'ဈေးဝယ်');
  await req('POST', `/api/notes/${market.id}/items`, DAD, { text: 'ကြက်ဥ' });
  const { notes: afterAdd } = await req('POST', `/api/notes/${market.id}/items`, MOM, { text: 'ဆီ' });
  const [eggs] = byTitle(afterAdd, 'ဈေးဝယ်').items;
  const { notes: afterTick } = await req('POST', `/api/note-items/${eggs!.id}/toggle`, DAD);
  assert.deepEqual(byTitle(afterTick, 'ဈေးဝယ်').items.map((i) => [i.text, i.checked]), [['ဆီ', false], ['ကြက်ဥ', true]]);
});

test('a private note is hidden from everyone else, even the admin', async () => {
  const { notes } = await req('POST', '/api/notes', MOM, { title: 'secret', shared: false });
  const secret = byTitle(notes, 'secret');
  assert.equal(byTitle((await req('GET', '/api/notes', DAD)).notes, 'secret'), undefined);
  assert.equal(byTitle((await req('GET', '/api/notes', ADMIN)).notes, 'secret'), undefined);
  assert.equal((await req('POST', `/api/notes/${secret.id}/items`, ADMIN, { text: 'x' })).status, 404);
  assert.equal((await req('DELETE', `/api/notes/${secret.id}`, ADMIN)).status, 404);
  assert.ok(byTitle((await req('GET', '/api/notes', MOM)).notes, 'secret'));
});

test('only the creator, or the admin for shared notes, can delete a note', async () => {
  const { notes } = await req('POST', '/api/notes', MOM, { title: 'to delete', shared: true });
  const note = byTitle(notes, 'to delete');
  assert.equal(byTitle((await req('GET', '/api/notes', DAD)).notes, 'to delete').canDelete, false);
  assert.equal((await req('DELETE', `/api/notes/${note.id}`, DAD)).status, 403);
  assert.equal((await req('DELETE', `/api/notes/${note.id}`, ADMIN)).status, 200);
  assert.equal(byTitle((await req('GET', '/api/notes', MOM)).notes, 'to delete'), undefined);
});

test('lines can be deleted, and bad input gets a Burmese error', async () => {
  const { notes } = await req('POST', '/api/notes', DAD, { title: 'list', shared: true });
  const list = byTitle(notes, 'list');
  const { notes: withLine } = await req('POST', `/api/notes/${list.id}/items`, DAD, { text: 'a' });
  const line = byTitle(withLine, 'list').items[0]!;
  assert.equal(byTitle((await req('DELETE', `/api/note-items/${line.id}`, MOM)).notes, 'list').items.length, 0);
  const bad = await req('POST', '/api/notes', DAD, { title: '   ', shared: true });
  assert.equal(bad.status, 400);
  assert.match(bad.error ?? '', /^[က-႟\s0-9။]+$/);
  assert.equal((await req('POST', '/api/notes', DAD, { title: 'x' })).status, 400);
});
