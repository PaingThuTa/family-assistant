import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  initAlertTables,
  listSubscribers,
  listSubscriptions,
  runQuakePass,
  runWeatherPass,
  toggleSubscription,
  type AlertKind,
} from './alerts.ts';
import { findMemberByTelegramId, openDb, syncMembers } from './db.ts';
import type { PingApi } from './scheduler.ts';
import { parseYangonDateTime } from './time.ts';
import { distanceKm, fetchQuakes, nearbyRecentQuakes, rainSoon, type FetchFn, type Quake } from './weather.ts';

const HOME = { lat: 16.84, lon: 96.17 }; // Yangon
const at = (date: string, time: string) => parseYangonDateTime(date, time)!;
const DAY = '2026-05-10';
const NOW = at(DAY, '10:00');

const fakeFetch = (body: unknown): FetchFn => (async () => new Response(JSON.stringify(body))) as unknown as FetchFn;

// Open-Meteo shaped body: every hour of DAY with the same rain values.
function forecastBody(probability: number, mm: number, maxTemp = 33) {
  const time = Array.from({ length: 24 }, (_, h) => `${DAY}T${String(h).padStart(2, '0')}:00`);
  return {
    hourly: { time, precipitation_probability: time.map(() => probability), precipitation: time.map(() => mm) },
    daily: { time: [DAY], temperature_2m_max: [maxTemp], precipitation_probability_max: [probability] },
  };
}

function setup(subscribe: AlertKind[]) {
  const db = openDb(':memory:');
  initAlertTables(db);
  syncMembers(db, [
    { name: 'Mom', role: 'member', telegramId: 111 },
    { name: 'Dad', role: 'member', telegramId: 222 },
  ]);
  const mom = findMemberByTelegramId(db, 111)!;
  for (const kind of subscribe) toggleSubscription(db, mom.id, kind);
  const sent: [number, string][] = [];
  const api = {
    sendMessage: async (chatId: number | string, text: string) => {
      sent.push([Number(chatId), text]);
      return {};
    },
  } as unknown as PingApi;
  return { db, api, sent, mom };
}

const forecastOf = (hours: { at: number; probability: number; precipitation: number }[]) => ({ hours, days: [] });

test('rainSoon needs high chance and real rain in a slot starting within 2 hours', () => {
  const slot = (time: string, probability: number, precipitation: number) => ({
    at: at(DAY, time),
    probability,
    precipitation,
  });
  assert.equal(rainSoon(forecastOf([slot('11:00', 80, 1)]), NOW), true);
  assert.equal(rainSoon(forecastOf([slot('11:00', 50, 2)]), NOW), false);
  assert.equal(rainSoon(forecastOf([slot('11:00', 80, 0.2)]), NOW), false);
  assert.equal(rainSoon(forecastOf([slot('12:00', 90, 5)]), NOW), false); // 2 hours away: outside
  assert.equal(rainSoon(forecastOf([slot('09:00', 90, 5)]), NOW), false); // already past
  assert.equal(rainSoon(forecastOf([slot('10:00', 90, 5)]), at(DAY, '10:20')), true); // the hour in progress
});

test('rain alerts are silent during quiet hours', async () => {
  const { db, api, sent } = setup(['rain']);
  await runWeatherPass(db, api, HOME, at(DAY, '22:00'), fakeFetch(forecastBody(90, 3)));
  await runWeatherPass(db, api, HOME, at(DAY, '05:00'), fakeFetch(forecastBody(90, 3)));
  assert.equal(sent.length, 0);
});

test('rain is sent once per 3-hour block', async () => {
  const { db, api, sent } = setup(['rain']);
  const fetchFn = fakeFetch(forecastBody(90, 3));
  await runWeatherPass(db, api, HOME, at(DAY, '10:00'), fetchFn);
  await runWeatherPass(db, api, HOME, at(DAY, '10:15'), fetchFn);
  await runWeatherPass(db, api, HOME, at(DAY, '11:45'), fetchFn);
  assert.equal(sent.length, 1);
  await runWeatherPass(db, api, HOME, at(DAY, '12:00'), fetchFn); // next block
  assert.equal(sent.length, 2);
});

test('daily summary is sent once, from 07:00, with a heat line when 40 or more', async () => {
  const { db, api, sent } = setup(['daily']);
  const fetchFn = fakeFetch(forecastBody(10, 0, 40.6));
  await runWeatherPass(db, api, HOME, at(DAY, '06:45'), fetchFn);
  assert.equal(sent.length, 0);
  await runWeatherPass(db, api, HOME, at(DAY, '07:00'), fetchFn);
  await runWeatherPass(db, api, HOME, at(DAY, '07:15'), fetchFn);
  assert.equal(sent.length, 1);
  assert.match(sent[0]![1], /41°C/);
  assert.match(sent[0]![1], /အရမ်းပူမယ်/);
});

