import { first, rows, run, type Db } from './db.ts';

export interface NoteItem {
  id: number;
  noteId: number;
  text: string;
  checked: boolean;
}

export interface Note {
  id: number;
  ownerId: number;
  title: string;
  shared: boolean; // true = whole family, false = only the owner
  updatedAt: number;
  items: NoteItem[];
}

type Row = Record<string, unknown>;

const toItem = (r: Row): NoteItem => ({
  id: Number(r.id),
  noteId: Number(r.note_id),
  text: String(r.text),
  checked: Number(r.checked) === 1,
});

const toNote = (r: Row, items: NoteItem[]): Note => ({
  id: Number(r.id),
  ownerId: Number(r.owner_id),
  title: String(r.title),
  shared: Number(r.shared) === 1,
  updatedAt: Number(r.updated_at),
  items,
});

async function itemsOf(db: Db, noteId: number): Promise<NoteItem[]> {
  // Unticked lines first, then ticked ones, each in the order they were added.
  return (await rows(db, 'SELECT * FROM note_items WHERE note_id = ? ORDER BY checked, id', noteId)).map(toItem);
}

// Shared notes plus the member's own private ones, most recently changed first.
// ponytail: one items query per note; fine for a family's handful of notes.
export async function listVisibleNotes(db: Db, memberId: number): Promise<Note[]> {
  const notes = await rows(db, 'SELECT * FROM notes WHERE shared = 1 OR owner_id = ? ORDER BY updated_at DESC, id DESC', memberId);
  return Promise.all(notes.map(async (r) => toNote(r, await itemsOf(db, Number(r.id)))));
}

export async function findNote(db: Db, id: number): Promise<Note | undefined> {
  const row = await first(db, 'SELECT * FROM notes WHERE id = ?', id);
  return row ? toNote(row, await itemsOf(db, id)) : undefined;
}

export async function findNoteItem(db: Db, id: number): Promise<NoteItem | undefined> {
  const row = await first(db, 'SELECT * FROM note_items WHERE id = ?', id);
  return row ? toItem(row) : undefined;
}

export async function createNote(db: Db, ownerId: number, title: string, shared: boolean, now: number): Promise<number> {
  const result = await run(
    db,
    'INSERT INTO notes (owner_id, title, shared, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ownerId, title, shared ? 1 : 0, now, now,
  );
  return Number(result.lastInsertRowid);
}

// Lines are deleted explicitly: Turso does not keep PRAGMA foreign_keys between requests, so CASCADE can't be relied on.
export async function deleteNote(db: Db, id: number): Promise<void> {
  await db.batch(
    [
      { sql: 'DELETE FROM note_items WHERE note_id = ?', args: [id] },
      { sql: 'DELETE FROM notes WHERE id = ?', args: [id] },
    ],
    'write',
  );
}

const touch = (db: Db, noteId: number, now: number) => run(db, 'UPDATE notes SET updated_at = ? WHERE id = ?', now, noteId);

export async function addNoteItem(db: Db, noteId: number, text: string, now: number): Promise<void> {
  await run(db, 'INSERT INTO note_items (note_id, text, created_at) VALUES (?, ?, ?)', noteId, text, now);
  await touch(db, noteId, now);
}

export async function toggleNoteItem(db: Db, item: NoteItem, now: number): Promise<void> {
  await run(db, 'UPDATE note_items SET checked = ? WHERE id = ?', item.checked ? 0 : 1, item.id);
  await touch(db, item.noteId, now);
}

export async function deleteNoteItem(db: Db, item: NoteItem, now: number): Promise<void> {
  await run(db, 'DELETE FROM note_items WHERE id = ?', item.id);
  await touch(db, item.noteId, now);
}
