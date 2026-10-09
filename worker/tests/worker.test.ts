import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Miniflare } from 'miniflare';
import { readFileSync } from 'node:fs';
import { addressedText, handleUpdate } from '../src/bot';
import { normalize, parseBooks, parseCSV, search, stableBookId, byId } from '../src/catalog';
import { refreshCatalog, drainNotifications, drainDeletions } from '../src/maintenance';
import { getCover } from '../src/covers';
import { Telegram, channelLink, summaryLink } from '../src/telegram';
import handler, { drainInbox } from '../src/index';
import { now, type Book, type Env } from '../src/types';

let mf: Miniflare; let env: Env; let catalog: Book[];
const row = (title: string, author = 'Author', publisher = 'Quality Publishing House') =>
  ['2025/01/01', publisher, 'January', 'https://drive.google.com/file/d/cover123/view', author, title, '1', 'Fiction', '1000', 'Summary'];
const csv = (rows: string[][]) => ['timestamp,publisher,month,image,author,title,edition,genre,price,description', '',
  ...rows.map(r => r.map(v => '"' + v.replaceAll('"', '""') + '"').join(','))].join('\r\n');
const chat = { id: 1, type: 'private' };
const context = () => { const work: Promise<unknown>[] = []; return {
  ctx: { waitUntil: (promise: Promise<unknown>) => work.push(promise), passThroughOnException() {}, props: {} } as unknown as ExecutionContext,
  done: () => Promise.all(work),
}; };
beforeAll(async () => {
  mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok"); } }',
    compatibilityDate: '2025-09-27', d1Databases: ['DB'], r2Buckets: ['COVERS'] });
  env = { DB: await mf.getD1Database('DB'), COVERS: await mf.getR2Bucket('COVERS'),
    TELEGRAM_BOT_TOKEN: 'fake', TELEGRAM_WEBHOOK_SECRET: 'test_secret', TELEGRAM_OWNER_ID: '1',
    BOT_USERNAME: 'test_bot', WARM_COVERS_PER_TICK: '0', NOTIFICATION_BATCH: '1' } as unknown as Env;
  for (const file of ['0001_schema.sql', '0002_publisher_links.sql']) {
    const statements = readFileSync(new URL('../migrations/' + file, import.meta.url), 'utf8')
      .split('\n').filter(line => !line.trim().startsWith('--')).join('\n').split(';').map(s => s.trim()).filter(Boolean);
    await env.DB.batch(statements.map(s => env.DB.prepare(s)));
  }
  catalog = await parseBooks(csv([row('Book One'), row('Book Two')]));
});
afterAll(async () => { vi.restoreAllMocks(); await mf.dispose(); });

