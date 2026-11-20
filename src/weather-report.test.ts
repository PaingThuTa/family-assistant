import assert from 'node:assert/strict';
import { test } from 'node:test';
import { airLevel, cachedReport, formatReport, parseReport, skyWord, uvLevel } from './weather-report.ts';
import type { FetchFn } from './weather.ts';

const DAYS = ['2026-11-21', '2026-11-22', '2026-11-23', '2026-11-24']; // Sat..Tue

function forecastBody(uv = 6) {
  const time = Array.from({ length: 24 }, (_, h) => `${DAYS[0]}T${String(h).padStart(2, '0')}:00`);
  // morning 10%, afternoon 40%, night 70%
  const probs = time.map((_, h) => (h < 12 ? 10 : h < 18 ? 40 : 70));
  return {
    current: { temperature_2m: 27.4, apparent_temperature: 29.2, weather_code: 3 },
    hourly: { time, precipitation_probability: probs },
    daily: {
      time: DAYS,
      weather_code: [3, 0, 63, 3],
      temperature_2m_max: [33.2, 34, 30, 32],
      temperature_2m_min: [21, 22, 22, 21],
      precipitation_probability_max: [70, 10, 80, 30],
      uv_index_clear_sky_max: [uv, 9, 5, 7],
    },
  };
}

test('report shows now, today, rain by part of day and the next 3 days', () => {
  const text = formatReport(parseReport(forecastBody(), { current: { pm2_5: 20 } }));
  assert.match(text, /အခု: 27°C \(ခံစားရ 29°C\) - တိမ်ထူ/);
  assert.match(text, /33° \/ 21°/);
  assert.match(text, /မနက် 10% \| နေ့လယ် 40% \| ည 70%/);
  assert.match(text, /PM2\.5: 20 \(အသင့်အတင့်\)/);
  assert.match(text, /တနင်္ဂနွေ: နေသာ, 34°\/22°, မိုး 10%/);
  assert.match(text, /တနင်္လာ: မိုးရွာ, 30°\/22°, မိုး 80%/);
  assert.equal(text.match(/^(စနေ|တနင်္ဂနွေ|တနင်္လာ|အင်္ဂါ):/gm)?.length, 3);
  assert.doesNotMatch(text, /mask|ရှောင်ပါ/); // no advice on a mild day
});

test('strong sun and bad air add advice lines; failed air quality is just left out', () => {
  const text = formatReport(parseReport(forecastBody(11), { current: { pm2_5: 80 } }));
  assert.match(text, /ရှောင်ပါ/);
  assert.match(text, /mask/);
  assert.doesNotMatch(formatReport(parseReport(forecastBody(), null)), /PM2\.5/);
});

test('bands and weather words', () => {
  assert.equal(skyWord(0), 'နေသာ');
  assert.equal(skyWord(95), 'မိုးကြိုးမုန်တိုင်း');
  assert.equal(uvLevel(2), 'နည်း');
  assert.equal(uvLevel(11), 'အန္တရာယ်ရှိ');
  assert.equal(airLevel(10), 'ကောင်း');
  assert.equal(airLevel(200), 'အလွန်မကောင်း');
});

test('malformed data throws (the button then shows a friendly message)', () => {
  assert.throws(() => parseReport({ nope: true }, null));
  assert.throws(() => parseReport({ ...forecastBody(), current: { temperature_2m: 'hot' } }, null));
});

test('the report is cached for 15 minutes', async () => {
  let calls = 0;
  const fetchFn = (async (url: string) => {
    calls++;
    return new Response(JSON.stringify(url.includes('air-quality') ? { current: { pm2_5: 5 } } : forecastBody()));
  }) as unknown as FetchFn;
  const get = cachedReport({ lat: 1, lon: 2 }, fetchFn);
  await get(0);
  await get(14 * 60_000);
  assert.equal(calls, 2); // forecast + air, once
  await get(16 * 60_000);
  assert.equal(calls, 4);
});
