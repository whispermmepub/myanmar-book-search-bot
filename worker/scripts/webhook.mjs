// Secrets are read from environment, never printed. Requires Node >= 22.
const token = process.env.TELEGRAM_BOT_TOKEN;
const action = process.argv[2] ?? 'status';
if (!token) throw new Error('Set TELEGRAM_BOT_TOKEN in your shell');
let method, payload = {};
if (action === 'set') {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const base = process.env.PUBLIC_BASE_URL;
  if (!secret || !/^[A-Za-z0-9_-]{1,256}$/.test(secret)) throw new Error('Set a valid TELEGRAM_WEBHOOK_SECRET');
  if (!base || new URL(base).protocol !== 'https:') throw new Error('Set PUBLIC_BASE_URL to your HTTPS Worker origin');
  method = 'setWebhook';
  payload = { url: new URL('/webhook', base).href, secret_token: secret, max_connections: 1,
    allowed_updates: ['message', 'callback_query', 'inline_query', 'my_chat_member'], drop_pending_updates: false };
} else if (action === 'delete') { method = 'deleteWebhook'; payload = { drop_pending_updates: false }; }
else if (action === 'status') method = 'getWebhookInfo';
else throw new Error('Usage: npm run webhook -- set|status|delete');
let response;
try {
  response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(15000),
  });
} catch { throw new Error('Telegram request failed; token is not logged'); }
const result = await response.json();
if (!result.ok) throw new Error(`Telegram returned ${result.error_code}: ${result.description}`);
console.log(JSON.stringify(result.result, null, 2));
