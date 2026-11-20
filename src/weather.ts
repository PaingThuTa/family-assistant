import { parseYangonDateTime } from './time.ts';

export type Home = { lat: number; lon: number };
export type FetchFn = typeof fetch;
export type HourSlot = { at: number; probability: number; precipitation: number };
export type Forecast = { hours: HourSlot[] };
export type Quake = { id: string; magnitude: number; place: string; timeMs: number; lat: number; lon: number };

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const QUAKES_URL = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson';
const TIMEOUT_MS = 10_000;

const RAIN_WINDOW_MS = 2 * 60 * 60_000;
const SLOT_MS = 60 * 60_000; // Open-Meteo hourly slots
const RAIN_MIN_PROBABILITY = 70;
const RAIN_MIN_MM = 0.5;
const QUAKE_MIN_MAGNITUDE = 4.5;
const QUAKE_MAX_KM = 300;
// USGS can take over an hour to publish quakes outside the US; sent_alerts stops repeats.
const QUAKE_MAX_AGE_MS = 6 * 60 * 60_000;
const EARTH_RADIUS_KM = 6371;

// API data is untrusted: every field is checked before use.
export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
export const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function arr(v: unknown, name: string): unknown[] {
  if (!Array.isArray(v)) throw new Error(`Forecast field ${name} is not an array`);
  return v;
}

export async function getJson(url: string, fetchFn: FetchFn): Promise<unknown> {
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
  if (!isObj(data) || !isObj(data.hourly)) throw new Error('Unexpected forecast shape');
  const { hourly } = data;
  const probs = arr(hourly.precipitation_probability, 'precipitation_probability');
  const mm = arr(hourly.precipitation, 'precipitation');
  const hours = arr(hourly.time, 'hourly.time').flatMap((t, i) => {
    const at = parseLocal(t);
    const probability = probs[i];
    const precipitation = mm[i];
    return at !== null && isNum(probability) && isNum(precipitation) ? [{ at, probability, precipitation }] : [];
  });
  return { hours };
}

export async function fetchForecast(home: Home, fetchFn: FetchFn): Promise<Forecast> {
  const params = new URLSearchParams({
    latitude: String(home.lat),
    longitude: String(home.lon),
    hourly: 'precipitation_probability,precipitation',
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

// Only recent quakes, so a fresh database does not report a whole day of old ones.
export const nearbyRecentQuakes = (quakes: Quake[], home: Home, now: number): Quake[] =>
  quakes.filter(
    (q) =>
      q.magnitude >= QUAKE_MIN_MAGNITUDE &&
      now - q.timeMs <= QUAKE_MAX_AGE_MS &&
      distanceKm(home, q) <= QUAKE_MAX_KM,
  );
