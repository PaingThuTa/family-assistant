import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatTime, formatWhen, parseYangonDateTime, yangonDateString, yangonTime } from './time.ts';

// 20 Nov 2026, 09:30 in Yangon.
const MORNING = Date.UTC(2026, 10, 20, 3, 0);
// 21 Nov 2026, 02:30 in Yangon, but still 20 Nov in UTC.
const AFTER_MIDNIGHT = Date.UTC(2026, 10, 20, 20, 0);

test('yangonTime builds today and tomorrow in Yangon time', () => {
  assert.equal(yangonTime(0, 18, 30, MORNING), Date.UTC(2026, 10, 20, 12, 0));
  assert.equal(yangonTime(1, 7, 0, MORNING), Date.UTC(2026, 10, 21, 0, 30));
});

test('yangonTime uses the Yangon date when UTC is still the day before', () => {
  assert.equal(yangonTime(0, 8, 0, AFTER_MIDNIGHT), Date.UTC(2026, 10, 21, 1, 30));
});

test('formatTime shows 12-hour Burmese time', () => {
  assert.equal(formatTime(Date.UTC(2026, 10, 20, 12, 0)), 'ညနေ 6:30');
  assert.equal(formatTime(Date.UTC(2026, 10, 20, 0, 35)), 'မနက် 7:05');
});

test('formatWhen labels today, tomorrow and later dates', () => {
  assert.equal(formatWhen(yangonTime(0, 18, 30, MORNING), MORNING), 'ဒီနေ့ ညနေ 6:30');
  assert.equal(formatWhen(yangonTime(1, 7, 0, MORNING), MORNING), 'မနက်ဖြန် မနက် 7:00');
  assert.equal(formatWhen(yangonTime(3, 13, 0, MORNING), MORNING), 'တနင်္လာ 23/11 နေ့လယ် 1:00');
});

test('parseYangonDateTime reads Yangon wall time and rejects impossible dates', () => {
  assert.equal(parseYangonDateTime('2026-11-20', '18:30'), Date.UTC(2026, 10, 20, 12, 0));
  assert.equal(parseYangonDateTime('2026-02-30', '09:00'), null);
  assert.equal(parseYangonDateTime('2026-11-20', '24:00'), null);
  assert.equal(parseYangonDateTime('20/11/2026', '09:00'), null);
});

test('yangonDateString uses the Yangon date', () => {
  assert.equal(yangonDateString(0, AFTER_MIDNIGHT), '2026-11-21');
  assert.equal(yangonDateString(1, MORNING), '2026-11-21');
});
