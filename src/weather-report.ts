// The "ရာသီဥတု" chat button: a short, plain-words weather message. It leads with what to do,
// and shows UV / air / heat lines only on days they matter.
import type { Bot } from 'grammy';
import type { Ctx } from './bot.ts';
import { S } from './strings.ts';
import { arr, getJson, isNum, isObj, type FetchFn, type Home } from './weather.ts';

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const AIR_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const CACHE_MS = 15 * 60_000;
const COMING_DAYS = 3;

const RAIN_POSSIBLE = 30; // % chance
const RAIN_LIKELY = 60;
const SUN_ADVICE_UV = 8;
const AIR_ADVICE_PM = 35.5; // µg/m³, US EPA "unhealthy for sensitive groups"
const HOT_C = 38;
const FEELS_GAP_C = 3; // only mention "feels like" when it differs this much

export interface DayForecast {
  date: string; // YYYY-MM-DD, Yangon
  code: number;
  max: number;
  rain: number; // max chance, %
  uv: number;
}

export interface RainPart {
  name: string; // မနက် / နေ့လယ် / ည
  chance: number; // max %, in this part of today
}

export interface WeatherReport {
  temp: number;
  feels: number;
  code: number;
  rainParts: RainPart[]; // only the parts of today that are not over yet
  today: DayForecast;
  coming: DayForecast[];
  pm25: number | null; // null if the air quality service failed
}

// Emoji are written as escapes so the source stays emoji-free; Mom's messages still show them.
const E = {
  sun: '\u{2600}\u{FE0F}',
  sunCloud: '\u{1F324}\u{FE0F}',
  cloud: '\u{2601}\u{FE0F}',
  fog: '\u{1F32B}\u{FE0F}',
  drizzle: '\u{1F326}\u{FE0F}',
  rain: '\u{1F327}\u{FE0F}',
  storm: '\u{26C8}\u{FE0F}',
  umbrella: '\u{2614}',
  shirt: '\u{1F455}',
  glasses: '\u{1F576}\u{FE0F}',
  wind: '\u{1F32C}\u{FE0F}',
  warn: '\u{26A0}\u{FE0F}', // marks the lines and values that need attention today
};

// Burmese text. Review the wording with Mom.
const W = {
  title: (weekday: string, month: string, day: number) => `ဒီနေ့ (${weekday}၊ ${month} ${day})`,
  now: (temp: number, feels: number | null, max: number) =>
    `အခု ${temp}°${feels === null ? '' : ` (ခံစားရ ${feels}°)`}၊ နေ့လယ် ${max}° အထိ`,
  rainNo: 'မိုးမရွာနိုင်ဘူး',
  rainMaybe: 'မိုးရွာနိုင်တယ်',
  rainYes: 'မိုးရွာမယ်',
  laundryOk: `${E.shirt} အဝတ်လှန်းလို့ ရတယ်။`,
  umbrellaMaybe: `${E.umbrella} မိုးရွာနိုင်လို့ ထီး ယူထားပါ။`,
  umbrellaYes: `${E.warn} ထီး ယူသွားပါ။ အဝတ် မလှန်းပါနဲ့။`,
  sun: `${E.warn} နေ့လယ် နေပူ ပြင်းမယ်။ ၁၁ - ၃ နာရီ အပြင် ရှောင်ပါ။`,
  air: `${E.warn} လေထု မကောင်းဘူး။ အပြင်ထွက်ရင် mask တပ်ပါ။`,
  hot: `${E.warn} အရမ်းပူမယ်။ ရေ များများ သောက်ပါ။`,
  rainWhen: (parts: string) => `${E.rain} ${parts} မှာ မိုးရွာနိုင်တယ်`,
  sunAndAir: (uv: number, uvWord: string, uvBad: boolean, air: string | null, airBad: boolean) =>
    `${E.glasses} UV ${uv} (${uvWord})${uvBad ? ` ${E.warn}` : ''}` +
    (air === null ? '' : ` | ${E.wind} လေထု ${air}${airBad ? ` ${E.warn}` : ''}`),
  comingTitle: 'လာမယ့်ရက်',
  day: (name: string, sky: string, max: number, umbrella: boolean) =>
    `${name} - ${sky}၊ ${max}°${umbrella ? ` ${E.umbrella}` : ''}`,
  unavailable: 'ရာသီဥတု မရယူနိုင်ပါ။ နောက်မှ ပြန်ကြိုးစားပါ။',
  notSetUp: 'ရာသီဥတု မဖွင့်ရသေးပါ။',
};

// WMO weather codes (used by Open-Meteo) as an emoji plus plain Burmese words.
export function sky(code: number): string {
  if (code === 0) return `${E.sun} နေသာ`;
  if (code <= 2) return `${E.sunCloud} တိမ်အနည်းငယ်`;
  if (code === 3) return `${E.cloud} တိမ်ထူ`;
  if (code === 45 || code === 48) return `${E.fog} မြူဆိုင်း`;
  if (code >= 51 && code <= 57) return `${E.drizzle} မိုးဖွဲ`;
  if (code >= 95) return `${E.storm} မိုးကြိုးမုန်တိုင်း`;
  return `${E.rain} မိုးရွာ`;
}

const rainWords = (chance: number) => (chance >= RAIN_LIKELY ? W.rainYes : chance >= RAIN_POSSIBLE ? W.rainMaybe : W.rainNo);

