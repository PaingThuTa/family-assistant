import { verifyInitData } from './auth.ts';
import { HttpError, readJson } from './http.ts';
import { routeNotes } from './notes-api.ts';
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
  type Db,
  type Item,
  type Member,
} from './db.ts';
import { earlyPingFor } from './scheduler.ts';
import { S } from './strings.ts';
import { formatDay, formatTime, parseYangonDateTime, yangonDateString, yangonParts, yangonTime } from './time.ts';

const MAX_TITLE = 200;
// [first day, day after last] as offsets from today.
const RANGES = { today: [0, 1], tomorrow: [1, 2], week: [0, 7] } as const;
const MAX_SPAN_MS = 62 * 24 * 60 * 60_000; // the calendar asks for one month at a time

// Static files in public/ are served by Cloudflare before the Worker runs; their headers are in public/_headers.
// no-store: schedules and notes are private, so WebViews and proxies must not cache them.
const SECURITY_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' };

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

const json = <T>(status: number, body: ApiResponse<T>): Response =>
  new Response(JSON.stringify(body), { status, headers: { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8' } });

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

// JSON API for the Mini App that only family members can use.
export function createApiHandler(db: Db, botToken: string): (req: Request) => Promise<Response> {
  const authenticate = async (req: Request): Promise<Member> => {
    const header = req.headers.get('authorization') ?? '';
    const telegramId = header.startsWith('tma ') ? verifyInitData(header.slice(4), botToken) : null;
    const member = telegramId === null ? undefined : await findMemberByTelegramId(db, telegramId);
    if (!member) throw new HttpError(401, S.web.unauthorized);
    return member;
  };

  const itemsFor = async (ownerId: number, range: keyof typeof RANGES, me: Member, now: number) => {
    const [fromDay, toDay] = RANGES[range];
    const from = yangonTime(fromDay, 0, 0, now);
    const to = yangonTime(toDay, 0, 0, now);
    // Ranges starting today also carry over unfinished items from earlier days.
    return (await listItems(db, ownerId, from, to, fromDay === 0)).map((item) => publicItem(item, me, now));
  };

  // Also returns the first screen's list, so opening the app takes one request instead of two.
  const getMe = async (me: Member, now: number) => {
    // Mom and Dad see each other; the admin also sees their own tab.
    const members = (await listActiveMembers(db)).filter((m) => m.role === 'member' || m.id === me.id);
    // Admin starts on Mom's timeline, everyone else on their own.
    const ownerId = me.role === 'admin' ? (members.find((m) => m.role === 'member') ?? me).id : me.id;
    return {
      me: publicMember(me),
      members: members.map(publicMember),
      ownerId,
      items: await itemsFor(ownerId, 'today', me, now),
      today: yangonDateString(0, now),
      tomorrow: yangonDateString(1, now),
    };
  };

  // Either ?range=today|tomorrow|week, or ?from=YYYY-MM-DD&to=YYYY-MM-DD (to is exclusive) for the calendar.
  const getItems = async (url: URL, me: Member, now: number) => {
    const owner = await findMember(db, Number(url.searchParams.get('owner')));
    if (!owner) throw new HttpError(400, S.web.error);
    const range = url.searchParams.get('range');
    if (range !== null) {
      if (!Object.hasOwn(RANGES, range)) throw new HttpError(400, S.web.error);
      return itemsFor(owner.id, range as keyof typeof RANGES, me, now);
    }
    const from = parseYangonDateTime(url.searchParams.get('from') ?? '', '00:00');
    const to = parseYangonDateTime(url.searchParams.get('to') ?? '', '00:00');
    if (from === null || to === null || to <= from || to - from > MAX_SPAN_MS) throw new HttpError(400, S.web.error);
    return (await listItems(db, owner.id, from, to, false)).map((item) => publicItem(item, me, now));
  };

  const editableItem = async (itemId: number, me: Member): Promise<Item> => {
    const item = await findItem(db, itemId);
    if (!item) throw new HttpError(404, S.web.notFound);
    if (!canEdit(me, item.ownerId)) throw new HttpError(403, S.notAllowed);
    return item;
  };

  const putItem = async (req: Request, itemId: number, me: Member, now: number) => {
    const item = await editableItem(itemId, me);
    const fields = parseFields(await readJson(req));
    const dueAt = futureDueAt(fields, now);
    await updateItem(db, item.id, { title: fields.title, dueAt, important: fields.important, earlyPingAt: earlyPingFor(dueAt, now) });
    return publicItem((await findItem(db, item.id))!, me, now);
  };

  const removeItem = async (itemId: number, me: Member) => {
    await deleteItem(db, (await editableItem(itemId, me)).id);
    return { id: itemId };
  };

  const postItem = async (req: Request, me: Member, now: number) => {
    const input = parseNewItem(await readJson(req));
    const owner = await findMember(db, input.ownerId);
    if (!owner) throw new HttpError(404, S.web.notFound);
    if (!canEdit(me, owner.id)) throw new HttpError(403, S.notAllowed);
    const dueAt = futureDueAt(input, now);
    const id = await createItem(
      db,
      { ownerId: owner.id, createdById: me.id, title: input.title, dueAt, important: input.important, earlyPingAt: earlyPingFor(dueAt, now) },
      now,
    );
    return publicItem((await findItem(db, id))!, me, now);
  };

  // Done, or reopen to undo an accidental Done. Either way only the owner or admin may.
  const postStatus = async (itemId: number, action: 'done' | 'reopen', me: Member, now: number) => {
    const item = await editableItem(itemId, me);
    if (action === 'done') await markDone(db, item.id, now);
    else await reopen(db, item.id);
    return publicItem((await findItem(db, item.id))!, me, now);
  };

  const route = async (req: Request, url: URL, me: Member): Promise<unknown> => {
    const now = Date.now();
    if (req.method === 'GET' && url.pathname === '/api/me') return getMe(me, now);
    if (req.method === 'GET' && url.pathname === '/api/items') return getItems(url, me, now);
    if (req.method === 'POST' && url.pathname === '/api/items') return postItem(req, me, now);
    const status = /^\/api\/items\/(\d+)\/(done|reopen)$/.exec(url.pathname);
    if (req.method === 'POST' && status) return postStatus(Number(status[1]), status[2] as 'done' | 'reopen', me, now);
    const single = /^\/api\/items\/(\d+)$/.exec(url.pathname);
    if (req.method === 'PUT' && single) return putItem(req, Number(single[1]), me, now);
    if (req.method === 'DELETE' && single) return removeItem(Number(single[1]), me);
    const notes = await routeNotes(db, req, url, me, now);
    if (notes !== undefined) return notes;
    throw new HttpError(404, S.web.notFound);
  };

  return async (req) => {
    const url = new URL(req.url);
    try {
      if (!url.pathname.startsWith('/api/')) throw new HttpError(404, S.web.notFound);
      const me = await authenticate(req);
      return json(200, { success: true, data: await route(req, url, me), error: null });
    } catch (err: unknown) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error('API error', err);
      // Every message here is Burmese, because the app shows it to Mom as is.
      const message = err instanceof HttpError ? err.message : S.web.error;
      return json(status, { success: false, data: null, error: message });
    }
  };
}
