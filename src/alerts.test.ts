import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  initAlertTables,
  listSubscribers,
  listSubscriptions,
  markSent,
  runQuakePass,
  runWeatherPass,
  toggleSubscription,
  wasSent,
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

// Open-Meteo shaped body: every hour of DAY with the same rain values. It has the fields of both
// requests (rain check and the daily report), so one fake serves both.
function forecastBody(probability: number, mm: number, maxTemp = 33) {
  const time = Array.from({ length: 24 }, (_, h) => `${DAY}T${String(h).padStart(2, '0')}:00`);
  return {
    current: { time: `${DAY}T07:00`, temperature_2m: 25, apparent_temperature: 26, weather_code: 1 },
    hourly: { time, precipitation_probability: time.map(() => probability), precipitation: time.map(() => mm) },
    daily: {
      time: [DAY],
      weather_code: [1],
      temperature_2m_max: [maxTemp],
      precipitation_probability_max: [probability],
      uv_index_clear_sky_max: [6],
    },
  };
}

async function setup(subscribe: AlertKind[]) {
  const db = await openDb(':memory:');
  await initAlertTables(db);
  await syncMembers(db, [
    { name: 'Mom', role: 'member', telegramId: 111 },
    { name: 'Dad', role: 'member', telegramId: 222 },
  ]);
  const mom = (await findMemberByTelegramId(db, 111))!;
  for (const kind of subscribe) await toggleSubscription(db, mom.id, kind);
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
  const { db, api, sent } = await setup(['rain']);
  await runWeatherPass(db, api, HOME, at(DAY, '22:00'), fakeFetch(forecastBody(90, 3)));
  await runWeatherPass(db, api, HOME, at(DAY, '05:00'), fakeFetch(forecastBody(90, 3)));
  assert.equal(sent.length, 0);
});

test('rain is sent at most once per part of the day', async () => {
  const { db, api, sent } = await setup(['rain']);
  const fetchFn = fakeFetch(forecastBody(90, 3));
  await runWeatherPass(db, api, HOME, at(DAY, '10:00'), fetchFn);
  await runWeatherPass(db, api, HOME, at(DAY, '10:15'), fetchFn);
  await runWeatherPass(db, api, HOME, at(DAY, '11:45'), fetchFn);
  assert.equal(sent.length, 1);
  await runWeatherPass(db, api, HOME, at(DAY, '12:00'), fetchFn); // afternoon
  await runWeatherPass(db, api, HOME, at(DAY, '15:00'), fetchFn);
  assert.equal(sent.length, 2);
  await runWeatherPass(db, api, HOME, at(DAY, '18:00'), fetchFn); // evening
  assert.equal(sent.length, 3);
});

test('daily alert is the full weather report, sent once, from 07:00', async () => {
  const { db, api, sent } = await setup(['daily']);
  const fetchFn = fakeFetch(forecastBody(10, 0, 40.6));
  await runWeatherPass(db, api, HOME, at(DAY, '06:45'), fetchFn);
  assert.equal(sent.length, 0);
  await runWeatherPass(db, api, HOME, at(DAY, '07:00'), fetchFn);
  await runWeatherPass(db, api, HOME, at(DAY, '07:15'), fetchFn);
  assert.equal(sent.length, 1);
  assert.match(sent[0]![1], /^ဒီနေ့ \(/); // same report as the Weather button
  assert.match(sent[0]![1], /41° အထိ/);
  assert.match(sent[0]![1], /အရမ်းပူမယ်/);
});

test('daily report has no heat line on a normal day', async () => {
  const { db, api, sent } = await setup(['daily']);
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
    quake({ id: 'slow feed', timeMs: NOW - 2 * 60 * 60_000 }), // USGS can publish late
    quake({ id: 'old', timeMs: NOW - 7 * 60 * 60_000 }),
  ];
  assert.deepEqual(
    nearbyRecentQuakes(quakes, HOME, NOW).map((q) => q.id),
    ['near', 'slow feed'],
  );
});

const usgsBody = (features: unknown[]) => ({ type: 'FeatureCollection', features });
const usgsFeature = (id: string, mag: number, timeMs: number) => ({
  id,
  properties: { mag, place: '20 km N of Bago', time: timeMs },
  geometry: { coordinates: [96.5, 17.3, 10] },
});

test('a quake is reported once per id, only to quake subscribers', async () => {
  const { db, api, sent } = await setup(['quake']);
  const fetchFn = fakeFetch(usgsBody([usgsFeature('us7', 5.5, NOW - 60_000)]));
  await runQuakePass(db, api, HOME, NOW, fetchFn);
  await runQuakePass(db, api, HOME, NOW + 2 * 60_000, fetchFn);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]![0], 111);
  assert.match(sent[0]![1], /5\.5/);
  assert.match(sent[0]![1], /Bago/);
});

test('toggling subscriptions; only subscribers get messages', async () => {
  const { db, api, sent, mom } = await setup([]);
  assert.equal(await toggleSubscription(db, mom.id, 'rain'), true);
  assert.deepEqual(await listSubscriptions(db, mom.id), ['rain']);
  assert.deepEqual(await listSubscribers(db, 'rain'), [111]);
  await runWeatherPass(db, api, HOME, NOW, fakeFetch(forecastBody(90, 3)));
  assert.deepEqual(
    sent.map(([chat]) => chat),
    [111],
  );
  assert.equal(await toggleSubscription(db, mom.id, 'rain'), false);
  assert.deepEqual(await listSubscribers(db, 'rain'), []);
});

test('nothing is fetched when nobody is subscribed', async () => {
  const { db, api, sent } = await setup([]);
  let calls = 0;
  const fetchFn = (async () => {
    calls++;
    return new Response(JSON.stringify(forecastBody(90, 3)));
  }) as unknown as FetchFn;
  await runWeatherPass(db, api, HOME, at(DAY, '08:00'), fetchFn);
  await runQuakePass(db, api, HOME, NOW, fetchFn);
  assert.equal(calls, 0);
  assert.equal(sent.length, 0);
});

test('malformed or failing API responses do not throw or send', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { db, api, sent } = await setup(['rain', 'daily', 'quake']);
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

test('alert records older than 30 days are pruned', async () => {
  const { db, api } = await setup([]);
  await markSent(db, 'quake:ancient', NOW - 31 * 24 * 60 * 60_000);
  await markSent(db, 'quake:recent', NOW - 60_000);
  await runWeatherPass(db, api, HOME, NOW, fakeFetch(forecastBody(0, 0)));
  assert.equal(await wasSent(db, 'quake:ancient'), false);
  assert.equal(await wasSent(db, 'quake:recent'), true);
});
