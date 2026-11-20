import { parseYangonDateTime, yangonParts } from './time.ts';

export type Home = { lat: number; lon: number };
export type FetchFn = typeof fetch;
export type HourSlot = { at: number; probability: number; precipitation: number };
export type DaySummary = { date: string; maxTemp: number; maxProbability: number };
export type Forecast = { hours: HourSlot[]; days: DaySummary[] };
export type Quake = { id: string; magnitude: number; place: string; timeMs: number; lat: number; lon: number };

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const QUAKES_URL = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson';
const TIMEOUT_MS = 10_000;

const RAIN_WINDOW_MS = 2 * 60 * 60_000;
const SLOT_MS = 60 * 60_000; // Open-Meteo hourly slots
const RAIN_MIN_PROBABILITY = 70;
const RAIN_MIN_MM = 0.5;
const HEAT_MIN_C = 40;
const QUAKE_MIN_MAGNITUDE = 4.5;
const QUAKE_MAX_KM = 300;
const QUAKE_MAX_AGE_MS = 60 * 60_000;
const EARTH_RADIUS_KM = 6371;

// API data is untrusted: every field is checked before use.
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function arr(v: unknown, name: string): unknown[] {
  if (!Array.isArray(v)) throw new Error(`Forecast field ${name} is not an array`);
  return v;
}

async function getJson(url: string, fetchFn: FetchFn): Promise<unknown> {
  const res = await fetchFn(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

// Open-Meteo hourly times are "YYYY-MM-DDTHH:MM" in the requested timezone (Asia/Yangon).
function parseLocal(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const [date, time] = value.split('T');
  return date && time ? parseYangonDateTime(date, time) : null;
}

// Throws if the overall shape is wrong; individual bad slots (e.g. null values) are skipped.
function parseForecast(data: unknown): Forecast {
  if (!isObj(data) || !isObj(data.hourly) || !isObj(data.daily)) throw new Error('Unexpected forecast shape');
  const { hourly, daily } = data;
  const probs = arr(hourly.precipitation_probability, 'precipitation_probability');
  const mm = arr(hourly.precipitation, 'precipitation');
  const hours = arr(hourly.time, 'hourly.time').flatMap((t, i) => {
    const at = parseLocal(t);
    const probability = probs[i];
    const precipitation = mm[i];
    return at !== null && isNum(probability) && isNum(precipitation) ? [{ at, probability, precipitation }] : [];
  });
  const temps = arr(daily.temperature_2m_max, 'temperature_2m_max');
  const dayProbs = arr(daily.precipitation_probability_max, 'precipitation_probability_max');
  const days = arr(daily.time, 'daily.time').flatMap((date, i) => {
    const maxTemp = temps[i];
    const maxProbability = dayProbs[i];
    const ok = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && isNum(maxTemp) && isNum(maxProbability);
    return ok ? [{ date, maxTemp, maxProbability }] : [];
  });
  return { hours, days };
}

export async function fetchForecast(home: Home, fetchFn: FetchFn): Promise<Forecast> {
  const params = new URLSearchParams({
    latitude: String(home.lat),
    longitude: String(home.lon),
    hourly: 'precipitation_probability,precipitation',
    daily: 'temperature_2m_max,precipitation_probability_max',
    timezone: 'Asia/Yangon',
    forecast_days: '2',
  });
  return parseForecast(await getJson(`${FORECAST_URL}?${params}`, fetchFn));
}

// Likely real rain in the hour in progress or an hourly slot starting within the next 2 hours.
export const rainSoon = (forecast: Forecast, now: number): boolean =>
  forecast.hours.some(
    (h) =>
      h.at + SLOT_MS > now &&
      h.at < now + RAIN_WINDOW_MS &&
      h.probability >= RAIN_MIN_PROBABILITY &&
      h.precipitation >= RAIN_MIN_MM,
  );

export function todaySummary(
  forecast: Forecast,
  now: number,
): { maxTemp: number; rainChance: number; heat: boolean } | null {
  const today = forecast.days.find((d) => d.date === yangonParts(now).date);
  if (!today) return null;
  return {
    maxTemp: Math.round(today.maxTemp),
    rainChance: Math.round(today.maxProbability),
    heat: today.maxTemp >= HEAT_MIN_C,
  };
}

// Malformed features are skipped, so one bad entry does not hide the rest.
function parseQuake(f: unknown): Quake | null {
  if (!isObj(f) || typeof f.id !== 'string' || !isObj(f.properties) || !isObj(f.geometry)) return null;
  const { mag, place, time } = f.properties;
  const coords = f.geometry.coordinates;
  if (!isNum(mag) || !isNum(time) || !Array.isArray(coords)) return null;
  const [lon, lat] = coords; // GeoJSON order is [lon, lat, depth]
  if (!isNum(lat) || !isNum(lon)) return null;
  return { id: f.id, magnitude: mag, place: typeof place === 'string' ? place : '', timeMs: time, lat, lon };
}

export async function fetchQuakes(fetchFn: FetchFn): Promise<Quake[]> {
  const data = await getJson(QUAKES_URL, fetchFn);
  if (!isObj(data) || !Array.isArray(data.features)) throw new Error('Unexpected quake feed shape');
  return data.features.flatMap((f) => parseQuake(f) ?? []);
}

const rad = (deg: number) => (deg * Math.PI) / 180;

// Haversine great-circle distance.
export function distanceKm(a: Home, b: Home): number {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

// Only quakes from the last hour, so a restart does not replay old ones.
export const nearbyRecentQuakes = (quakes: Quake[], home: Home, now: number): Quake[] =>
  quakes.filter(
    (q) =>
      q.magnitude >= QUAKE_MIN_MAGNITUDE &&
      now - q.timeMs <= QUAKE_MAX_AGE_MS &&
      distanceKm(home, q) <= QUAKE_MAX_KM,
  );
