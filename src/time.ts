import { S } from './strings.ts';

// ponytail: Myanmar has no DST, so a fixed +6:30 offset is exact.
const OFFSET_MS = 6.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// A Date whose UTC fields read as Yangon wall-clock time.
const wall = (ms: number) => new Date(ms + OFFSET_MS);
const dayIndex = (ms: number) => Math.floor((ms + OFFSET_MS) / DAY_MS);
const pad = (n: number) => String(n).padStart(2, '0');

export function yangonTime(dayOffset: number, hour: number, minute: number, now = Date.now()): number {
  const w = wall(now);
  return Date.UTC(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate() + dayOffset, hour, minute) - OFFSET_MS;
}

export const yangonHour = (now = Date.now()) => wall(now).getUTCHours();

function period(hour: number): string {
  if (hour < 12) return S.periods.morning;
  if (hour < 16) return S.periods.noon;
  if (hour < 19) return S.periods.evening;
  return S.periods.night;
}

export const formatHour = (hour: number) => `${period(hour)} ${hour % 12 || 12}`;

export function formatTime(ms: number): string {
  const w = wall(ms);
  return `${formatHour(w.getUTCHours())}:${pad(w.getUTCMinutes())}`;
}

export function formatDay(ms: number, now = Date.now()): string {
  const days = dayIndex(ms) - dayIndex(now);
  if (days === 0) return S.today;
  if (days === 1) return S.tomorrow;
  const w = wall(ms);
  return `${S.weekdays[w.getUTCDay()]} ${w.getUTCDate()}/${w.getUTCMonth() + 1}`;
}

export const formatWhen = (ms: number, now = Date.now()) => `${formatDay(ms, now)} ${formatTime(ms)}`;

// Yangon date "YYYY-MM-DD" and time "HH:MM", the formats of <input type="date"> and <input type="time">.
export function yangonParts(ms: number): { date: string; time: string } {
  const w = wall(ms);
  return {
    date: `${w.getUTCFullYear()}-${pad(w.getUTCMonth() + 1)}-${pad(w.getUTCDate())}`,
    time: `${pad(w.getUTCHours())}:${pad(w.getUTCMinutes())}`,
  };
}

export const yangonDateString = (dayOffset: number, now = Date.now()): string =>
  yangonParts(yangonTime(dayOffset, 0, 0, now)).date;

// Parses "YYYY-MM-DD" + "HH:MM" as Yangon time. Returns null for anything invalid (e.g. 2026-02-30).
export function parseYangonDateTime(date: string, time: string): number | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^(\d{2}):(\d{2})$/.exec(time);
  if (!d || !t) return null;
  const [y, mo, day, h, mi] = [d[1], d[2], d[3], t[1], t[2]].map(Number);
  if (h > 23 || mi > 59) return null;
  const utc = Date.UTC(y, mo - 1, day, h, mi);
  const check = new Date(utc);
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== day) return null;
  return utc - OFFSET_MS;
}
