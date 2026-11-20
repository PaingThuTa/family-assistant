import { createHmac } from 'node:crypto';

export const TEST_TOKEN = '123:test-token';

// Signs Mini App launch data the same way Telegram does.
export function sign(telegramId: number, authDate = Math.floor(Date.now() / 1000), token = TEST_TOKEN): string {
  const params = new URLSearchParams({ auth_date: String(authDate), user: JSON.stringify({ id: telegramId }) });
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  params.set('hash', createHmac('sha256', secret).update(dataCheckString).digest('hex'));
  return params.toString();
}
