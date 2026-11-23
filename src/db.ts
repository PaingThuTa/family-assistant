import { createClient, type Client, type InValue } from '@libsql/client';

// Local file in dev and tests, Turso in production. Same SQL either way.
export type Db = Client;

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
  repeatDays: number | null; // 1 = daily, 7 = weekly; only the latest occurrence carries it
};
export type DueItem = Item & { ownerTelegramId: number; ownerName: string };
export type ItemChanges = Pick<Item, 'title' | 'dueAt' | 'important' | 'earlyPingAt' | 'repeatDays'>;
export type NewItem = Pick<Item, 'ownerId' | 'createdById' | 'title' | 'dueAt' | 'important'> &
  Partial<Pick<Item, 'earlyPingAt' | 'repeatDays'>>;

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
  repeat_days INTEGER,
  created_at INTEGER NOT NULL,
  done_at INTEGER
);
CREATE INDEX IF NOT EXISTS items_status_due ON items(status, due_at);
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES members(id),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 100),
  shared INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS note_items (
  id INTEGER PRIMARY KEY,
  note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 200),
  checked INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS note_items_note ON note_items(note_id);
`;

type Row = Record<string, unknown>;

export const rows = async (db: Db, sql: string, ...args: InValue[]): Promise<Row[]> =>
  (await db.execute({ sql, args })).rows as unknown as Row[];
export const first = async (db: Db, sql: string, ...args: InValue[]): Promise<Row | undefined> =>
  (await rows(db, sql, ...args))[0];
export const run = (db: Db, sql: string, ...args: InValue[]) => db.execute({ sql, args });

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
  repeatDays: r.repeat_days == null ? null : Number(r.repeat_days),
});

// ponytail: add-column-if-missing is enough for now; use a migrations table once there are several.
const ADDED_COLUMNS = ['early_ping_at', 'alerted_at', 'repeat_days'];

async function migrate(db: Db): Promise<void> {
  const columns = (await rows(db, 'PRAGMA table_info(items)')).map((c) => String(c.name));
  for (const column of ADDED_COLUMNS) {
    if (!columns.includes(column)) await db.execute(`ALTER TABLE items ADD COLUMN ${column} INTEGER`);
  }
}

// Only owners who can be messaged: a locked-out member (no Telegram ID) would be "pinged" at chat 0.
const DUE_SELECT = `SELECT i.*, m.telegram_id AS owner_telegram_id, m.name AS owner_name
  FROM items i JOIN members m ON m.id = i.owner_id AND m.telegram_id IS NOT NULL`;

const toDueItem = (r: Row): DueItem => ({
  ...toItem(r),
  ownerTelegramId: Number(r.owner_telegram_id),
  ownerName: String(r.owner_name),
});

// Connecting does no I/O. Tables are set up separately (setupDb), so a request never waits on it.
export const connectDb = (url: string, authToken?: string): Db => createClient({ url, authToken });

export async function setupDb(db: Db): Promise<void> {
  await db.executeMultiple(SCHEMA);
  await migrate(db);
}

export async function openDb(url: string, authToken?: string): Promise<Db> {
  const db = connectDb(url, authToken);
  await setupDb(db);
  return db;
}

// Members are keyed by name, so changing someone's Telegram ID moves their items with them
// and the old ID loses access. A member with no ID configured is locked out.
export async function syncMembers(db: Db, members: MemberConfig[]): Promise<void> {
  // One batch is one transaction: all or nothing.
  await db.batch(
    [
      'UPDATE members SET telegram_id = NULL', // lets two people swap IDs without a UNIQUE clash
      ...members.map((m) => ({
        sql: `INSERT INTO members (name, role, telegram_id) VALUES (?, ?, ?)
              ON CONFLICT(name) DO UPDATE SET role = excluded.role, telegram_id = excluded.telegram_id`,
        args: [m.name, m.role, m.telegramId],
      })),
    ],
    'write',
  );
}

export async function findMemberByTelegramId(db: Db, telegramId: number): Promise<Member | undefined> {
  const row = await first(db, 'SELECT * FROM members WHERE telegram_id = ?', telegramId);
  return row ? toMember(row) : undefined;
}

export async function findMember(db: Db, id: number): Promise<Member | undefined> {
  const row = await first(db, 'SELECT * FROM members WHERE id = ?', id);
  return row ? toMember(row) : undefined;
}

// Members who can currently use the bot.
export async function listActiveMembers(db: Db): Promise<Member[]> {
  return (await rows(db, 'SELECT * FROM members WHERE telegram_id IS NOT NULL ORDER BY id')).map(toMember);
}

export async function createItem(db: Db, item: NewItem, now = Date.now()): Promise<number> {
  const result = await run(
    db,
    `INSERT INTO items (owner_id, created_by_id, title, due_at, important, early_ping_at, repeat_days, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    item.ownerId, item.createdById, item.title, item.dueAt, item.important ? 1 : 0, item.earlyPingAt ?? null, item.repeatDays ?? null, now,
  );
  return Number(result.lastInsertRowid);
}

// For "What's next?": a few unfinished late items (oldest first) and the next upcoming one.
// Two queries, so many late items can never hide the next one.
export async function findWhatsNext(db: Db, ownerId: number, now: number, lateLimit: number): Promise<{ late: Item[]; next: Item | undefined }> {
  const [late, next] = await Promise.all([
    rows(db, `SELECT * FROM items WHERE owner_id = ? AND status = 'open' AND due_at <= ? ORDER BY due_at LIMIT ?`, ownerId, now, lateLimit),
    first(db, `SELECT * FROM items WHERE owner_id = ? AND status = 'open' AND due_at > ? ORDER BY due_at LIMIT 1`, ownerId, now),
  ]);
  return { late: late.map(toItem), next: next ? toItem(next) : undefined };
}

