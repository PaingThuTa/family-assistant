import assert from 'node:assert/strict';
import { test } from 'node:test';
import { airWord, cachedReport, formatReport, parseReport, sky, uvWord } from './weather-report.ts';
import type { FetchFn } from './weather.ts';

const DAYS = ['2026-11-21', '2026-11-22', '2026-11-23', '2026-11-24']; // Sat..Tue

// Hourly rain: morning / afternoon / night chances for today.
function forecastBody({ rain = 10, uv = 6, max = 28, feels = 25.2, parts = [5, 5, 5], nowHour = 2 } = {}) {
  const time = Array.from({ length: 24 }, (_, h) => `${DAYS[0]}T${String(h).padStart(2, '0')}:00`);
  const probs = time.map((_, h) => (h < 12 ? parts[0]! : h < 18 ? parts[1]! : parts[2]!));
  return {
    current: { time: `${DAYS[0]}T${String(nowHour).padStart(2, '0')}:00`, temperature_2m: 22.4, apparent_temperature: feels, weather_code: 2 },
    hourly: { time, precipitation_probability: probs },
    daily: {
      time: DAYS,
      weather_code: [2, 3, 3, 53],
      temperature_2m_max: [max, 28, 30, 30],
      precipitation_probability_max: [rain, 25, 10, 70],
      uv_index_clear_sky_max: [uv, 6, 6, 5],
    },
  };
}

const report = (opts = {}, pm = 14) => formatReport(parseReport(forecastBody(opts), { current: { pm2_5: pm } }));

test('a normal day: date title, plain words, laundry OK, no extra warnings', () => {
  const lines = report().split('\n');
  assert.equal(lines[0], 'ဒီနေ့ (စနေ၊ နိုဝင်ဘာ 21)');
  assert.match(lines[1]!, /တိမ်အနည်းငယ်၊ မိုးမရွာနိုင်ဘူး$/);
  assert.equal(lines[2], 'အခု 22° (ခံစားရ 25°)၊ နေ့လယ် 28° အထိ');
  assert.match(lines[3]!, /UV 6 \(ပြင်း\) \| .* လေထု အသင့်အတင့်$/);
  assert.match(lines[4]!, /အဝတ်လှန်းလို့ ရတယ်။$/);
  assert.doesNotMatch(report(), /mask|ရှောင်ပါ|ရေ များများ|မှာ မိုးရွာနိုင်တယ်/);
});

test('coming days: weekday, sky, high, and an umbrella only on likely-rain days', () => {
  const text = report();
  assert.match(text, /လာမယ့်ရက်\nတနင်္ဂနွေ - .* တိမ်ထူ၊ 28°\nတနင်္လာ - .* တိမ်ထူ၊ 30°\nအင်္ဂါ - .* မိုးဖွဲ၊ 30° \u{2614}$/u);
});

test('rain changes the advice line', () => {
  const maybe = report({ rain: 40 });
  assert.match(maybe, /၊ မိုးရွာနိုင်တယ်$/m);
  assert.match(maybe, /ထီး ယူထားပါ/);
  const likely = report({ rain: 80 });
  assert.match(likely, /၊ မိုးရွာမယ်$/m);
  assert.match(likely, /အဝတ် မလှန်းပါနဲ့/);
});

test('heat, strong sun and bad air add one line each, only when they matter', () => {
  const text = report({ max: 39, uv: 9 }, 60);
  assert.match(text, /ရေ များများ သောက်ပါ/);
  assert.match(text, /အပြင် ရှောင်ပါ/);
  assert.match(text, /mask/);
  assert.doesNotMatch(formatReport(parseReport(forecastBody(), null)), /mask/); // air quality missing
});

test('rain is split by part of day when possible, skipping parts already over', () => {
  assert.match(report({ rain: 50, parts: [10, 40, 70] }), /နေ့လယ်၊ ည မှာ မိုးရွာနိုင်တယ်/);
  assert.match(report({ rain: 50, parts: [60, 10, 10], nowHour: 2 }), /မနက် မှာ မိုးရွာနိုင်တယ်/);
  assert.doesNotMatch(report({ rain: 50, parts: [60, 10, 10], nowHour: 13 }), /မှာ မိုးရွာနိုင်တယ်/); // morning is over
});

test('the UV and air line is always there; air is left out if that service failed', () => {
  assert.match(formatReport(parseReport(forecastBody(), null)), /UV 6 \(ပြင်း\)$/m);
  assert.equal(uvWord(11), 'အန္တရာယ်ရှိ');
  assert.equal(airWord(10), 'ကောင်း');
  assert.equal(airWord(80), 'မကောင်း');
});

test('feels-like is shown only when it differs by 3 degrees or more', () => {
  assert.doesNotMatch(report({ feels: 23 }), /ခံစားရ/);
});

test('weather codes get an emoji and Burmese words; source has no literal emoji', () => {
  assert.equal(sky(0), '\u{2600}\u{FE0F} နေသာ');
  assert.equal(sky(95), '\u{26C8}\u{FE0F} မိုးကြိုးမုန်တိုင်း');
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
