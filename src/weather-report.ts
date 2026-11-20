// The "ရာသီဥတု" chat button: today's weather, air quality, UV and the next 3 days, as one short message.
import type { Bot } from 'grammy';
import type { Ctx } from './bot.ts';
import { S } from './strings.ts';
import { arr, getJson, isNum, isObj, type FetchFn, type Home } from './weather.ts';

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const AIR_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const CACHE_MS = 15 * 60_000;
const COMING_DAYS = 3;

export interface DayForecast {
  date: string; // YYYY-MM-DD, Yangon
  code: number;
  max: number;
  min: number;
  rain: number; // max chance, %
  uv: number;
}

export interface WeatherReport {
  temp: number;
  feels: number;
  code: number;
  rainParts: { morning: number | null; afternoon: number | null; night: number | null };
  today: DayForecast;
  coming: DayForecast[];
  pm25: number | null; // null if the air quality service failed
}

// Burmese text. Review the wording with Mom.
const W = {
  title: 'ဒီနေ့ ရာသီဥတု',
  now: (temp: number, feels: number, sky: string) => `အခု: ${temp}°C (ခံစားရ ${feels}°C) - ${sky}`,
  range: (max: number, min: number) => `အပူဆုံး/အအေးဆုံး: ${max}° / ${min}°`,
  rain: (m: string, a: string, n: string) => `မိုး: မနက် ${m} | နေ့လယ် ${a} | ည ${n}`,
  uv: (uv: number, level: string) => `UV: ${uv} (${level})`,
  air: (pm: number, level: string) => `လေထု PM2.5: ${pm} (${level})`,
  comingTitle: 'လာမယ့် ၃ ရက်:',
  day: (name: string, sky: string, max: number, min: number, rain: number) => `${name}: ${sky}, ${max}°/${min}°, မိုး ${rain}%`,
  sunAdvice: 'နေ့လယ် ၁၁ နာရီ - ၃ နာရီ နေပူထဲ ရှောင်ပါ။',
  airAdvice: 'အပြင်ထွက်ရင် mask တပ်ပါ။',
  unavailable: 'ရာသီဥတု မရယူနိုင်ပါ။ နောက်မှ ပြန်ကြိုးစားပါ။',
  notSetUp: 'ရာသီဥတု မဖွင့်ရသေးပါ။',
};

// WMO weather codes (used by Open-Meteo) as plain Burmese words.
export function skyWord(code: number): string {
  if (code === 0) return 'နေသာ';
  if (code <= 2) return 'တိမ်အနည်းငယ်';
  if (code === 3) return 'တိမ်ထူ';
  if (code === 45 || code === 48) return 'မြူဆိုင်း';
  if (code >= 51 && code <= 57) return 'မိုးဖွဲ';
  if (code >= 95) return 'မိုးကြိုးမုန်တိုင်း';
  return 'မိုးရွာ';
}

// WHO-style UV bands.
export function uvLevel(uv: number): string {
  if (uv < 3) return 'နည်း';
  if (uv < 6) return 'အသင့်အတင့်';
  if (uv < 8) return 'ပြင်း';
  if (uv < 11) return 'အလွန်ပြင်း';
  return 'အန္တရာယ်ရှိ';
}

// US EPA PM2.5 bands (µg/m³).
export function airLevel(pm: number): string {
  if (pm <= 12) return 'ကောင်း';
  if (pm <= 35.4) return 'အသင့်အတင့်';
  if (pm <= 55.4) return 'နှလုံး/အဆုတ် မကောင်းသူများ သတိ';
  if (pm <= 150.4) return 'မကောင်း';
  return 'အလွန်မကောင်း';
}

const SUN_ADVICE_UV = 8;
const AIR_ADVICE_PM = 35.5;

// Highest rain chance among today's hourly slots in [from, to) local hours.
function partMax(times: unknown[], probs: unknown[], today: string, from: number, to: number): number | null {
  const values = times.flatMap((t, i) => {
    const p = probs[i];
    if (typeof t !== 'string' || !t.startsWith(today) || !isNum(p)) return [];
    const hour = Number(t.slice(11, 13));
    return hour >= from && hour < to ? [p] : [];
  });
  return values.length > 0 ? Math.max(...values) : null;
}

function parseDays(daily: Record<string, unknown>): DayForecast[] {
  const codes = arr(daily.weather_code, 'weather_code');
  const maxes = arr(daily.temperature_2m_max, 'temperature_2m_max');
  const mins = arr(daily.temperature_2m_min, 'temperature_2m_min');
  const rains = arr(daily.precipitation_probability_max, 'precipitation_probability_max');
  const uvs = arr(daily.uv_index_clear_sky_max, 'uv_index_clear_sky_max');
  return arr(daily.time, 'daily.time').flatMap((date, i) => {
    const [code, max, min, rain, uv] = [codes[i], maxes[i], mins[i], rains[i], uvs[i]];
    const ok = typeof date === 'string' && isNum(code) && isNum(max) && isNum(min) && isNum(rain);
    if (!ok) return [];
    return [{ date, code, max: Math.round(max), min: Math.round(min), rain: Math.round(rain), uv: isNum(uv) ? Math.round(uv) : 0 }];
  });
}

