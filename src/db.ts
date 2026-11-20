import { DatabaseSync } from 'node:sqlite';

export type Role = 'member' | 'admin';
export type Member = { id: number; telegramId: number | null; name: string; role: Role };
export type MemberConfig = { name: string; role: Role; telegramId: number | null };
export type Item = {
  id: number;
  ownerId: number;
  createdById: number;
  title: string;
  dueAt: number;
  important: boolean;
  status: 'open' | 'done';
  pingCount: number;
  lastPingedAt: number | null;
  earlyPingAt: number | null; // when to send the heads-up ping; null = none or already sent
};
export type DueItem = Item & { ownerTelegramId: number; ownerName: string };
export type ItemChanges = Pick<Item, 'title' | 'dueAt' | 'important' | 'earlyPingAt'>;
export type NewItem = Pick<Item, 'ownerId' | 'createdById' | 'title' | 'dueAt' | 'important'> &
  Partial<Pick<Item, 'earlyPingAt'>>;

const SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY,
  telegram_id INTEGER UNIQUE,
  name TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('member', 'admin'))
);
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES members(id),
  created_by_id INTEGER NOT NULL REFERENCES members(id),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  due_at INTEGER NOT NULL,
  important INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
  ping_count INTEGER NOT NULL DEFAULT 0,
  early_ping_at INTEGER,
  alerted_at INTEGER,
  last_pinged_at INTEGER,
  created_at INTEGER NOT NULL,
  done_at INTEGER
);
CREATE INDEX IF NOT EXISTS items_status_due ON items(status, due_at);
`;

type Row = Record<string, unknown>;

const toMember = (r: Row): Member => ({
  id: Number(r.id),
  telegramId: r.telegram_id == null ? null : Number(r.telegram_id),
  name: String(r.name),
  role: r.role as Role,
});

const toItem = (r: Row): Item => ({
  id: Number(r.id),
  ownerId: Number(r.owner_id),
  createdById: Number(r.created_by_id),
  title: String(r.title),
  dueAt: Number(r.due_at),
  important: Number(r.important) === 1,
  status: r.status as Item['status'],
  pingCount: Number(r.ping_count),
  lastPingedAt: r.last_pinged_at == null ? null : Number(r.last_pinged_at),
  earlyPingAt: r.early_ping_at == null ? null : Number(r.early_ping_at),
});

// ponytail: add-column-if-missing is enough for now; use a migrations table once there are several.
const ADDED_COLUMNS = ['early_ping_at', 'alerted_at'];

function migrate(db: DatabaseSync): void {
  const columns = db.prepare('PRAGMA table_info(items)').all().map((c) => String(c.name));
  for (const column of ADDED_COLUMNS) {
    if (!columns.includes(column)) db.exec(`ALTER TABLE items ADD COLUMN ${column} INTEGER`);
  }
}

const DUE_SELECT = `SELECT i.*, m.telegram_id AS owner_telegram_id, m.name AS owner_name
  FROM items i JOIN members m ON m.id = i.owner_id`;

const toDueItem = (r: Row): DueItem => ({
  ...toItem(r),
  ownerTelegramId: Number(r.owner_telegram_id),
  ownerName: String(r.owner_name),
});

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

// Members are keyed by name, so changing someone's Telegram ID moves their items with them
// and the old ID loses access. A member with no ID configured is locked out.
export function syncMembers(db: DatabaseSync, members: MemberConfig[]): void {
  const upsert = db.prepare(
    `INSERT INTO members (name, role, telegram_id) VALUES (?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET role = excluded.role, telegram_id = excluded.telegram_id`,
  );
  db.exec('BEGIN');
  try {
    db.exec('UPDATE members SET telegram_id = NULL'); // lets two people swap IDs without a UNIQUE clash
    for (const m of members) upsert.run(m.name, m.role, m.telegramId);
    db.exec('COMMIT');
  } catch (err: unknown) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function findMemberByTelegramId(db: DatabaseSync, telegramId: number): Member | undefined {
  const row = db.prepare('SELECT * FROM members WHERE telegram_id = ?').get(telegramId);
  return row ? toMember(row) : undefined;
}

export function findMember(db: DatabaseSync, id: number): Member | undefined {
  const row = db.prepare('SELECT * FROM members WHERE id = ?').get(id);
  return row ? toMember(row) : undefined;
}

// Members who can currently use the bot.
export function listActiveMembers(db: DatabaseSync): Member[] {
  return db.prepare('SELECT * FROM members WHERE telegram_id IS NOT NULL ORDER BY id').all().map(toMember);
}

export function createItem(db: DatabaseSync, item: NewItem, now = Date.now()): number {
  const result = db
    .prepare(
      `INSERT INTO items (owner_id, created_by_id, title, due_at, important, early_ping_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(item.ownerId, item.createdById, item.title, item.dueAt, item.important ? 1 : 0, item.earlyPingAt ?? null, now);
  return Number(result.lastInsertRowid);
}

export function findItem(db: DatabaseSync, id: number): Item | undefined {
  const row = db.prepare('SELECT * FROM items WHERE id = ?').get(id);
  return row ? toItem(row) : undefined;
}

// Items due in [from, to). With carryOver, unfinished items from before `from` are included too.
export function listItems(db: DatabaseSync, ownerId: number, from: number, to: number, carryOver: boolean): Item[] {
  return db
    .prepare(
      `SELECT * FROM items
       WHERE owner_id = ?
         AND ((due_at >= ? AND due_at < ?) OR (? = 1 AND status = 'open' AND due_at < ?))
       ORDER BY due_at`,
    )
    .all(ownerId, from, to, carryOver ? 1 : 0, from)
    .map(toItem);
}

// Due items that need a ping: never pinged yet, or important and due for a repeat.
export function findDueForPing(db: DatabaseSync, now: number, repeatMs: number, maxPings: number): DueItem[] {
  return db
    .prepare(
      `${DUE_SELECT}
       WHERE i.status = 'open' AND i.due_at <= ?
         AND (i.ping_count = 0
              OR (i.important = 1 AND i.ping_count < ? AND i.last_pinged_at <= ?))
       ORDER BY i.due_at`,
    )
    .all(now, maxPings, now - repeatMs)
    .map(toDueItem);
}

// Once the on-time ping goes out, a heads-up that never got sent is pointless, so clear it too.
export function markPinged(db: DatabaseSync, id: number, now: number): void {
  db.prepare('UPDATE items SET ping_count = ping_count + 1, last_pinged_at = ?, early_ping_at = NULL WHERE id = ?').run(
    now,
    id,
  );
}

// Open items whose heads-up time has come but whose due time has not.
export function findEarlyDue(db: DatabaseSync, now: number): DueItem[] {
  return db
    .prepare(
      `${DUE_SELECT}
       WHERE i.status = 'open' AND i.early_ping_at <= ? AND i.due_at > ?
       ORDER BY i.due_at`,
    )
    .all(now, now)
    .map(toDueItem);
}

// Important items of Mom or Dad that used up every ping without a Done, and the admin was not told yet.
export function findUnanswered(db: DatabaseSync, now: number, repeatMs: number, maxPings: number): DueItem[] {
  return db
    .prepare(
      `${DUE_SELECT}
       WHERE i.status = 'open' AND i.important = 1 AND i.ping_count >= ? AND i.last_pinged_at <= ?
         AND i.alerted_at IS NULL AND m.role != 'admin'
       ORDER BY i.due_at`,
    )
    .all(maxPings, now - repeatMs)
    .map(toDueItem);
}

export function markAlerted(db: DatabaseSync, id: number, now: number): void {
  db.prepare('UPDATE items SET alerted_at = ? WHERE id = ?').run(now, id);
}

// Editing starts the reminders over for the new time.
export function updateItem(db: DatabaseSync, id: number, changes: ItemChanges): void {
  db.prepare(
    `UPDATE items SET title = ?, due_at = ?, important = ?, early_ping_at = ?,
       ping_count = 0, last_pinged_at = NULL, alerted_at = NULL
     WHERE id = ?`,
  ).run(changes.title, changes.dueAt, changes.important ? 1 : 0, changes.earlyPingAt, id);
}

export function deleteItem(db: DatabaseSync, id: number): void {
  db.prepare('DELETE FROM items WHERE id = ?').run(id);
}

export function markEarlySent(db: DatabaseSync, id: number): void {
  db.prepare('UPDATE items SET early_ping_at = NULL WHERE id = ?').run(id);
}

export function reopen(db: DatabaseSync, id: number): void {
  db.prepare(`UPDATE items SET status = 'open', done_at = NULL WHERE id = ?`).run(id);
}

export function markDone(db: DatabaseSync, id: number, now = Date.now()): void {
  db.prepare(`UPDATE items SET status = 'done', done_at = ? WHERE id = ? AND status = 'open'`).run(now, id);
}
