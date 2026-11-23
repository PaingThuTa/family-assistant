// One-time setup after the first deploy, and again whenever WEBAPP_URL or WEBHOOK_SECRET changes:
//   npm run setup-telegram
// Points Telegram at the Worker and sets the Timeline menu button and the command menu.
import { Api } from 'grammy';
import { ALERT_COMMANDS } from './alerts.ts';
import { required, WEBHOOK_PATH, webAppUrl } from './config.ts';
import { S } from './strings.ts';

const env = process.env;
const api = new Api(required(env, 'BOT_TOKEN'));
const url = webAppUrl(env);
if (!url) throw new Error('WEBAPP_URL must be the https:// address of the Worker.');

await api.setWebhook(new URL(WEBHOOK_PATH, url).href, { secret_token: required(env, 'WEBHOOK_SECRET') });
await api.setChatMenuButton({ menu_button: { type: 'web_app', text: S.timelineButton, web_app: { url } } });
// This replaces the whole command menu, so /start must be listed too.
await api.setMyCommands([{ command: 'start', description: S.startCommand }, ...ALERT_COMMANDS]);

const info = await api.getWebhookInfo();
console.info(`Webhook set to ${info.url}. Pending updates: ${info.pending_update_count}.`);
