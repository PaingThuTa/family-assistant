import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { verifyInitData } from './auth.ts';
import {
  createItem,
  deleteItem,
  findItem,
  findMember,
  findMemberByTelegramId,
  listActiveMembers,
  listItems,
  markDone,
  reopen,
  updateItem,
  type Item,
  type Member,
} from './db.ts';
import { earlyPingFor } from './scheduler.ts';
import { S } from './strings.ts';
import { formatDay, formatTime, parseYangonDateTime, yangonDateString, yangonParts, yangonTime } from './time.ts';

const MAX_BODY_BYTES = 10_000;
const MAX_TITLE = 200;
// [first day, day after last] as offsets from today.
const RANGES = { today: [0, 1], tomorrow: [1, 2], week: [0, 7] } as const;
const MAX_SPAN_MS = 62 * 24 * 60 * 60_000; // the calendar asks for one month at a time

const STATIC: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/dom.js': { file: 'dom.js', type: 'text/javascript; charset=utf-8' },
  '/calendar.js': { file: 'calendar.js', type: 'text/javascript; charset=utf-8' },
  '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' https://telegram.org; style-src 'self'",
};

interface ApiResponse<T> {
  success: boolean;
  data: T | null;
  error: string | null;
}

interface ItemFields {
  title: string;
  date: string;
  time: string;
  important: boolean;
}

type NewItemInput = ItemFields & { ownerId: number };

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const canEdit = (me: Member, ownerId: number) => me.role === 'admin' || me.id === ownerId;

const publicMember = (m: Member) => ({ id: m.id, name: m.name, role: m.role });

const publicItem = (item: Item, me: Member, now: number) => ({
  id: item.id,
  ownerId: item.ownerId,
  title: item.title,
  important: item.important,
  done: item.status === 'done',
  late: item.status === 'open' && item.dueAt <= now,
  fromEarlierDay: item.dueAt < yangonTime(0, 0, 0, now),
  day: formatDay(item.dueAt, now),
  time: formatTime(item.dueAt),
  // Raw "YYYY-MM-DD" and "HH:MM", for the calendar and the edit form.
  date: yangonParts(item.dueAt).date,
  clock: yangonParts(item.dueAt).time,
  canEdit: canEdit(me, item.ownerId),
});

function sendJson<T>(res: ServerResponse, status: number, body: ApiResponse<T>): void {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, S.web.error);
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, S.web.error);
  }
}

function parseFields(body: unknown): ItemFields {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.title !== 'string' || typeof b.date !== 'string' || typeof b.time !== 'string' || typeof b.important !== 'boolean') {
    throw new HttpError(400, S.web.error);
  }
  const title = b.title.trim();
  if (title.length === 0 || title.length > MAX_TITLE) throw new HttpError(400, S.invalidTitle);
  return { title, date: b.date, time: b.time, important: b.important };
}

function parseNewItem(body: unknown): NewItemInput {
  const ownerId = (body as { ownerId?: unknown } | null)?.ownerId;
  if (typeof ownerId !== 'number') throw new HttpError(400, S.web.error);
  return { ...parseFields(body), ownerId };
}

// A valid, future Yangon time, or a Burmese error.
function futureDueAt(fields: ItemFields, now: number): number {
  const dueAt = parseYangonDateTime(fields.date, fields.time);
  if (dueAt === null) throw new HttpError(400, S.web.badDateTime);
  if (dueAt <= now) throw new HttpError(400, S.timePassed);
  return dueAt;
}

