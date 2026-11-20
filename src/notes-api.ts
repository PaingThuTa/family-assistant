import type { IncomingMessage } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import type { Member } from './db.ts';
import { HttpError, readJson } from './http.ts';
import {
  addNoteItem,
  createNote,
  deleteNote,
  deleteNoteItem,
  findNote,
  findNoteItem,
  listVisibleNotes,
  toggleNoteItem,
  type Note,
} from './notes-db.ts';
import { S } from './strings.ts';

const MAX_TITLE = 100;
const MAX_LINE = 200;

// Shared notes: everyone sees and edits them. Private notes: only their creator, not even the admin.
const canSee = (note: Note, me: Member) => note.shared || note.ownerId === me.id;
// Deleting a note: its creator, or the admin for shared notes.
const canDelete = (note: Note, me: Member) => note.ownerId === me.id || (note.shared && me.role === 'admin');

const publicNote = (note: Note, me: Member) => ({
  id: note.id,
  title: note.title,
  shared: note.shared,
  canDelete: canDelete(note, me),
  items: note.items.map(({ id, text, checked }) => ({ id, text, checked })),
});

function cleanText(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length === 0 || text.length > max) throw new HttpError(400, S.notes.badText(max));
  return text;
}

// A note the member may see. Notes they may not see are reported as missing, so private ones stay hidden.
function visibleNote(db: DatabaseSync, id: number, me: Member): Note {
  const note = findNote(db, id);
  if (!note || !canSee(note, me)) throw new HttpError(404, S.web.notFound);
  return note;
}

function visibleItem(db: DatabaseSync, id: number, me: Member) {
  const item = findNoteItem(db, id);
  if (!item) throw new HttpError(404, S.web.notFound);
  visibleNote(db, item.noteId, me);
  return item;
}

// Handles /api/notes and /api/note-items. Returns undefined when the request is not a notes route.
export async function routeNotes(
  db: DatabaseSync,
  req: IncomingMessage,
  url: URL,
  me: Member,
  now: number,
): Promise<unknown> {
  const { pathname } = url;
  const list = () => listVisibleNotes(db, me.id).map((n) => publicNote(n, me));

  if (pathname === '/api/notes' && req.method === 'GET') return list();

  if (pathname === '/api/notes' && req.method === 'POST') {
    const body = (await readJson(req)) as Record<string, unknown> | null;
    if (typeof body?.shared !== 'boolean') throw new HttpError(400, S.web.error);
    createNote(db, me.id, cleanText(body.title, MAX_TITLE), body.shared, now);
    return list();
  }

  const note = /^\/api\/notes\/(\d+)$/.exec(pathname);
  if (note && req.method === 'DELETE') {
    const found = visibleNote(db, Number(note[1]), me);
    if (!canDelete(found, me)) throw new HttpError(403, S.notAllowed);
    deleteNote(db, found.id);
    return list();
  }

  const lines = /^\/api\/notes\/(\d+)\/items$/.exec(pathname);
  if (lines && req.method === 'POST') {
    const found = visibleNote(db, Number(lines[1]), me);
    const body = (await readJson(req)) as Record<string, unknown> | null;
    addNoteItem(db, found.id, cleanText(body?.text, MAX_LINE), now);
    return list();
  }

  const toggle = /^\/api\/note-items\/(\d+)\/toggle$/.exec(pathname);
  if (toggle && req.method === 'POST') {
    toggleNoteItem(db, visibleItem(db, Number(toggle[1]), me), now);
    return list();
  }

  const line = /^\/api\/note-items\/(\d+)$/.exec(pathname);
  if (line && req.method === 'DELETE') {
    deleteNoteItem(db, visibleItem(db, Number(line[1]), me), now);
    return list();
  }

  return undefined;
}