describe('catalog parity', () => {
  it('normalizes punctuation, full-width Latin, spaces and Myanmar consistently', () => {
    expect(normalize(' ＢＲＯ - Code! ')).toBe('brocode');
    expect(normalize('တင် မောင် မြင့်')).toBe(normalize('တင်မောင်မြင့်'));
    expect(normalize('Straße')).toBe('strasse');
  });
  it('handles BOM, quoted multiline CSV and incomplete/deduplicated rows', async () => {
    expect(parseCSV('\uFEFFa,b\r\n"x,y","line\n""two"""')).toEqual([['a', 'b'], ['x,y', 'line\n"two"']]);
    const incomplete = row('Invalid'); incomplete[8] = '';
    const books = await parseBooks(csv([row('Book One'), row('Book One'), incomplete, row('Myanmar', 'Author', 'Little Yangon Publcation')]));
    expect(books).toHaveLength(2); expect(books[1].publisher).toBe('Little Yangon Publication');
  });
  it('does not lose a valid second row without a spacer', async () => {
    expect(await parseBooks(csv([row('First')]).replace('\r\n\r\n', '\r\n'))).toHaveLength(1);
  });
  it('uses stable IDs independent of row order and ranks exact title above publisher', async () => {
    expect(await stableBookId('Book-One', 'Author')).toBe(await stableBookId('book one', 'AUTHOR'));
    expect(search(catalog, 'Book One')[0].title).toBe('Book One');
    expect(search(catalog, 'Quality')).toHaveLength(2);
  });
  it('validates publisher URLs and stable summary deep links', () => {
    expect(channelLink('@example')).toBe('https://t.me/example');
    expect(channelLink('t.me/+invite')).toBe('https://t.me/+invite');
    expect(channelLink('javascript:alert(1)')).toBeNull();
    expect(summaryLink(env, catalog[0].id)).toContain('summary_' + catalog[0].id);
  });
});
describe('group routing and administration', () => {
  it('ignores unaddressed commands/text and requires a real @mention or /get', () => {
    const group = { id: -1, type: 'supergroup' };
    expect(addressedText('test_bot Book', group, 'test_bot')).toBeNull();
    expect(addressedText('/books', group, 'test_bot')).toBeNull();
    expect(addressedText('@test_bot_other Book', group, 'test_bot')).toBeNull();
    expect(addressedText('@test_bot Book', group, 'test_bot')).toBe('Book');
    expect(addressedText('/get Book', group, 'test_bot')).toBe('/get Book');
    expect(addressedText('/books@test_bot', group, 'test_bot')).toBe('/books@test_bot');
  });
  it('fails closed if owner ID is missing and preserves explicit unsubscribe', async () => {
    const text = vi.spyOn(Telegram.prototype, 'text').mockResolvedValue({ message_id: 9, chat });
    await handleUpdate({ ...env, TELEGRAM_OWNER_ID: undefined }, { update_id: 20,
      message: { message_id: 1, chat, text: '/usage', from: { id: 1 } } });
    expect(text.mock.calls.at(-1)?.[1]).toContain('ပိုင်ရှင်');
    await handleUpdate(env, { update_id: 21, message: { message_id: 2, chat, text: '/unsubscribe', from: { id: 1 } } });
    await handleUpdate(env, { update_id: 22, message: { message_id: 3, chat, text: '/stats', from: { id: 1 } } });
    expect(await env.DB.prepare('SELECT enabled FROM subscribers WHERE chat_id=?').bind('1').first<number>('enabled')).toBe(0);
    text.mockRestore();
  });
});
describe('Telegram transport safety', () => {
  it('does not leak a token-bearing URL from a fetch failure', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('failed https://api.telegram.org/botfake/sendMessage'));
    await expect(new Telegram(env).call('sendMessage', {})).rejects.toThrow('Telegram sendMessage network request failed');
    fetchMock.mockRestore();
  });
});
describe('D1 durable state and refresh/outbox', () => {
  it('atomically initializes a catalog without announcing existing books', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(csv([row('Book One'), row('Book Two')])));
    const result = await refreshCatalog(env);
    expect(result).toEqual({ count: 2, newCount: 0 });
    expect(await env.DB.prepare('SELECT COUNT(*) n FROM outbox').first<number>('n')).toBe(0);
    fetchMock.mockRestore();
  });
  it('detects new books once, retains removed rows/old links, and honors subscriber opt-out', async () => {
    await env.DB.prepare('INSERT OR REPLACE INTO subscribers(chat_id,enabled,updated_at) VALUES(?,?,?)').bind('1', 1, now()).run();
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValue(new Response(csv([row('Book One'), row('New Book')])));
    expect((await refreshCatalog(env)).newCount).toBe(1);
    const removed = await byId(env, catalog[1].id); expect(removed?.active).toBe(0);
    fetchMock.mockResolvedValue(new Response(csv([row('Book One'), row('New Book')])));
    expect((await refreshCatalog(env)).newCount).toBe(0);
    expect(await env.DB.prepare('SELECT COUNT(*) n FROM outbox').first<number>('n')).toBe(1);
    await env.DB.prepare('UPDATE subscribers SET enabled=0 WHERE chat_id=?').bind('1').run();
    const card = vi.spyOn(Telegram.prototype, 'card');
    await drainNotifications(env); expect(card).not.toHaveBeenCalled();
    expect(await env.DB.prepare('SELECT status FROM outbox LIMIT 1').first<string>('status')).toBe('skipped');
    card.mockRestore(); fetchMock.mockRestore();
  });
  it('delivers a pending notification and respects Telegram retry_after', async () => {
    await env.DB.prepare('UPDATE subscribers SET enabled=1 WHERE chat_id=?').bind('1').run();
    await env.DB.prepare(`INSERT INTO outbox(dedupe_key,chat_id,chat_type,book_id,created_at) VALUES('delivery-test','1','private',?,?)`)
      .bind(catalog[0].id, now()).run();
    const card = vi.spyOn(Telegram.prototype, 'card').mockResolvedValue({ message_id: 61, chat });
    await drainNotifications(env);
    expect(await env.DB.prepare("SELECT status FROM outbox WHERE dedupe_key='delivery-test'").first<string>('status')).toBe('done');
    await env.DB.prepare(`INSERT INTO outbox(dedupe_key,chat_id,chat_type,book_id,created_at) VALUES('flood-test','1','private',?,?)`)
      .bind(catalog[0].id, now()).run();
    card.mockRejectedValueOnce(new (await import('../src/telegram')).TelegramError(429, 'Too Many Requests', 60));
    await drainNotifications(env);
    const pending = await env.DB.prepare("SELECT status,available_at FROM outbox WHERE dedupe_key='flood-test'")
      .first<{status: string; available_at: number}>();
    expect(pending?.status).toBe('pending'); expect(pending?.available_at).toBeGreaterThan(now() + 50);
    await env.DB.prepare("UPDATE outbox SET status='skipped' WHERE dedupe_key='flood-test'").run();
    await env.DB.prepare("DELETE FROM meta WHERE key='telegram_backoff'").run();
    card.mockRestore();
  });
  it('returns safe inline article results with DM summary/order buttons when no photo cache exists', async () => {
    const call = vi.spyOn(Telegram.prototype, 'call').mockResolvedValue(true);
    await handleUpdate(env, { update_id: 29, inline_query: { id: 'inline', query: 'Book', offset: '', from: { id: 2 } } });
    const payload = call.mock.calls.at(-1)?.[1] as {results: {type: string; reply_markup?: {inline_keyboard: {url?: string}[][]}}[]};
    expect(payload.results.length).toBeGreaterThan(0); expect(payload.results.length).toBeLessThanOrEqual(10);
    expect(payload.results[0].type).toBe('article');
    expect(payload.results[0].reply_markup?.inline_keyboard[0][0].url).toContain('start=summary_');
    call.mockRestore();
  });
  it('retains last-good catalog on an invalid/empty export', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<html>sign in</html>'));
    await expect(refreshCatalog(env)).rejects.toThrow('no complete book');
    expect(await env.DB.prepare('SELECT COUNT(*) n FROM books WHERE active=1').first<number>('n')).toBe(2);
    fetchMock.mockRestore();
  });
  it('persists list state keyed by both chat and message and supports any member pagination', async () => {
    const sentChat = { id: -42, type: 'supergroup' }; const text = vi.spyOn(Telegram.prototype, 'text').mockResolvedValue({ message_id: 50, chat: sentChat });
    await handleUpdate(env, { update_id: 30, message: { message_id: 1, chat: sentChat, text: '/books@test_bot', from: { id: 2 } } });
    const state = await env.DB.prepare('SELECT state FROM search_states WHERE chat_id=? AND message_id=50').bind('-42').first<string>('state');
    expect(JSON.parse(state!).results).toHaveLength(2);
    const call = vi.spyOn(Telegram.prototype, 'call').mockResolvedValue(true); const edit = vi.spyOn(Telegram.prototype, 'edit').mockResolvedValue();
    await handleUpdate(env, { update_id: 31, callback_query: { id: 'callback', data: 'page:next', from: { id: 3 }, message: { message_id: 50, chat: sentChat } } });
    expect(edit).toHaveBeenCalled();
    call.mockRestore(); edit.mockRestore(); text.mockRestore();
  });
  it('processes persisted delete jobs and clears pagination state', async () => {
    await env.DB.prepare('INSERT OR REPLACE INTO deletions(chat_id,message_id,due_at) VALUES(?,50,0)').bind('-42').run();
    const del = vi.spyOn(Telegram.prototype, 'delete').mockResolvedValue();
    await drainDeletions(env);
    expect(del).toHaveBeenCalledWith({ id: '-42', type: 'supergroup' }, 50);
    expect(await env.DB.prepare('SELECT state FROM search_states WHERE chat_id=?').bind('-42').first()).toBeNull();
    del.mockRestore();
  });
  it('caches validated JPEG bytes in R2 and serves cache on repeat read', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new Uint8Array([255,216,255,0,1])));
    expect((await getCover(env, 'cover123'))?.type).toBe('image/jpeg');
    expect(await getCover(env, 'cover123')).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1); fetchMock.mockRestore();
  });
  it('recognizes imported known-book state as a baseline on first Worker refresh', async () => {
    await env.DB.prepare("DELETE FROM meta WHERE key='catalog_initialized'").run();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(csv([row('Book One'), row('New Book'), row('Post Cutover Book')])));
    const result = await refreshCatalog(env);
    expect(result.newCount).toBe(1);
    fetchMock.mockRestore();
  });
});
describe('webhook durable ingestion', () => {
  it('rejects missing or invalid secret and accepts health checks', async () => {
    const work = context();
    expect((await handler.fetch(new Request('https://bot/health'), env, work.ctx)).status).toBe(200);
    expect((await handler.fetch(new Request('https://bot/webhook', { method: 'POST', body: '{}' }), env, work.ctx)).status).toBe(401);
  });
  it('deduplicates updates and drains a durable inbox without real Telegram credentials', async () => {
    await env.DB.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('bot_username','test_bot')").run();
    const make = () => new Request('https://bot/webhook', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 'test_secret' },
      body: JSON.stringify({ update_id: 999, my_chat_member: { chat: { id: -9, type: 'group' }, new_chat_member: { status: 'member' } } }) });
    const work = context(); expect((await handler.fetch(make(), env, work.ctx)).status).toBe(200); await work.done();
    const repeat = context(); await handler.fetch(make(), env, repeat.ctx); await repeat.done();
    expect(await env.DB.prepare('SELECT COUNT(*) n FROM inbox WHERE update_id=999').first<number>('n')).toBe(1);
    expect(await env.DB.prepare('SELECT attempts FROM inbox WHERE update_id=999').first<number>('attempts')).toBe(1);
    expect(await env.DB.prepare('SELECT chat_id FROM groups WHERE chat_id=?').bind('-9').first()).not.toBeNull();
  });
});
