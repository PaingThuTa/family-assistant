import type { DatabaseSync } from 'node:sqlite';

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

function itemsOf(db: DatabaseSync, noteId: number): NoteItem[] {
  // Unticked lines first, then ticked ones, each in the order they were added.
  return db.prepare('SELECT * FROM note_items WHERE note_id = ? ORDER BY checked, id').all(noteId).map(toItem);
}

// Shared notes plus the member's own private ones, most recently changed first.
// ponytail: one items query per note; fine for a family's handful of notes.
export function listVisibleNotes(db: DatabaseSync, memberId: number): Note[] {
  return db
    .prepare('SELECT * FROM notes WHERE shared = 1 OR owner_id = ? ORDER BY updated_at DESC, id DESC')
    .all(memberId)
    .map((r) => toNote(r, itemsOf(db, Number(r.id))));
}

export function findNote(db: DatabaseSync, id: number): Note | undefined {
  const row = db.prepare('SELECT * FROM notes WHERE id = ?').get(id);
  return row ? toNote(row, itemsOf(db, id)) : undefined;
}

export function findNoteItem(db: DatabaseSync, id: number): NoteItem | undefined {
  const row = db.prepare('SELECT * FROM note_items WHERE id = ?').get(id);
  return row ? toItem(row) : undefined;
}

export function createNote(db: DatabaseSync, ownerId: number, title: string, shared: boolean, now: number): number {
  const result = db
    .prepare('INSERT INTO notes (owner_id, title, shared, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(ownerId, title, shared ? 1 : 0, now, now);
  return Number(result.lastInsertRowid);
}

export function deleteNote(db: DatabaseSync, id: number): void {
  db.prepare('DELETE FROM notes WHERE id = ?').run(id); // lines go with it (ON DELETE CASCADE)
}

const touch = (db: DatabaseSync, noteId: number, now: number) =>
  db.prepare('UPDATE notes SET updated_at = ? WHERE id = ?').run(now, noteId);

export function addNoteItem(db: DatabaseSync, noteId: number, text: string, now: number): void {
  db.prepare('INSERT INTO note_items (note_id, text, created_at) VALUES (?, ?, ?)').run(noteId, text, now);
  touch(db, noteId, now);
}

export function toggleNoteItem(db: DatabaseSync, item: NoteItem, now: number): void {
  db.prepare('UPDATE note_items SET checked = ? WHERE id = ?').run(item.checked ? 0 : 1, item.id);
  touch(db, item.noteId, now);
}

export function deleteNoteItem(db: DatabaseSync, item: NoteItem, now: number): void {
  db.prepare('DELETE FROM note_items WHERE id = ?').run(item.id);
  touch(db, item.noteId, now);
}