// The one thing to do today about rain: hang the laundry, keep an umbrella, or don't hang it.
const rainAdvice = (chance: number) =>
  chance >= RAIN_LIKELY ? W.umbrellaYes : chance >= RAIN_POSSIBLE ? W.umbrellaMaybe : W.laundryOk;

// WHO UV bands.
export function uvWord(uv: number): string {
  if (uv < 3) return 'နည်း';
  if (uv < 6) return 'အသင့်အတင့်';
  if (uv < 8) return 'ပြင်း';
  if (uv < 11) return 'အလွန်ပြင်း';
  return 'အန္တရာယ်ရှိ';
}

// US EPA PM2.5 bands (µg/m³), in words.
export function airWord(pm: number): string {
  if (pm <= 12) return 'ကောင်း';
  if (pm <= 35.4) return 'အသင့်အတင့်';
  if (pm <= 150.4) return 'မကောင်း';
  return 'အလွန်မကောင်း';
}

const PARTS = [
  { name: 'မနက်', from: 6, to: 12 },
  { name: 'နေ့လယ်', from: 12, to: 18 },
  { name: 'ည', from: 18, to: 24 },
];

// Highest rain chance per part of today, for the parts that have not ended yet.
// Open-Meteo times are local "YYYY-MM-DDTHH:MM" strings (timezone=Asia/Yangon).
function parseRainParts(hourly: Record<string, unknown>, today: string, nowHour: number): RainPart[] {
  const times = arr(hourly.time, 'hourly.time');
  const probs = arr(hourly.precipitation_probability, 'precipitation_probability');
  return PARTS.filter((p) => p.to > nowHour).flatMap((p) => {
    const chances = times.flatMap((t, i) => {
      const chance = probs[i];
      if (typeof t !== 'string' || !t.startsWith(today) || !isNum(chance)) return [];
      const hour = Number(t.slice(11, 13));
      return hour >= p.from && hour < p.to ? [chance] : [];
    });
    return chances.length > 0 ? [{ name: p.name, chance: Math.max(...chances) }] : [];
  });
}

function parseDays(daily: Record<string, unknown>): DayForecast[] {
  const codes = arr(daily.weather_code, 'weather_code');
  const maxes = arr(daily.temperature_2m_max, 'temperature_2m_max');
  const rains = arr(daily.precipitation_probability_max, 'precipitation_probability_max');
  const uvs = arr(daily.uv_index_clear_sky_max, 'uv_index_clear_sky_max');
  return arr(daily.time, 'daily.time').flatMap((date, i) => {
    const [code, max, rain, uv] = [codes[i], maxes[i], rains[i], uvs[i]];
    const ok = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && isNum(code) && isNum(max) && isNum(rain);
    if (!ok) return [];
    return [{ date, code, max: Math.round(max), rain: Math.round(rain), uv: isNum(uv) ? Math.round(uv) : 0 }];
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
  const pm = isObj(air) && isObj(air.current) ? air.current.pm2_5 : null;
  const nowHour = typeof current.time === 'string' ? Number(current.time.slice(11, 13)) : 0;
  return {
    temp: Math.round(current.temperature_2m),
    feels: Math.round(current.apparent_temperature),
    code: current.weather_code,
    rainParts: parseRainParts(hourly, today.date, Number.isFinite(nowHour) ? nowHour : 0),
    today,
    coming: rest.slice(0, COMING_DAYS),
    pm25: isNum(pm) ? Math.round(pm) : null,
  };
}

const dateParts = (date: string) => new Date(`${date}T00:00:00Z`);
const weekdayOf = (date: string) => S.weekdays[dateParts(date).getUTCDay()]!;

export function formatReport(r: WeatherReport): string {
  const d = dateParts(r.today.date);
  const feels = Math.abs(r.feels - r.temp) >= FEELS_GAP_C ? r.feels : null;
  const extras = [
    ...(r.today.max >= HOT_C ? [W.hot] : []),
    ...(r.today.uv >= SUN_ADVICE_UV ? [W.sun] : []),
    ...(r.pm25 !== null && r.pm25 >= AIR_ADVICE_PM ? [W.air] : []),
  ];
  const wetParts = r.rainParts.filter((p) => p.chance >= RAIN_POSSIBLE).map((p) => p.name);
  return [
    W.title(weekdayOf(r.today.date), S.months[d.getUTCMonth()]!, d.getUTCDate()),
    `${sky(r.code)}၊ ${rainWords(r.today.rain)}`,
    W.now(r.temp, feels, r.today.max),
    ...(wetParts.length > 0 ? [W.rainWhen(wetParts.join('၊ '))] : []),
    W.sunAndAir(
      r.today.uv,
      uvWord(r.today.uv),
      r.today.uv >= SUN_ADVICE_UV,
      r.pm25 === null ? null : airWord(r.pm25),
      r.pm25 !== null && r.pm25 >= AIR_ADVICE_PM,
    ),
    rainAdvice(r.today.rain),
    ...extras,
    '',
    W.comingTitle,
    ...r.coming.map((day) => W.day(weekdayOf(day.date), sky(day.code), day.max, day.rain >= RAIN_LIKELY)),
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
    daily: 'weather_code,temperature_2m_max,precipitation_probability_max,uv_index_clear_sky_max',
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
