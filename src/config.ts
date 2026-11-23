import type { MemberConfig, Role } from './db.ts';
import type { Home } from './weather.ts';

// Cloudflare vars and secrets, or process.env in scripts. All values are strings.
export type Env = Record<string, string | undefined>;

export const SCHEDULER = { repeatMs: 5 * 60_000, maxPings: 6 };
export const WEBHOOK_PATH = '/telegram';

const MEMBERS: { env: string; name: string; role: Role }[] = [
  { env: 'ADMIN_TELEGRAM_ID', name: 'Admin', role: 'admin' },
  { env: 'MOM_TELEGRAM_ID', name: 'Mom', role: 'member' },
  { env: 'DAD_TELEGRAM_ID', name: 'Dad', role: 'member' },
  { env: 'BROTHER_TELEGRAM_ID', name: 'Brother', role: 'member' },
];

export function required(env: Env, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`${key} is missing. See .env.example.`);
  return value;
}

export function readMembers(env: Env): MemberConfig[] {
  const members = MEMBERS.map(({ env: key, name, role }) => {
    const raw = env[key];
    if (!raw) {
      console.warn(`${key} is not set, ${name} cannot use the bot.`);
      return { name, role, telegramId: null };
    }
    const telegramId = Number(raw);
    if (!Number.isSafeInteger(telegramId)) throw new Error(`${key} must be a number, got "${raw}"`);
    return { name, role, telegramId };
  });
  const ids = members.flatMap((m) => (m.telegramId === null ? [] : [m.telegramId]));
  if (new Set(ids).size !== ids.length) throw new Error('The same Telegram ID is used twice in the config');
  return members;
}

// Home location for weather and quake alerts, rounded to ~1 km before it is sent to any service.
export function readHome(env: Env): Home | null {
  const lat = Number(env.HOME_LAT);
  const lon = Number(env.HOME_LON);
  const valid = env.HOME_LAT && env.HOME_LON && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
  if (!valid) {
    console.warn('HOME_LAT/HOME_LON are not set, so weather and quake alerts are off.');
    return null;
  }
  const round2 = (n: number) => Math.round(n * 100) / 100;
  return { lat: round2(lat), lon: round2(lon) };
}

// The Mini App needs HTTPS; anything else means the app buttons stay off.
export const webAppUrl = (env: Env): string | null => (env.WEBAPP_URL?.startsWith('https://') ? env.WEBAPP_URL : null);
