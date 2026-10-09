import { allBooks, byId, DEFAULT_CSV_URL, parseBooks } from './catalog';
import { getCover } from './covers';
import { lease, meta, release, rememberGroup, setMeta } from './db';
import { Telegram, TelegramError } from './telegram';
import { id, now, setting, type Book, type Chat, type Env } from './types';

interface Job { id: number; chat_id: string; chat_type: string; book_id: string; attempts: number; kind: string }
export async function migrateGroup(env: Env, oldId: string, newId: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO groups(chat_id,chat_type,updated_at) VALUES(?,?,?)').bind(newId, 'supergroup', now()),
    env.DB.prepare('DELETE FROM groups WHERE chat_id=?').bind(oldId),
    env.DB.prepare("UPDATE outbox SET chat_id=?,chat_type='supergroup' WHERE chat_id=? AND status='pending'").bind(newId, oldId),
  ]);
  if (env.NOTIFY_GROUP_ID === oldId) await setMeta(env, 'fixed_group_migrated', newId);
}
export async function initialize(env: Env): Promise<void> {
  const username = await meta(env, 'bot_username');
  if (username) env.BOT_USERNAME = username;
  else {
    try {
      const me = await new Telegram(env).call<{username: string}>('getMe', {});
      if (me.username) { env.BOT_USERNAME = me.username; await setMeta(env, 'bot_username', me.username); }
    } catch { console.warn('getMe unavailable; using configured BOT_USERNAME'); }
  }
  if (env.NOTIFY_GROUP_ID && /^-\d+$/.test(env.NOTIFY_GROUP_ID)) {
    const migrated = await meta(env, 'fixed_group_migrated');
    await rememberGroup(env, { id: migrated ?? env.NOTIFY_GROUP_ID, type: 'supergroup' });
  }
}
// Split JSON bindings below D1 value-size limits while committing all statements atomically.
function chunks(books: Book[]): string[] {
  const output: string[] = []; let items: string[] = []; let size = 2;
  for (const book of books) {
    const json = JSON.stringify(book); const bytes = new TextEncoder().encode(json).length;
    if (bytes > 500000) throw new Error('A book row is too large for D1');
    if (size + bytes > 500000 && items.length) { output.push('[' + items.join(',') + ']'); items = []; size = 2; }
    items.push(json); size += bytes + 1;
  }
  if (items.length) output.push('[' + items.join(',') + ']');
  return output;
}
async function boundedCSV(response: Response): Promise<string> {
  const maxBytes = 16 * 1024 * 1024;
  if (Number(response.headers.get('content-length') ?? 0) > maxBytes) {
    await response.body?.cancel(); throw new Error('CSV exceeds 16 MiB safety limit');
  }
  const reader = response.body?.getReader(); if (!reader) throw new Error('CSV response has no body');
  const decoder = new TextDecoder(); const pieces: string[] = []; let bytes = 0;
  while (true) {
    const part = await reader.read(); if (part.done) break;
    bytes += part.value.length;
    if (bytes > maxBytes) { await reader.cancel(); throw new Error('CSV exceeds 16 MiB safety limit'); }
    pieces.push(decoder.decode(part.value, { stream: true }));
  }
  pieces.push(decoder.decode()); return pieces.join('');
}
export async function refreshCatalog(env: Env): Promise<{count: number; newCount: number}> {
  const owner = await lease(env, 'refresh', 180); if (!owner) throw new Error('Refresh is already running');
  try {
    const response = await fetch(env.SHEET_CSV_URL || DEFAULT_CSV_URL, {
      headers: { 'User-Agent': 'MyanmarBookWorker/1.0' }, signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`CSV returned HTTP ${response.status}`); }
    const text = await boundedCSV(response);
    const books = await parseBooks(text);
    if (!books.length) throw new Error('CSV contains no complete book rows; retaining previous catalog');
    if (books.length > 20000) throw new Error('Catalog exceeds configured implementation safety limit');
    const initialized = await meta(env, 'catalog_initialized'); const at = now();
    const importedBaseline = await env.DB.prepare('SELECT id FROM known_books LIMIT 1').first();
    const shouldNotify = Boolean(initialized || importedBaseline);
    const columns = ['id','timestamp','publisher','month','author','title','edition','genre','price','description',
      'image_url','image_id','title_n','author_n','publisher_n'];
    const statements = [env.DB.prepare('UPDATE books SET active=0 WHERE active=1')];
    for (const json of chunks(books)) statements.push(env.DB.prepare(`
      INSERT INTO books(${columns.join(',')},active,updated_at)
      SELECT ${columns.map(c => `json_extract(value,'$.${c}')`).join(',')},1,? FROM json_each(?) WHERE 1
      ON CONFLICT(id) DO UPDATE SET ${columns.slice(1).map(c => `${c}=excluded.${c}`).join(',')},active=1,updated_at=excluded.updated_at`)
      .bind(at, json));
    const newQuery = "SELECT COUNT(*) AS count FROM books b WHERE b.active=1 AND NOT EXISTS(SELECT 1 FROM known_books k WHERE k.id=b.id)";
    const countIndex = statements.length; statements.push(env.DB.prepare(newQuery));
    if (shouldNotify) statements.push(env.DB.prepare(`
      INSERT OR IGNORE INTO outbox(dedupe_key,chat_id,chat_type,book_id,kind,created_at)
      SELECT 'new:'||b.id||':'||t.chat_id,t.chat_id,t.chat_type,b.id,'new',?
      FROM (SELECT id FROM books b WHERE active=1 AND NOT EXISTS(SELECT 1 FROM known_books k WHERE k.id=b.id)
            ORDER BY timestamp DESC,id LIMIT ?) b
      CROSS JOIN (SELECT chat_id,chat_type FROM groups UNION ALL SELECT chat_id,'private' FROM subscribers WHERE enabled=1) t`)
      .bind(at, Math.floor(setting(env.NOTIFY_MAX_PER_REFRESH, 25, 0, 1000))));
    statements.push(env.DB.prepare('INSERT OR IGNORE INTO known_books(id,first_seen) SELECT id,? FROM books WHERE active=1').bind(at));
    // Numeric links issued by Railway can use an imported snapshot, or the first Workers refresh as a best-effort mapping.
    if (!initialized) statements.push(env.DB.prepare(`INSERT OR IGNORE INTO legacy_book_ids(legacy_id,book_id)
      SELECT CAST(key AS INTEGER),json_extract(value,'$.id') FROM json_each(?)`).bind(JSON.stringify(books.map(b => ({id: b.id})))));
    statements.push(env.DB.prepare("INSERT INTO meta(key,value) VALUES('catalog_initialized','1') ON CONFLICT(key) DO UPDATE SET value='1'"));
    statements.push(env.DB.prepare("INSERT INTO meta(key,value) VALUES('loaded_at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(String(at)));
    statements.push(env.DB.prepare("DELETE FROM meta WHERE key='refresh_error'"));
    const results = await env.DB.batch(statements);
    const newCount = shouldNotify ? Number((results[countIndex].results[0] as {count: number}).count) : 0;
    console.log('Catalog refreshed', { count: books.length, newCount });
    return { count: books.length, newCount };
  } catch (err) {
    await setMeta(env, 'refresh_error', err instanceof Error ? err.message : 'Unknown refresh error'); throw err;
  } finally { await release(env, 'refresh', owner); }
}
export async function enqueueDemo(env: Env, book: Book, chat: Chat, updateId: number): Promise<void> {
  await env.DB.prepare(`INSERT OR IGNORE INTO outbox(dedupe_key,chat_id,chat_type,book_id,kind,created_at)
    SELECT 'demo:'||?||':'||t.chat_id,t.chat_id,t.chat_type,?,'demo',?
    FROM (SELECT chat_id,chat_type FROM groups UNION SELECT ? AS chat_id,? AS chat_type) t`)
    .bind(String(updateId), book.id, now(), id(chat.id), chat.type).run();
}
export async function drainNotifications(env: Env): Promise<void> {
  const telegram = new Telegram(env); const batch = Math.floor(setting(env.NOTIFICATION_BATCH, 3, 1, 20));
  for (let i = 0; i < batch; i++) {
    const at = now(); const blocked = Number(await meta(env, 'telegram_backoff') ?? 0); if (blocked > at) return;
    const job = await env.DB.prepare(`UPDATE outbox SET lease_until=?,attempts=attempts+1
      WHERE id=(SELECT id FROM outbox WHERE status='pending' AND available_at<=? AND lease_until<=? ORDER BY id LIMIT 1)
      RETURNING *`).bind(at + 120, at, at).first<Job>();
    if (!job) break;
    const chat: Chat = { id: job.chat_id, type: job.chat_type };
    try {
      if (chat.type === 'private' && job.kind !== 'demo') {
        const enabled = await env.DB.prepare('SELECT enabled FROM subscribers WHERE chat_id=?').bind(job.chat_id).first<number>('enabled');
        if (!enabled) { await env.DB.prepare("UPDATE outbox SET status='skipped',lease_until=0 WHERE id=?").bind(job.id).run(); continue; }
      } else if (chat.type !== 'private') {
        const member = await env.DB.prepare('SELECT chat_id FROM groups WHERE chat_id=?').bind(job.chat_id).first();
        if (!member) { await env.DB.prepare("UPDATE outbox SET status='skipped',lease_until=0 WHERE id=?").bind(job.id).run(); continue; }
      }
      const book = await byId(env, job.book_id); if (!book) throw new Error('Book no longer exists');
      await telegram.card(chat, book, undefined, true);
      await env.DB.prepare("UPDATE outbox SET status='done',lease_until=0,last_error=NULL WHERE id=?").bind(job.id).run();
      // At most one message per second globally; batch size also keeps group flood rates low.
      if (i + 1 < batch) await new Promise(resolve => setTimeout(resolve, 1100));
    } catch (err) {
      if (err instanceof TelegramError && err.migrateTo) await migrateGroup(env, job.chat_id, String(err.migrateTo));
      const permanent = err instanceof TelegramError && (err.code === 403 || (err.code === 400 && /chat not found|bot was kicked|not enough rights/i.test(err.message)));
      if (permanent) {
        if (chat.type === 'private') await env.DB.prepare('UPDATE subscribers SET enabled=0 WHERE chat_id=?').bind(job.chat_id).run();
        else await env.DB.prepare('DELETE FROM groups WHERE chat_id=?').bind(job.chat_id).run();
      }
      const delay = err instanceof TelegramError && err.retryAfter ? err.retryAfter + 1 : Math.min(3600, 30 * 2 ** Math.min(job.attempts, 7));
      if (err instanceof TelegramError && err.code === 429) await setMeta(env, 'telegram_backoff', String(now() + delay));
      await env.DB.prepare('UPDATE outbox SET status=?,lease_until=0,available_at=?,last_error=? WHERE id=?')
        .bind(permanent || job.attempts >= 8 ? 'failed' : 'pending', now() + delay, err instanceof Error ? err.message : 'Delivery failed', job.id).run();
      if (err instanceof TelegramError && err.code === 429) return;
    }
  }
}
async function clearMessageState(env: Env, chatId: string, messageId: number): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM search_states WHERE chat_id=? AND message_id=?').bind(chatId, messageId),
    env.DB.prepare(`UPDATE search_states SET state=json_remove(state,'$.cardId','$.currentBookId')
      WHERE chat_id=? AND json_extract(state,'$.cardId')=?`).bind(chatId, messageId),
    env.DB.prepare('DELETE FROM summary_views WHERE chat_id=? AND card_id=?').bind(chatId, messageId),
    env.DB.prepare('DELETE FROM deletions WHERE chat_id=? AND message_id=?').bind(chatId, messageId),
  ]);
}
export async function drainDeletions(env: Env): Promise<void> {
  const telegram = new Telegram(env);
  for (let i = 0; i < setting(env.DELETE_BATCH, 5, 1, 30); i++) {
    const at = now();
    const row = await env.DB.prepare(`UPDATE deletions SET lease_until=?,attempts=attempts+1
      WHERE rowid=(SELECT rowid FROM deletions WHERE due_at<=? AND lease_until<=? ORDER BY due_at LIMIT 1) RETURNING *`)
      .bind(at + 60, at, at).first<{chat_id: string; message_id: number; attempts: number}>();
    if (!row) return;
    try { await telegram.delete({ id: row.chat_id, type: 'supergroup' }, row.message_id); }
    catch (err) {
      if (!(err instanceof TelegramError && [400, 403].includes(err.code)) && row.attempts < 5) {
        await env.DB.prepare('UPDATE deletions SET due_at=?,lease_until=0 WHERE chat_id=? AND message_id=?')
          .bind(now() + (err instanceof TelegramError && err.retryAfter ? err.retryAfter + 1 : 60), row.chat_id, row.message_id).run();
        continue;
      }
    }
    await clearMessageState(env, row.chat_id, row.message_id);
  }
}
async function refreshIfDue(env: Env): Promise<void> {
  const requests = (await env.DB.prepare('SELECT * FROM refresh_requests ORDER BY created_at LIMIT 5').all<{
    chat_id: string; message_id: number; chat_type: string;
  }>()).results;
  const loadedAt = Number(await meta(env, 'loaded_at') ?? 0);
  const attemptedAt = Number(await meta(env, 'refresh_attempted_at') ?? 0);
  const due = !loadedAt || now() - loadedAt >= setting(env.REFRESH_HOURS, 6, 1 / 60, 8760) * 3600;
  if (!requests.length && (!due || now() - attemptedAt < 300)) return;
  await setMeta(env, 'refresh_attempted_at', String(now()));
  let text: string;
  try {
    const result = await refreshCatalog(env);
    text = `ပြီးပါပြီ — စာအုပ် ${result.count} ခု ရှိပါတယ်။\nအသစ် ${result.newCount} အုပ် — group/DM အသိပေးရန် queue ထဲ ထည့်ထားပါပြီ။`;
  } catch (err) {
    text = 'စာအုပ်စာရင်း ပြန်ဆွဲမှု မအောင်မြင်ပါ။ ယခင် data ကို ဆက်သုံးထားပါတယ်။ /refresh ဖြင့် ထပ်စမ်းပါ။';
    console.warn('Refresh failed', err instanceof Error ? err.message : 'Unknown');
  }
  const telegram = new Telegram(env);
  for (const request of requests) {
    try { await telegram.edit({ id: request.chat_id, type: request.chat_type }, request.message_id, text); }
    catch { /* Original progress message may have been deleted or Telegram temporarily unavailable. */ }
    await env.DB.prepare('DELETE FROM refresh_requests WHERE chat_id=? AND message_id=?').bind(request.chat_id, request.message_id).run();
  }
}
export async function maintenance(env: Env, full = true): Promise<void> {
  const owner = await lease(env, 'maintenance', 240); if (!owner) return;
  try {
    await initialize(env);
    if (full) await refreshIfDue(env);
    await drainDeletions(env);
    await drainNotifications(env);
    if (full) {
      if (env.COVERS && setting(env.WARM_COVERS_PER_TICK, 1, 0, 3) > 0) {
        const rows = (await env.DB.prepare(`SELECT DISTINCT b.image_id FROM books b LEFT JOIN cover_cache c ON c.image_id=b.image_id
          WHERE b.active=1 AND (c.image_id IS NULL OR (c.cached<=0 AND c.updated_at<?)) LIMIT ?`)
          .bind(now() - 86400, Math.floor(setting(env.WARM_COVERS_PER_TICK, 1, 0, 3))).all<{image_id: string}>()).results;
        for (const row of rows) await getCover(env, row.image_id);
      }
      await env.DB.batch([
        env.DB.prepare('DELETE FROM search_states WHERE expires_at<?').bind(now()),
        env.DB.prepare('DELETE FROM summary_views WHERE expires_at<?').bind(now()),
        env.DB.prepare("DELETE FROM inbox WHERE status IN ('done','failed') AND created_at<?").bind(now() - 7 * 86400),
        env.DB.prepare("DELETE FROM outbox WHERE status IN ('done','failed','skipped') AND created_at<?").bind(now() - 30 * 86400),
        env.DB.prepare('DELETE FROM usage_days WHERE day<?').bind(new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10)),
        env.DB.prepare('DELETE FROM locks WHERE expires_at<?').bind(now()),
      ]);
    }
  } finally { await release(env, 'maintenance', owner); }
}