// HTTP server for the Mini App: static files plus a JSON API that only family members can use.
export function createApiServer(db: DatabaseSync, botToken: string, publicDir: string): Server {
  const authenticate = (req: IncomingMessage): Member => {
    const header = req.headers.authorization ?? '';
    const telegramId = header.startsWith('tma ') ? verifyInitData(header.slice(4), botToken) : null;
    const member = telegramId === null ? undefined : findMemberByTelegramId(db, telegramId);
    if (!member) throw new HttpError(401, S.web.unauthorized);
    return member;
  };

  const itemsFor = (ownerId: number, range: keyof typeof RANGES, me: Member, now: number) => {
    const [fromDay, toDay] = RANGES[range];
    const from = yangonTime(fromDay, 0, 0, now);
    const to = yangonTime(toDay, 0, 0, now);
    // Ranges starting today also carry over unfinished items from earlier days.
    return listItems(db, ownerId, from, to, fromDay === 0).map((item) => publicItem(item, me, now));
  };

  // Also returns the first screen's list, so opening the app takes one request instead of two.
  const getMe = (me: Member, now: number) => {
    // Mom and Dad see each other; the admin also sees their own tab.
    const members = listActiveMembers(db).filter((m) => m.role === 'member' || m.id === me.id);
    // Admin starts on Mom's timeline, everyone else on their own.
    const ownerId = me.role === 'admin' ? (members.find((m) => m.role === 'member') ?? me).id : me.id;
    return {
      me: publicMember(me),
      members: members.map(publicMember),
      ownerId,
      items: itemsFor(ownerId, 'today', me, now),
      today: yangonDateString(0, now),
      tomorrow: yangonDateString(1, now),
    };
  };

  // Either ?range=today|tomorrow|week, or ?from=YYYY-MM-DD&to=YYYY-MM-DD (to is exclusive) for the calendar.
  const getItems = (url: URL, me: Member, now: number) => {
    const owner = findMember(db, Number(url.searchParams.get('owner')));
    if (!owner) throw new HttpError(400, S.web.error);
    const range = url.searchParams.get('range');
    if (range !== null) {
      if (!Object.hasOwn(RANGES, range)) throw new HttpError(400, S.web.error);
      return itemsFor(owner.id, range as keyof typeof RANGES, me, now);
    }
    const from = parseYangonDateTime(url.searchParams.get('from') ?? '', '00:00');
    const to = parseYangonDateTime(url.searchParams.get('to') ?? '', '00:00');
    if (from === null || to === null || to <= from || to - from > MAX_SPAN_MS) throw new HttpError(400, S.web.error);
    return listItems(db, owner.id, from, to, false).map((item) => publicItem(item, me, now));
  };

  const editableItem = (itemId: number, me: Member): Item => {
    const item = findItem(db, itemId);
    if (!item) throw new HttpError(404, S.web.notFound);
    if (!canEdit(me, item.ownerId)) throw new HttpError(403, S.notAllowed);
    return item;
  };

  const putItem = async (req: IncomingMessage, itemId: number, me: Member, now: number) => {
    const item = editableItem(itemId, me);
    const fields = parseFields(await readJson(req));
    const dueAt = futureDueAt(fields, now);
    updateItem(db, item.id, { title: fields.title, dueAt, important: fields.important, earlyPingAt: earlyPingFor(dueAt, now) });
    return publicItem(findItem(db, item.id)!, me, now);
  };

  const removeItem = (itemId: number, me: Member) => {
    deleteItem(db, editableItem(itemId, me).id);
    return { id: itemId };
  };

  const postItem = async (req: IncomingMessage, me: Member, now: number) => {
    const input = parseNewItem(await readJson(req));
    const owner = findMember(db, input.ownerId);
    if (!owner) throw new HttpError(404, S.web.notFound);
    if (!canEdit(me, owner.id)) throw new HttpError(403, S.notAllowed);
    const dueAt = futureDueAt(input, now);
    const id = createItem(
      db,
      { ownerId: owner.id, createdById: me.id, title: input.title, dueAt, important: input.important, earlyPingAt: earlyPingFor(dueAt, now) },
      now,
    );
    return publicItem(findItem(db, id)!, me, now);
  };

  // Done, or reopen to undo an accidental Done. Either way only the owner or admin may.
  const postStatus = (itemId: number, action: 'done' | 'reopen', me: Member, now: number) => {
    const item = editableItem(itemId, me);
    if (action === 'done') markDone(db, item.id, now);
    else reopen(db, item.id);
    return publicItem(findItem(db, item.id)!, me, now);
  };

  const route = async (req: IncomingMessage, url: URL, me: Member): Promise<unknown> => {
    const now = Date.now();
    if (req.method === 'GET' && url.pathname === '/api/me') return getMe(me, now);
    if (req.method === 'GET' && url.pathname === '/api/items') return getItems(url, me, now);
    if (req.method === 'POST' && url.pathname === '/api/items') return postItem(req, me, now);
    const status = /^\/api\/items\/(\d+)\/(done|reopen)$/.exec(url.pathname);
    if (req.method === 'POST' && status) return postStatus(Number(status[1]), status[2] as 'done' | 'reopen', me, now);
    const single = /^\/api\/items\/(\d+)$/.exec(url.pathname);
    if (req.method === 'PUT' && single) return putItem(req, Number(single[1]), me, now);
    if (req.method === 'DELETE' && single) return removeItem(Number(single[1]), me);
    throw new HttpError(404, S.web.notFound);
  };

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      const asset = req.method === 'GET' ? STATIC[url.pathname] : undefined;
      if (asset) {
        const body = await readFile(join(publicDir, asset.file));
        res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': asset.type, 'Cache-Control': 'no-cache' });
        res.end(body);
        return;
      }
      if (!url.pathname.startsWith('/api/')) throw new HttpError(404, S.web.notFound);
      const me = authenticate(req);
      sendJson(res, 200, { success: true, data: await route(req, url, me), error: null });
    } catch (err: unknown) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error('API error', err);
      // Every message here is Burmese, because the app shows it to Mom as is.
      const message = err instanceof HttpError ? err.message : S.web.error;
      sendJson(res, status, { success: false, data: null, error: message });
    }
  });
}