export async function findItem(db: Db, id: number): Promise<Item | undefined> {
  const row = await first(db, 'SELECT * FROM items WHERE id = ?', id);
  return row ? toItem(row) : undefined;
}

// Items due in [from, to). With carryOver, unfinished items from before `from` are included too.
export async function listItems(db: Db, ownerId: number, from: number, to: number, carryOver: boolean): Promise<Item[]> {
  return (
    await rows(
      db,
      `SELECT * FROM items
       WHERE owner_id = ?
         AND ((due_at >= ? AND due_at < ?) OR (? = 1 AND status = 'open' AND due_at < ?))
       ORDER BY due_at`,
      ownerId, from, to, carryOver ? 1 : 0, from,
    )
  ).map(toItem);
}

// Due items that need a ping: never pinged yet, or important and due for a repeat.
export async function findDueForPing(db: Db, now: number, repeatMs: number, maxPings: number): Promise<DueItem[]> {
  return (
    await rows(
      db,
      `${DUE_SELECT}
       WHERE i.status = 'open' AND i.due_at <= ?
         AND (i.ping_count = 0
              OR (i.important = 1 AND i.ping_count < ? AND i.last_pinged_at <= ?))
       ORDER BY i.due_at`,
      now, maxPings, now - repeatMs,
    )
  ).map(toDueItem);
}

// Once the on-time ping goes out, a heads-up that never got sent is pointless, so clear it too.
export async function markPinged(db: Db, id: number, now: number): Promise<void> {
  await run(db, 'UPDATE items SET ping_count = ping_count + 1, last_pinged_at = ?, early_ping_at = NULL WHERE id = ?', now, id);
}

// Open items whose heads-up time has come but whose due time has not.
export async function findEarlyDue(db: Db, now: number): Promise<DueItem[]> {
  return (
    await rows(
      db,
      `${DUE_SELECT}
       WHERE i.status = 'open' AND i.early_ping_at <= ? AND i.due_at > ?
       ORDER BY i.due_at`,
      now, now,
    )
  ).map(toDueItem);
}

// Important items of Mom or Dad that used up every ping without a Done, and the admin was not told yet.
export async function findUnanswered(db: Db, now: number, repeatMs: number, maxPings: number): Promise<DueItem[]> {
  return (
    await rows(
      db,
      `${DUE_SELECT}
       WHERE i.status = 'open' AND i.important = 1 AND i.ping_count >= ? AND i.last_pinged_at <= ?
         AND i.alerted_at IS NULL AND m.role != 'admin'
       ORDER BY i.due_at`,
      maxPings, now - repeatMs,
    )
  ).map(toDueItem);
}

export async function markAlerted(db: Db, id: number, now: number): Promise<void> {
  await run(db, 'UPDATE items SET alerted_at = ? WHERE id = ?', now, id);
}

// Editing starts the reminders over for the new time.
export async function updateItem(db: Db, id: number, changes: ItemChanges): Promise<void> {
  await run(
    db,
    `UPDATE items SET title = ?, due_at = ?, important = ?, early_ping_at = ?, repeat_days = ?,
       ping_count = 0, last_pinged_at = NULL, alerted_at = NULL
     WHERE id = ?`,
    changes.title, changes.dueAt, changes.important ? 1 : 0, changes.earlyPingAt, changes.repeatDays, id,
  );
}

export async function deleteItem(db: Db, id: number): Promise<void> {
  await run(db, 'DELETE FROM items WHERE id = ?', id);
}

export async function markEarlySent(db: Db, id: number): Promise<void> {
  await run(db, 'UPDATE items SET early_ping_at = NULL WHERE id = ?', id);
}

export async function reopen(db: Db, id: number): Promise<void> {
  await run(db, `UPDATE items SET status = 'open', done_at = NULL WHERE id = ?`, id);
}

export async function markDone(db: Db, id: number, now = Date.now()): Promise<void> {
  await run(db, `UPDATE items SET status = 'done', done_at = ? WHERE id = ? AND status = 'open'`, now, id);
}

// Repeating items whose time has come; each one hands its repeat on to a new occurrence.
export async function findRepeatsDue(db: Db, now: number): Promise<Item[]> {
  return (await rows(db, 'SELECT * FROM items WHERE repeat_days IS NOT NULL AND due_at <= ? ORDER BY due_at', now)).map(toItem);
}

// One transaction: copy the item to its next time and move the repeat onto the copy. The copy only happens
// while the old one still carries the repeat, so a second run cannot make a duplicate.
export async function createNextOccurrence(db: Db, id: number, dueAt: number, earlyPingAt: number | null, now: number): Promise<void> {
  await db.batch(
    [
      {
        sql: `INSERT INTO items (owner_id, created_by_id, title, due_at, important, early_ping_at, repeat_days, created_at)
              SELECT owner_id, created_by_id, title, ?, important, ?, repeat_days, ? FROM items WHERE id = ? AND repeat_days IS NOT NULL`,
        args: [dueAt, earlyPingAt, now, id],
      },
      { sql: 'UPDATE items SET repeat_days = NULL WHERE id = ?', args: [id] },
    ],
    'write',
  );
}
