import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cachedReport, formatReport, parseReport, sky } from './weather-report.ts';
import type { FetchFn } from './weather.ts';

const DAYS = ['2026-11-21', '2026-11-22', '2026-11-23', '2026-11-24']; // Sat..Tue

function forecastBody({ rain = 10, uv = 6, max = 28, feels = 25.2 } = {}) {
  return {
    current: { temperature_2m: 22.4, apparent_temperature: feels, weather_code: 2 },
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
  assert.match(lines[3]!, /အဝတ်လှန်းလို့ ရတယ်။$/);
  assert.doesNotMatch(report(), /mask|ရှောင်ပါ|ရေ များများ|PM2|UV/);
});

test('coming days: weekday, sky, high, and an umbrella only on likely-rain days', () => {
  const text = report();
  assert.match(text, /လာမယ့်ရက်\nတနင်္ဂနွေ - .* တိမ်ထူ၊ 28°\nတနင်္လာ - .* တိမ်ထူ၊ 30°\nအင်္ဂါ - .* မိုးဖွဲ၊ 30° \u{2614}$/u);
});

test('rain changes the advice line', () => {
  assert.match(report({ rain: 40 }), /မိုးရွာနိုင်တယ်\n.*\n.*ထီး ယူထားပါ/);
  assert.match(report({ rain: 80 }), /မိုးရွာမယ်\n.*\n.*အဝတ် မလှန်းပါနဲ့/);
});

test('heat, strong sun and bad air add one line each, only when they matter', () => {
  const text = report({ max: 39, uv: 9 }, 60);
  assert.match(text, /ရေ များများ သောက်ပါ/);
  assert.match(text, /အပြင် ရှောင်ပါ/);
  assert.match(text, /mask/);
  assert.doesNotMatch(formatReport(parseReport(forecastBody(), null)), /mask/); // air quality missing
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