test('daily summary has no heat line on a normal day', async () => {
  const { db, api, sent } = setup(['daily']);
  await runWeatherPass(db, api, HOME, at(DAY, '08:00'), fakeFetch(forecastBody(10, 0, 35)));
  assert.equal(sent.length, 1);
  assert.doesNotMatch(sent[0]![1], /အရမ်းပူမယ်/);
});

test('distanceKm: Mandalay to Yangon is about 570 km', () => {
  const km = distanceKm({ lat: 21.97, lon: 96.08 }, HOME);
  assert.ok(Math.abs(km - 570) <= 10, `got ${km}`);
});

const quake = (over: Partial<Quake>): Quake => ({
  id: 'us1',
  magnitude: 5.2,
  place: 'near Bago',
  timeMs: NOW - 10 * 60_000,
  lat: 17.3,
  lon: 96.5,
  ...over,
});

test('nearbyRecentQuakes filters by distance, magnitude and age', () => {
  const quakes = [
    quake({ id: 'near' }),
    quake({ id: 'far', lat: 35.7, lon: 139.7 }), // Tokyo
    quake({ id: 'small', magnitude: 4.4 }),
    quake({ id: 'old', timeMs: NOW - 2 * 60 * 60_000 }),
  ];
  assert.deepEqual(
    nearbyRecentQuakes(quakes, HOME, NOW).map((q) => q.id),
    ['near'],
  );
});

const usgsBody = (features: unknown[]) => ({ type: 'FeatureCollection', features });
const usgsFeature = (id: string, mag: number, timeMs: number) => ({
  id,
  properties: { mag, place: '20 km N of Bago', time: timeMs },
  geometry: { coordinates: [96.5, 17.3, 10] },
});

test('a quake is reported once per id, only to quake subscribers', async () => {
  const { db, api, sent } = setup(['quake']);
  const fetchFn = fakeFetch(usgsBody([usgsFeature('us7', 5.5, NOW - 60_000)]));
  await runQuakePass(db, api, HOME, NOW, fetchFn);
  await runQuakePass(db, api, HOME, NOW + 2 * 60_000, fetchFn);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]![0], 111);
  assert.match(sent[0]![1], /5\.5/);
  assert.match(sent[0]![1], /Bago/);
});

test('toggling subscriptions; only subscribers get messages', async () => {
  const { db, api, sent, mom } = setup([]);
  assert.equal(toggleSubscription(db, mom.id, 'rain'), true);
  assert.deepEqual(listSubscriptions(db, mom.id), ['rain']);
  assert.deepEqual(listSubscribers(db, 'rain'), [111]);
  await runWeatherPass(db, api, HOME, NOW, fakeFetch(forecastBody(90, 3)));
  assert.deepEqual(
    sent.map(([chat]) => chat),
    [111],
  );
  assert.equal(toggleSubscription(db, mom.id, 'rain'), false);
  assert.deepEqual(listSubscribers(db, 'rain'), []);
});

test('an alert with no subscribers is still marked sent', async () => {
  const { db, api, sent, mom } = setup([]);
  const fetchFn = fakeFetch(forecastBody(90, 3));
  await runWeatherPass(db, api, HOME, NOW, fetchFn);
  toggleSubscription(db, mom.id, 'rain');
  await runWeatherPass(db, api, HOME, NOW + 15 * 60_000, fetchFn);
  assert.equal(sent.length, 0);
});

test('malformed or failing API responses do not throw or send', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { db, api, sent } = setup(['rain', 'daily', 'quake']);
  const bad: FetchFn[] = [
    fakeFetch({}),
    fakeFetch(null),
    fakeFetch({ hourly: { time: 'x' }, daily: {}, features: 'x' }),
    (async () => new Response('not json')) as unknown as FetchFn,
    (async () => new Response('oops', { status: 500 })) as unknown as FetchFn,
    (async () => {
      throw new Error('network down');
    }) as unknown as FetchFn,
  ];
  for (const fetchFn of bad) {
    await runWeatherPass(db, api, HOME, NOW, fetchFn);
    await runQuakePass(db, api, HOME, NOW, fetchFn);
  }
  assert.equal(sent.length, 0);
});

test('fetchQuakes skips malformed features and keeps good ones', async () => {
  const quakes = await fetchQuakes(
    fakeFetch(
      usgsBody([
        usgsFeature('good', 5, NOW),
        { id: 'nogeo', properties: { mag: 5, time: NOW } },
        { id: 'badmag', properties: { mag: 'big', time: NOW }, geometry: { coordinates: [96, 17] } },
        42,
      ]),
    ),
  );
  assert.deepEqual(
    quakes.map((q) => [q.id, q.lat, q.lon]),
    [['good', 17.3, 96.5]],
  );
});
