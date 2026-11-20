import { createHmac, timingSafeEqual } from 'node:crypto';

const MAX_AGE_S = 24 * 60 * 60;

// Telegram signs the Mini App launch data with the bot token. Returns the Telegram user ID
// if the signature is valid and fresh, otherwise null.
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
export function verifyInitData(initData: string, botToken: string, nowMs = Date.now()): number | null {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;

  const dataCheckString = [...params.entries()]
    .filter(([key]) => key !== 'hash')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(dataCheckString).digest();
  const given = Buffer.from(hash, 'hex');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  const authDate = Number(params.get('auth_date'));
  if (!Number.isFinite(authDate) || nowMs / 1000 - authDate > MAX_AGE_S) return null;

  try {
    const user: unknown = JSON.parse(params.get('user') ?? '');
    const id = (user as { id?: unknown } | null)?.id;
    return typeof id === 'number' && Number.isSafeInteger(id) ? id : null;
  } catch {
    return null;
  }
}
