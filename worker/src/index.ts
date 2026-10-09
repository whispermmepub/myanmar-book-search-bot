import { handleUpdate } from './bot';
import { coverResponse } from './covers';
import { initialize, maintenance } from './maintenance';
import { TelegramError } from './telegram';
import { now, setting, type Env, type Update } from './types';

interface InboxRow { update_id: number; payload: string; attempts: number; created_at: number }
async function processClaimed(env: Env, row: InboxRow): Promise<void> {
  try {
    const update = JSON.parse(row.payload) as Update;
    // Telegram inline/callback IDs expire: do not replay obsolete UI requests after an outage.
    if (!(now() - row.created_at > 60 && (update.inline_query || update.callback_query))) {
      await initialize(env); await handleUpdate(env, update);
    }
    await env.DB.prepare("UPDATE inbox SET status='done',lease_until=0,last_error=NULL,payload='{}' WHERE update_id=?").bind(row.update_id).run();
  } catch (err) {
    const description = err instanceof Error ? err.message : 'Update processing failed';
    const permanent = err instanceof TelegramError && [400, 403, 401].includes(err.code);
    const delay = err instanceof TelegramError && err.retryAfter ? err.retryAfter + 1 : Math.min(300, 10 * 2 ** row.attempts);
    await env.DB.prepare('UPDATE inbox SET status=?,lease_until=0,available_at=?,last_error=? WHERE update_id=?')
      .bind(permanent || row.attempts >= 6 ? 'failed' : 'pending', now() + delay, description, row.update_id).run();
    console.warn('Update processing deferred/failed', { updateId: row.update_id, description });
  }
}
export async function drainInbox(env: Env, updateId?: number): Promise<void> {
  const batch = updateId === undefined ? Math.floor(setting(env.INBOX_BATCH, 2, 1, 10)) : 1;
  for (let i = 0; i < batch; i++) {
    const at = now();
    const query = updateId === undefined ?
      `UPDATE inbox SET lease_until=?,attempts=attempts+1 WHERE update_id=(
        SELECT update_id FROM inbox WHERE status='pending' AND available_at<=? AND lease_until<=? ORDER BY created_at,update_id LIMIT 1) RETURNING *` :
      `UPDATE inbox SET lease_until=?,attempts=attempts+1 WHERE update_id=? AND status='pending' AND available_at<=? AND lease_until<=? RETURNING *`;
    const statement = env.DB.prepare(query);
    const row = await (updateId === undefined ? statement.bind(at + 120, at, at) : statement.bind(at + 120, updateId, at, at)).first<InboxRow>();
    if (!row) return;
    await processClaimed(env, row);
  }
}
async function bodyText(request: Request): Promise<string> {
  const limit = 1024 * 1024;
  if (Number(request.headers.get('content-length') ?? 0) > limit) throw new Error('Payload too large');
  const reader = request.body?.getReader(); if (!reader) throw new Error('Empty body');
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const part = await reader.read(); if (part.done) break;
    size += part.value.length;
    if (size > limit) { await reader.cancel(); throw new Error('Payload too large'); }
    chunks.push(part.value);
  }
  const data = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(data);
}
async function equalSecret(a: string, b: string): Promise<boolean> {
  // Hash both inputs before comparing, avoiding an early-return per secret character.
  const encode = new TextEncoder();
  const [ha, hb] = await Promise.all([crypto.subtle.digest('SHA-256', encode.encode(a)), crypto.subtle.digest('SHA-256', encode.encode(b))]);
  const aa = new Uint8Array(ha); const bb = new Uint8Array(hb); let diff = 0;
  for (let i = 0; i < aa.length; i++) diff |= aa[i] ^ bb[i];
  return diff === 0;
}
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') return Response.json({ ok: true, service: 'myanmar-book-search-worker' });
    if (request.method === 'GET' && /^\/covers\/[\w-]{1,200}$/.test(url.pathname)) {
      return coverResponse(env, url.pathname.slice(8));
    }
    if (url.pathname !== '/webhook') return new Response('Not found', { status: 404 });
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET) return new Response('Secrets not configured', { status: 503 });
    const supplied = request.headers.get('X-Telegram-Bot-Api-Secret-Token') ?? '';
    if (!await equalSecret(supplied, env.TELEGRAM_WEBHOOK_SECRET)) return new Response('Unauthorized', { status: 401 });
    let text: string; let update: Update;
    try {
      text = await bodyText(request); update = JSON.parse(text) as Update;
      if (!Number.isSafeInteger(update.update_id) || update.update_id < 0) throw new Error('Invalid update_id');
    } catch { return new Response('Invalid update payload', { status: 400 }); }
    try {
      // Only acknowledge after the durable insert; Telegram retries on D1 failure.
      await env.DB.prepare('INSERT OR IGNORE INTO inbox(update_id,payload,created_at) VALUES(?,?,?)').bind(update.update_id, text, now()).run();
      ctx.waitUntil(drainInbox(env, update.update_id).catch(err => console.error('Inbox drain interrupted', err instanceof Error ? err.message : 'Unknown')));
      return new Response('OK');
    } catch { return new Response('Temporary storage failure', { status: 503 }); }
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // Cron owns long-running refresh/fan-out; no detached in-memory timer is relied upon.
    ctx.waitUntil((async () => { await drainInbox(env); await maintenance(env); })());
  },
} satisfies ExportedHandler<Env>;
