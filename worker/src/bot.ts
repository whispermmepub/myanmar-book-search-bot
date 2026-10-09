import { allBooks, byId, canonicalPublisher, normalize, publisherList, search } from './catalog';
import { autoSubscribe, lease, loadState, markActive, meta, release, rememberGroup, saveState, scheduleDelete, subscribe } from './db';
import { enqueueDemo, migrateGroup } from './maintenance';
import { buildCaption, cardKeyboard, channelLink, Telegram, TelegramError } from './telegram';
import { clip, id, isGroup, now, setting, type Book, type Callback, type Chat, type Env, type ListState, type Markup, type Message, type Update } from './types';

const PAGE_SIZE = 10;
const OWNER_COMMANDS = new Set(['usage', 'refresh', 'addpublisher', 'demo']);
export function addressedText(text: string, chat: Chat, username: string): string | null {
  if (!isGroup(chat)) return text.trim();
  if (/^\/get(?:\s|$)/i.test(text.trim())) return text.trim();
  const escaped = username.replace(/^@/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const mention = new RegExp(`@${escaped}(?![a-zA-Z0-9_])`, 'i');
  if (!mention.test(text)) return null;
  // Preserve /command@bot routing; strip other addressing mentions from ordinary searches.
  if (/^\/[a-z_]+@/i.test(text.trim())) return text.trim();
  return text.replace(new RegExp(`@${escaped}(?![a-zA-Z0-9_])`, 'gi'), ' ').replace(/\s+/g, ' ').trim();
}
function command(text: string, username: string): {name: string; args: string} | null {
  const match = /^\/([a-z_]+)(?:@([a-zA-Z0-9_]+))?(?:\s+([\s\S]*))?$/i.exec(text);
  if (!match || (match[2] && match[2].toLowerCase() !== username.replace(/^@/, '').toLowerCase())) return null;
  return { name: match[1].toLowerCase(), args: (match[3] ?? '').trim() };
}
function helpText(env: Env): string {
  const username = env.BOT_USERNAME ?? 'saroatsarpay_bot';
  return `မင်္ဂလာပါ!\n\nစာအုပ်အမည် (သို့) စာရေးသူအမည် ရိုက်ထည့်ပြီး ရှာနိုင်ပါတယ်။ Space ပါပါ၊ မပါပါ ရှာလို့ရပါတယ်။\n\nPrivate: နာမည်ရိုက်ရုံပါပဲ\nGroup: @${username} နာမည် (သို့) /get နာမည်\nGroup command: /books@${username}\nInline: @${username} နာမည်\n\n/books — စာအုပ်အားလုံး\n/publishers — စာအုပ်တိုက်အားလုံး\n/stats — စာအုပ်အရေအတွက် / နောက်ဆုံး refresh\n/subscribe — DM အသိပေးချက် ရယူရန်\n/unsubscribe — DM အသိပေးချက် ရပ်ရန်\n/usage, /refresh, /addpublisher <တိုက်နာမည်> <link>, /demo — owner သာ\n\nဥပမာ: မြစ်ရိုင်း၊ bro code၊ တင်မောင်မြင့်`;
}
function total(state: ListState): number { return state.mode === 'publishers' ? state.publishers?.length ?? 0 : state.results.length; }
function listText(state: ListState): string {
  const count = total(state); const pages = Math.max(1, Math.ceil(count / PAGE_SIZE));
  const title = state.mode === 'publishers' ? `စာအုပ်တိုက် စုစုပေါင်း ${count} ခု` :
    state.mode === 'allbooks' ? `စာအုပ်အားလုံး — စုစုပေါင်း ${count} ခု` :
    state.mode === 'pubbooks' ? `${state.query} တိုက်ရဲ့ စာအုပ် ${count} ခု` : `${state.query} အတွက် စာအုပ် ${count} ခု တွေ့ပါတယ်။`;
  return `${clip(title, 3000)}\nမျက်နှာ ${state.page + 1}/${pages}\n\nကြည့်ချင်တဲ့ ${state.mode === 'publishers' ? 'တိုက်' : 'စာအုပ်'}ကို ရွေးပါ။`;
}
async function listKeyboard(env: Env, state: ListState): Promise<Markup> {
  const start = state.page * PAGE_SIZE; const rows: Markup['inline_keyboard'] = [];
  if (state.mode === 'publishers') {
    for (const [i, [name, count]] of (state.publishers ?? []).slice(start, start + PAGE_SIZE).entries())
      rows.push([{ text: clip(`${name} (${count})`, 100), callback_data: `pub:${start + i}` }]);
  } else {
    const bookIds = state.results.slice(start, start + PAGE_SIZE);
    for (const bookId of bookIds) {
      const book = await byId(env, bookId);
      if (book) rows.push([{ text: clip(`${book.title} — ${book.author}`, 100), callback_data: `book:${book.id}` }]);
    }
  }
  const pages = Math.max(1, Math.ceil(total(state) / PAGE_SIZE)); const nav = [];
  if (state.page > 0) nav.push({ text: 'ရှေ့မျက်နှာ', callback_data: 'page:prev' });
  nav.push({ text: `${state.page + 1}/${pages}`, callback_data: 'page:none' });
  if (state.page < pages - 1) nav.push({ text: 'နောက်မျက်နှာ', callback_data: 'page:next' });
  rows.push(nav); return { inline_keyboard: rows };
}
async function sendList(env: Env, chat: Chat, state: ListState): Promise<void> {
  const sent = await new Telegram(env).text(chat, listText(state), await listKeyboard(env, state));
  await saveState(env, chat, sent.message_id, state);
}
async function doSearch(env: Env, message: Message, query: string): Promise<void> {
  if (message.from) await markActive(env, message.from.id, false, true);
  const books = search(await allBooks(env), clip(query, 1000));
  if (!books.length) { await new Telegram(env).text(message.chat, 'ဒီစာအုပ် (သို့) စာရေးသူ မတွေ့ပါဘူး။ နာမည် အနည်းငယ်ပဲ ရိုက်ကြည့်ပါ။'); return; }
  await sendList(env, message.chat, { mode: 'search', query: clip(query, 1000), results: books.map(b => b.id), page: 0 });
}
async function usageText(env: Env): Promise<string> {
  const today = new Date().toISOString().slice(0, 10);
  const cutoff = new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10);
  const row = await env.DB.prepare(`SELECT
    (SELECT COUNT(*) FROM usage_users WHERE started=1) starters,
    (SELECT COUNT(*) FROM subscribers WHERE enabled=1) subscribers,
    (SELECT COUNT(*) FROM groups) groups,
    (SELECT COUNT(*) FROM usage_days WHERE day=?) today,
    (SELECT COUNT(DISTINCT user_id) FROM usage_days WHERE day>=?) week,
    (SELECT value FROM counters WHERE key='search_count') searches,
    (SELECT COUNT(*) FROM usage_users WHERE searches>0) searchers,
    (SELECT COUNT(*) FROM outbox WHERE status='pending') pending,
    (SELECT COUNT(*) FROM outbox WHERE status='failed') failed,
    (SELECT COUNT(*) FROM inbox WHERE status='failed') inbox_failed`).bind(today, cutoff).first<Record<string, number>>();
  return `သုံးစွဲမှု အချက်အလက် (UTC)\n\n/start လုပ်ထားသူ: ${row?.starters}\nSubscriber: ${row?.subscribers}\nဒီနေ့ အသုံးပြုသူ: ${row?.today}\nပြီးခဲ့တဲ့ ၇ ရက်: ${row?.week}\nရှာဖွေမှု စုစုပေါင်း: ${row?.searches} (${row?.searchers} ဦး)\nGroup: ${row?.groups}\nအသိပေးရန် queue: ${row?.pending}\nမပို့နိုင်သော notifications: ${row?.failed}\nမအောင်မြင်သော updates: ${row?.inbox_failed}`;
}
async function addPublisher(env: Env, message: Message, args: string): Promise<void> {
  const telegram = new Telegram(env); const parts = args.split(/\s+/).filter(Boolean);
  // Accept plain Telegram username as final argument, and multi-word publisher names.
  const rawLink = parts.pop() ?? ''; const url = channelLink(rawLink);
  let name = canonicalPublisher(parts.join(' '));
  if (!name && url) {
    const bookId = await env.DB.prepare('SELECT last_book_id FROM chat_state WHERE chat_id=?').bind(id(message.chat.id)).first<string>('last_book_id');
    const book = bookId && await byId(env, bookId); name = book ? book.publisher : '';
  }
  if (!name || !url) { await telegram.text(message.chat, 'ဥပမာ: /addpublisher နှစ်ကာလများ https://t.me/theerasbookpublishing\nစာအုပ်တိုက်နာမည် + လင့် ရိုက်ထည့်ပါ။'); return; }
  await env.DB.prepare(`INSERT INTO publisher_links(name,name_n,url,updated_at) VALUES(?,?,?,?)
    ON CONFLICT(name) DO UPDATE SET name_n=excluded.name_n,url=excluded.url,updated_at=excluded.updated_at`)
    .bind(name, normalize(name), url, now()).run();
  await telegram.text(message.chat, `${name} ရဲ့ မှာယူရန် link ထည့်/ပြင်ပြီးပါပြီ။\n${url}`);
}
async function handleMessage(env: Env, message: Message, updateId: number): Promise<void> {
  await rememberGroup(env, message.chat);
  if (message.migrate_to_chat_id) { await migrateGroup(env, id(message.chat.id), id(message.migrate_to_chat_id)); return; }
  if (message.migrate_from_chat_id) { await migrateGroup(env, id(message.migrate_from_chat_id), id(message.chat.id)); return; }
  if (!message.text || message.from?.is_bot) return;
  const username = env.BOT_USERNAME ?? 'saroatsarpay_bot';
  const text = addressedText(message.text, message.chat, username); if (text === null) return;
  const cmd = command(text, username); const telegram = new Telegram(env);
  if (message.from) await markActive(env, message.from.id);
  await autoSubscribe(env, message.chat);
  if (!cmd) {
    if (text.startsWith('/')) return;
    if (!text) await telegram.text(message.chat, `စာအုပ်နာမည် (သို့) စာရေးသူနာမည် ရိုက်ပါ။ ဥပမာ: @${username} မြစ်ရိုင်း`);
    else await doSearch(env, message, text);
    return;
  }
  // Owner privileges fail closed: missing TELEGRAM_OWNER_ID never makes administration public.
  if (OWNER_COMMANDS.has(cmd.name) && (!env.TELEGRAM_OWNER_ID || id(message.from?.id ?? '') !== env.TELEGRAM_OWNER_ID)) {
    await telegram.text(message.chat, 'ဒီ command ကို bot ပိုင်ရှင်သာ သုံးနိုင်ပါတယ်။'); return;
  }
  switch (cmd.name) {
    case 'start': case 'help':
      if (message.chat.type === 'private') {
        await subscribe(env, message.chat, true);
        if (message.from) await markActive(env, message.from.id, true);
      }
      if (cmd.args.startsWith('summary_')) {
        if (message.chat.type !== 'private') { await telegram.text(message.chat, 'အညွှန်းကို bot ရဲ့ DM မှာ ဖတ်နိုင်ပါတယ်။'); return; }
        const book = await byId(env, cmd.args.slice(8));
        if (!book) await telegram.text(message.chat, 'ဒီစာအုပ် အချက်အလက် မရှိတော့ပါ။ ထပ်ရှာကြည့်ပါ။');
        else await telegram.summary(message.chat, book);
      } else await telegram.text(message.chat, helpText(env));
      break;
    case 'stats': {
      const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM books WHERE active=1').first<number>('n');
      const loaded = Number(await meta(env, 'loaded_at') ?? 0); const error = await meta(env, 'refresh_error');
      await telegram.text(message.chat, `စုစုပေါင်း စာအုပ်: ${count} ခု\nနောက်ဆုံး refresh: ${loaded ? new Date(loaded * 1000).toISOString() : 'မရသေးပါ'} (UTC)\nအလိုအလျောက် refresh: ${setting(env.REFRESH_HOURS, 6)} နာရီတစ်ခါ${error ? '\nနောက်ဆုံး refresh မအောင်မြင်ပါ။ ယခင် data ကို သုံးထားပါတယ်။' : ''}`); break;
    }
    case 'usage': await telegram.text(message.chat, await usageText(env)); break;
    case 'refresh': {
      const sent = await telegram.text(message.chat, 'စာအုပ်စာရင်း ပြန်ဆွဲရန် စာရင်းသွင်းပြီးပါပြီ။ နောက် cron tick (တစ်မိနစ်ခန့်) မှာ ဆောင်ရွက်ပါမယ်။');
      await env.DB.prepare('INSERT OR IGNORE INTO refresh_requests(chat_id,message_id,chat_type,created_at) VALUES(?,?,?,?)')
        .bind(id(message.chat.id), sent.message_id, message.chat.type, now()).run(); break;
    }
    case 'get': if (cmd.args) await doSearch(env, message, cmd.args); else await telegram.text(message.chat, 'ဥပမာ: /get မြစ်ရိုင်း (သို့) /get တင်မောင်မြင့်'); break;
    case 'addpublisher': await addPublisher(env, message, cmd.args); break;
    case 'books': case 'publishers': {
      const books = await allBooks(env);
      if (!books.length) { await telegram.text(message.chat, 'စာအုပ် အချက်အလက် မရသေးပါ။ Cron refresh ကို စောင့်ပါ (သို့) owner က /refresh သုံးပါ။'); break; }
      await sendList(env, message.chat, { mode: cmd.name === 'books' ? 'allbooks' : 'publishers', query: '',
        results: cmd.name === 'books' ? books.map(b => b.id) : [], publishers: cmd.name === 'publishers' ? publisherList(books) : undefined, page: 0 }); break;
    }
    case 'subscribe': case 'unsubscribe':
      if (message.chat.type !== 'private') await telegram.text(message.chat, 'ဒီ command ကို bot ရဲ့ DM မှာသာ သုံးလို့ရပါတယ်။');
      else { await subscribe(env, message.chat, cmd.name === 'subscribe'); await telegram.text(message.chat, cmd.name === 'subscribe' ? 'စာအုပ်အသစ် ရောက်လာတိုင်း ဒီ DM ထဲ အသိပေးပါမယ်။ ရပ်ချင်ရင် /unsubscribe ရိုက်ပါ။' : 'အသိပေးချက် ရပ်လိုက်ပါပြီ။ /subscribe ဖြင့် ပြန်ဖွင့်နိုင်ပါတယ်။'); }
      break;
    case 'demo': {
      const books = await allBooks(env);
      if (!books.length) await telegram.text(message.chat, 'စာအုပ် အချက်အလက် မရသေးပါ။');
      else { const book = books[Math.floor(Math.random() * books.length)]; await enqueueDemo(env, book, message.chat, updateId); await telegram.text(message.chat, `Demo ပို့ရန် queue ထဲ ထည့်ထားပါပြီ။\nစာအုပ်: ${book.title}`); } break;
    }
  }
}
async function removeSummaries(env: Env, chat: Chat, cardId: number): Promise<void> {
  const rows = (await env.DB.prepare('SELECT message_ids FROM summary_views WHERE chat_id=? AND card_id=?').bind(id(chat.id), cardId).all<{message_ids: string}>()).results;
  const telegram = new Telegram(env);
  for (const row of rows) for (const mid of JSON.parse(row.message_ids) as number[]) {
    try { await telegram.delete(chat, mid); } catch { /* Missing or already removed summary. */ }
  }
  await env.DB.prepare('DELETE FROM summary_views WHERE chat_id=? AND card_id=?').bind(id(chat.id), cardId).run();
}
async function handleCallback(env: Env, cb: Callback): Promise<void> {
  const telegram = new Telegram(env);
  try { await telegram.call('answerCallbackQuery', { callback_query_id: cb.id }); }
  catch (err) { if (!(err instanceof TelegramError && err.code === 400)) throw err; }
  await markActive(env, cb.from.id);
  if (!cb.message || !cb.data || cb.data === 'page:none') return;
  const chat = cb.message.chat; const data = cb.data; const mid = cb.message.message_id;
  if (data.startsWith('summary:')) {
    // A group card always uses a DM link. Reject forged/stale group summary callbacks.
    if (chat.type !== 'private') { await telegram.text(chat, 'အညွှန်းကို bot ရဲ့ DM မှာ ဖတ်ပါ။'); return; }
    const key = `summary:${id(chat.id)}:${mid}`; const owner = await lease(env, key, 120); if (!owner) return;
    try {
      const book = await byId(env, data.slice(8)); if (!book) { await telegram.text(chat, 'စာအုပ် အချက်အလက် မရှိတော့ပါ။'); return; }
      await removeSummaries(env, chat, mid);
      const parent = await env.DB.prepare("SELECT message_id FROM search_states WHERE chat_id=? AND json_extract(state,'$.cardId')=? AND expires_at>?")
        .bind(id(chat.id), mid, now()).first<{message_id: number}>();
      const markup = parent ? { inline_keyboard: [[{ text: 'စာရင်းပြန်ကြည့်မယ်', callback_data: `back:${parent.message_id}` }]] } : undefined;
      const mids = await telegram.summary(chat, book, markup);
      await env.DB.prepare('INSERT OR REPLACE INTO summary_views(chat_id,card_id,book_id,message_ids,expires_at) VALUES(?,?,?,?,?)')
        .bind(id(chat.id), mid, book.id, JSON.stringify(mids), now() + setting(env.STATE_TTL_HOURS, 168) * 3600).run();
    } finally { await release(env, key, owner); }
    return;
  }
  const stateMid = data.startsWith('back:') ? Number(data.slice(5)) : mid;
  if (!Number.isSafeInteger(stateMid) || stateMid <= 0) return;
  const key = `list:${id(chat.id)}:${stateMid}`; const owner = await lease(env, key, 120); if (!owner) return;
  try {
    const state = await loadState(env, chat, stateMid);
    if (!state) { await telegram.text(chat, 'ရှာဖွေမှု ပြန်လုပ်ပါ။ /books (သို့) /publishers'); return; }
    if (data === 'page:next' || data === 'page:prev') {
      const pages = Math.max(1, Math.ceil(total(state) / PAGE_SIZE));
      state.page = Math.max(0, Math.min(pages - 1, state.page + (data === 'page:next' ? 1 : -1)));
      await telegram.edit(chat, stateMid, listText(state), await listKeyboard(env, state));
      await saveState(env, chat, stateMid, state);
    } else if (data.startsWith('pub:') && state.mode === 'publishers') {
      const index = Number(data.slice(4)); if (!Number.isSafeInteger(index)) return;
      const publisher = state.publishers?.[index]?.[0]; if (!publisher) return;
      const books = (await allBooks(env)).filter(b => b.publisher === publisher);
      await sendList(env, chat, { mode: 'pubbooks', query: publisher, results: books.map(b => b.id), page: 0 });
    } else if (data.startsWith('back:')) {
      if (state.cardId) { await removeSummaries(env, chat, state.cardId); try { await telegram.delete(chat, state.cardId); } catch { /* Already removed. */ } }
      delete state.cardId; delete state.currentBookId;
      await saveState(env, chat, stateMid, state);
      await telegram.edit(chat, stateMid, listText(state), await listKeyboard(env, state));
    } else if (data.startsWith('book:')) {
      const bookId = data.slice(5); if (!state.results.includes(bookId) || state.currentBookId === bookId) return;
      const book = await byId(env, bookId); if (!book) return;
      if (state.cardId) { await removeSummaries(env, chat, state.cardId); try { await telegram.delete(chat, state.cardId); } catch { /* Already removed. */ } }
      const card = await telegram.card(chat, book, stateMid);
      state.cardId = card.message_id; state.currentBookId = book.id;
      await saveState(env, chat, stateMid, state); await scheduleDelete(env, chat, stateMid);
    }
  } finally { await release(env, key, owner); }
}
async function handleInline(env: Env, query: NonNullable<Update['inline_query']>): Promise<void> {
  const telegram = new Telegram(env); const text = query.query.trim();
  if (!text) { await telegram.call('answerInlineQuery', { inline_query_id: query.id, results: [], cache_time: 5, is_personal: true }); return; }
  await markActive(env, query.from.id, false, true);
  const books = search(await allBooks(env), text); const offset = /^\d+$/.test(query.offset) ? Math.min(100, Number(query.offset)) : 0;
  const page = books.slice(offset, offset + 10); const items = [];
  // Ten results per inline page; Telegram permits at most fifty, never send the old 100-result response.
  for (const book of page) {
    const cached = await env.DB.prepare('SELECT file_id,cached FROM cover_cache WHERE image_id=?').bind(book.image_id).first<{file_id: string | null; cached: number}>();
    const common = { id: book.id, title: clip(book.title, 200), description: clip(`${book.author} • ${book.publisher} • ${book.price}`, 400),
      reply_markup: await cardKeyboard(env, { id: 'inline', type: 'inline' }, book) };
    if (cached?.file_id) items.push({ ...common, type: 'photo', photo_file_id: cached.file_id, caption: clip(buildCaption(book), 1024) });
    else if (env.PUBLIC_BASE_URL && env.COVERS && cached?.cached === 1) {
      const url = `${env.PUBLIC_BASE_URL.replace(/\/$/, '')}/covers/${book.image_id}`;
      items.push({ ...common, type: 'photo', photo_url: url, thumbnail_url: url, caption: clip(buildCaption(book), 1024) });
    } else items.push({ ...common, type: 'article', input_message_content: { message_text: clip(buildCaption(book), 4096), link_preview_options: { is_disabled: true } } });
  }
  await telegram.call('answerInlineQuery', { inline_query_id: query.id, results: items, cache_time: 60, is_personal: true,
    next_offset: offset + page.length < books.length ? String(offset + page.length) : '' });
}
export async function handleUpdate(env: Env, update: Update): Promise<void> {
  if (update.my_chat_member) {
    const { chat, new_chat_member: member } = update.my_chat_member;
    if (isGroup(chat)) {
      if (['member', 'administrator', 'restricted'].includes(member.status)) await rememberGroup(env, chat);
      else if (['left', 'kicked'].includes(member.status)) await env.DB.prepare('DELETE FROM groups WHERE chat_id=?').bind(id(chat.id)).run();
    } else if (chat.type === 'private' && member.status === 'kicked') await subscribe(env, chat, false);
  } else if (update.message) await handleMessage(env, update.message, update.update_id);
  else if (update.callback_query) await handleCallback(env, update.callback_query);
  else if (update.inline_query) await handleInline(env, update.inline_query);
}
