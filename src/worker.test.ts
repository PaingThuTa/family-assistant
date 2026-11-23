import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker from './worker.ts';

const env = { BOT_TOKEN: '1:x', TURSO_DATABASE_URL: ':memory:', WEBHOOK_SECRET: 'right', ADMIN_TELEGRAM_ID: '1' };
const post = (secret: string) =>
  worker.fetch(new Request('http://x/telegram', { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': secret }, body: '{}' }), env);

test('a webhook call without the right secret is refused before anything else runs', async () => {
  assert.equal((await post('wrong')).status, 401);
  assert.equal((await post('')).status, 401);
});

test('paths other than the webhook and /api/ are 404', async () => {
  assert.equal((await worker.fetch(new Request('http://x/anything'), env)).status, 404);
  assert.equal((await worker.fetch(new Request('http://x/telegram'), env)).status, 404); // GET, not POST
});

test('the cron sets up the database, then the API answers', async () => {
  await worker.scheduled({ scheduledTime: Date.UTC(2026, 10, 23, 4, 1) }, env);
  const res = await worker.fetch(new Request('http://x/api/me'), env);
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('cache-control'), 'no-store');
});
