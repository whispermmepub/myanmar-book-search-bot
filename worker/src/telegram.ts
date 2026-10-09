import { canonicalPublisher, normalize } from './catalog';
import { scheduleDelete } from './db';
import { getCover } from './covers';
import { clip, id, isGroup, now, type Book, type Chat, type Env, type Markup, type Message } from './types';

export class TelegramError extends Error {
  constructor(public code: number, description: string, public retryAfter?: number, public migrateTo?: number) {
    super(description); this.name = 'TelegramError';
  }
}
export class Telegram {
  constructor(private env: Env) {}
  async call<T = unknown>(method: string, payload: Record<string, unknown> | FormData): Promise<T> {
    const form = payload instanceof FormData;
    let response: Response;
    try {
      response = await fetch(`https://api.telegram.org/bot${this.env.TELEGRAM_BOT_TOKEN}/${method}`, {
        method: 'POST', headers: form ? undefined : { 'Content-Type': 'application/json' },
        body: form ? payload : JSON.stringify(payload), signal: AbortSignal.timeout(8000),
      });
    } catch { throw new Error(`Telegram ${method} network request failed`); }
    let data: { ok: boolean; result: T; error_code?: number; description?: string;
      parameters?: { retry_after?: number; migrate_to_chat_id?: number } };
    try { data = await response.json(); }
    catch { throw new Error(`Telegram ${method} returned a non-JSON response`); }
    if (!data.ok) throw new TelegramError(data.error_code ?? response.status, data.description ?? `${method} failed`,
      data.parameters?.retry_after, data.parameters?.migrate_to_chat_id);
    return data.result;
  }
  async text(chat: Chat, text: string, markup?: Markup): Promise<Message> {
    const sent = await this.call<Message>('sendMessage', { chat_id: id(chat.id), text: clip(text, 4096),
      reply_markup: markup, link_preview_options: { is_disabled: true } });
    await scheduleDelete(this.env, chat, sent.message_id); return sent;
  }
  async edit(chat: Chat, messageId: number, text: string, markup?: Markup): Promise<void> {
    try {
      await this.call('editMessageText', { chat_id: id(chat.id), message_id: messageId,
        text: clip(text, 4096), reply_markup: markup, link_preview_options: { is_disabled: true } });
    } catch (err) {
      if (!(err instanceof TelegramError && err.message.includes('message is not modified'))) throw err;
    }
    await scheduleDelete(this.env, chat, messageId);
  }
  async delete(chat: Chat, messageId: number): Promise<void> {
    await this.call('deleteMessage', { chat_id: id(chat.id), message_id: messageId });
  }
  async card(chat: Chat, book: Book, stateMessageId?: number, announcement = false): Promise<Message> {
    const caption = clip((announcement ? 'စာအုပ်အသစ် ရောက်ရှိပါပြီ!\n\n' : '') + buildCaption(book), 1024);
    const markup = await cardKeyboard(this.env, chat, book, stateMessageId);
    const cached = await this.env.DB.prepare('SELECT file_id FROM cover_cache WHERE image_id=?').bind(book.image_id).first<{file_id: string | null}>();
    let sent: Message | undefined;
    if (cached?.file_id) {
      try { sent = await this.call<Message>('sendPhoto', { chat_id: id(chat.id), photo: cached.file_id, caption, reply_markup: markup }); }
      catch (err) {
        if (!(err instanceof TelegramError && err.code === 400 && !err.migrateTo)) throw err;
        await this.env.DB.prepare('UPDATE cover_cache SET file_id=NULL WHERE image_id=?').bind(book.image_id).run();
      }
    }
    if (!sent) {
      const cover = await getCover(this.env, book.image_id);
      if (cover) {
        const form = new FormData(); form.set('chat_id', id(chat.id)); form.set('caption', caption);
        form.set('photo', new Blob([cover.data], { type: cover.type }), `cover.${cover.type.split('/')[1]}`);
        if (markup) form.set('reply_markup', JSON.stringify(markup));
        try { sent = await this.call<Message>('sendPhoto', form); }
        catch (err) {
          // Workers cannot Pillow-transcode unusual images. A Telegram-invalid cover falls back to a text card.
          if (!(err instanceof TelegramError && err.code === 400 && !err.migrateTo)) throw err;
        }
      }
    }
    if (!sent) sent = await this.text(chat, caption, markup);
    const fileId = sent.photo?.at(-1)?.file_id;
    if (fileId) await this.env.DB.prepare(`INSERT INTO cover_cache(image_id,file_id,updated_at) VALUES(?,?,?)
      ON CONFLICT(image_id) DO UPDATE SET file_id=excluded.file_id,updated_at=excluded.updated_at`).bind(book.image_id, fileId, now()).run();
    await this.env.DB.prepare(`INSERT INTO chat_state(chat_id,last_book_id) VALUES(?,?)
      ON CONFLICT(chat_id) DO UPDATE SET last_book_id=excluded.last_book_id`).bind(id(chat.id), book.id).run();
    await scheduleDelete(this.env, chat, sent.message_id); return sent;
  }
  async summary(chat: Chat, book: Book, markup?: Markup): Promise<number[]> {
    const text = `စာအုပ်အမည်: ${book.title}\nစာရေးသူ: ${book.author}\n\nအညွှန်း (အပြည့်အစုံ):\n\n${book.description || 'ဒီစာအုပ်မှာ အညွှန်း မရှိပါ။'}`;
    // Preserve arbitrarily long descriptions without silently truncating or making hundreds of API calls.
    if (text.length > 12000) {
      const form = new FormData(); form.set('chat_id', id(chat.id));
      form.set('caption', clip(`အညွှန်း (အပြည့်အစုံ): ${book.title}`, 1024));
      form.set('document', new Blob([text], { type: 'text/plain;charset=utf-8' }), 'book-summary.txt');
      if (markup) form.set('reply_markup', JSON.stringify(markup));
      const sent = await this.call<Message>('sendDocument', form);
      await scheduleDelete(this.env, chat, sent.message_id); return [sent.message_id];
    }
    const mids: number[] = []; let remaining = text;
    while (remaining) {
      let boundary = Math.min(4000, remaining.length);
      if (boundary < remaining.length && /[\uD800-\uDBFF]/.test(remaining[boundary - 1])) boundary--;
      const sent = await this.text(chat, remaining.slice(0, boundary), markup);
      mids.push(sent.message_id); remaining = remaining.slice(boundary);
    }
    return mids;
  }
}
export function buildCaption(book: Book): string {
  return [`စာအုပ်အမည်: ${book.title}`, `စာရေးသူ: ${book.author}`, `စာအုပ်တိုက်: ${book.publisher}`,
    `ဈေးနှုန်း: ${book.price}`, `ထုတ်ဝေသည့်အကြိမ်: ${book.edition}`,
    ...(book.genre ? [`အမျိုးအစား: ${book.genre}`] : []), ...(book.month ? [`ထုတ်ဝေသည့်လ: ${book.month}`] : [])].join('\n');
}
export function channelLink(raw: string): string | null {
  let value = raw.trim();
  if (value.startsWith('t.me/')) value = 'https://' + value;
  if (!/^https?:\/\//i.test(value)) {
    value = value.replace(/^@/, ''); if (!/^[a-zA-Z0-9_+\-]{1,200}$/.test(value)) return null;
    value = 'https://t.me/' + value;
  }
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}
export function summaryLink(env: Env, bookId: string): string {
  return `https://t.me/${(env.BOT_USERNAME ?? 'saroatsarpay_bot').replace(/^@/, '')}?start=summary_${bookId}`;
}
export async function cardKeyboard(env: Env, chat: Chat, book: Book, stateMessageId?: number): Promise<Markup | undefined> {
  const rows: Markup['inline_keyboard'] = [];
  if (book.description.trim()) rows.push([{ text: 'အညွှန်းဖတ်ရန်',
    ...(isGroup(chat) || chat.type === 'inline' ? { url: summaryLink(env, book.id) } : { callback_data: `summary:${book.id}` }) }]);
  const link = await env.DB.prepare('SELECT url FROM publisher_links WHERE name=? OR name_n=? ORDER BY name=? DESC LIMIT 1')
    .bind(canonicalPublisher(book.publisher), normalize(canonicalPublisher(book.publisher)), canonicalPublisher(book.publisher)).first<{url: string}>();
  const url = link && channelLink(link.url); if (url) rows.push([{ text: 'စာအုပ်မှာရန်', url }]);
  if (stateMessageId) rows.push([{ text: 'စာရင်းပြန်ကြည့်မယ်', callback_data: `back:${stateMessageId}` }]);
  return rows.length ? { inline_keyboard: rows } : undefined;
}