// Throws on a wrong overall shape; the caller turns that into a friendly message.
export function parseReport(forecast: unknown, air: unknown): WeatherReport {
  if (!isObj(forecast) || !isObj(forecast.current) || !isObj(forecast.hourly) || !isObj(forecast.daily)) {
    throw new Error('Unexpected forecast shape');
  }
  const { current, hourly, daily } = forecast;
  if (!isNum(current.temperature_2m) || !isNum(current.apparent_temperature) || !isNum(current.weather_code)) {
    throw new Error('Unexpected current weather');
  }
  const [today, ...rest] = parseDays(daily);
  if (!today) throw new Error('No daily forecast');
  const times = arr(hourly.time, 'hourly.time');
  const probs = arr(hourly.precipitation_probability, 'precipitation_probability');
  const pm = isObj(air) && isObj(air.current) ? air.current.pm2_5 : null;
  return {
    temp: Math.round(current.temperature_2m),
    feels: Math.round(current.apparent_temperature),
    code: current.weather_code,
    rainParts: {
      morning: partMax(times, probs, today.date, 6, 12),
      afternoon: partMax(times, probs, today.date, 12, 18),
      night: partMax(times, probs, today.date, 18, 24),
    },
    today,
    coming: rest.slice(0, COMING_DAYS),
    pm25: isNum(pm) ? Math.round(pm) : null,
  };
}

const weekdayOf = (date: string) => S.weekdays[new Date(`${date}T00:00:00Z`).getUTCDay()]!;
const pct = (v: number | null) => (v === null ? '-' : `${v}%`);

export function formatReport(r: WeatherReport): string {
  const advice = [
    ...(r.today.uv >= SUN_ADVICE_UV ? [W.sunAdvice] : []),
    ...(r.pm25 !== null && r.pm25 >= AIR_ADVICE_PM ? [W.airAdvice] : []),
  ];
  return [
    W.title,
    W.now(r.temp, r.feels, skyWord(r.code)),
    W.range(r.today.max, r.today.min),
    W.rain(pct(r.rainParts.morning), pct(r.rainParts.afternoon), pct(r.rainParts.night)),
    W.uv(r.today.uv, uvLevel(r.today.uv)),
    ...(r.pm25 !== null ? [W.air(r.pm25, airLevel(r.pm25))] : []),
    ...advice,
    '',
    W.comingTitle,
    ...r.coming.map((d) => W.day(weekdayOf(d.date), skyWord(d.code), d.max, d.min, d.rain)),
  ].join('\n');
}

export async function fetchReport(home: Home, fetchFn: FetchFn): Promise<WeatherReport> {
  const location = { latitude: String(home.lat), longitude: String(home.lon), timezone: 'Asia/Yangon' };
  const forecastParams = new URLSearchParams({
    ...location,
    current: 'temperature_2m,apparent_temperature,weather_code',
    hourly: 'precipitation_probability',
    // Clear-sky UV: the strongest the sun can get that day. The cloud-adjusted value was seen
    // reporting 1.4 on a day whose clear-sky max was 6, and under-warning is the worse mistake.
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,uv_index_clear_sky_max',
    forecast_days: String(COMING_DAYS + 1),
  });
  const airParams = new URLSearchParams({ ...location, current: 'pm2_5' });
  // Air quality is a nice-to-have: if it fails, show the weather without it.
  const [forecast, air] = await Promise.allSettled([
    getJson(`${FORECAST_URL}?${forecastParams}`, fetchFn),
    getJson(`${AIR_URL}?${airParams}`, fetchFn),
  ]);
  if (forecast.status === 'rejected') throw forecast.reason;
  if (air.status === 'rejected') console.error('Air quality fetch failed', air.reason);
  return parseReport(forecast.value, air.status === 'fulfilled' ? air.value : null);
}

// Caches the report, so a family tapping the button many times costs one request per 15 minutes.
export function cachedReport(home: Home, fetchFn: FetchFn): (now: number) => Promise<WeatherReport> {
  let cache: { at: number; report: WeatherReport } | null = null;
  return async (now) => {
    if (cache && now - cache.at < CACHE_MS) return cache.report;
    const report = await fetchReport(home, fetchFn);
    cache = { at: now, report };
    return report;
  };
}

// Call between createBot() and finishBot().
export function registerWeatherButton(bot: Bot<Ctx>, home: Home | null, fetchFn: FetchFn = fetch): void {
  const getReport = home ? cachedReport(home, fetchFn) : null;
  bot.hears(S.weatherButton, async (ctx) => {
    if (!getReport) return ctx.reply(W.notSetUp);
    try {
      return await ctx.reply(formatReport(await getReport(Date.now())));
    } catch (err: unknown) {
      console.error('Weather report failed', err);
      return ctx.reply(W.unavailable);
    }
  });
}
