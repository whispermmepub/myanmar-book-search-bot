export interface Env {
  DB: D1Database;
  COVERS?: R2Bucket;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  TELEGRAM_OWNER_ID?: string;
  BOT_USERNAME?: string;
  SHEET_CSV_URL?: string;
  PUBLIC_BASE_URL?: string;
  NOTIFY_GROUP_ID?: string;
  REFRESH_HOURS?: string;
  NOTIFY_MAX_PER_REFRESH?: string;
  NOTIFICATION_BATCH?: string;
  DELETE_BATCH?: string;
  INBOX_BATCH?: string;
  AUTO_DELETE_SECONDS?: string;
  STATE_TTL_HOURS?: string;
  WARM_COVERS_PER_TICK?: string;
}
export interface Book {
  id: string; timestamp: string; publisher: string; month: string;
  author: string; title: string; edition: string; genre: string; price: string;
  description: string; image_url: string; image_id: string;
  title_n: string; author_n: string; publisher_n: string;
  active?: number;
}
export interface User { id: number; username?: string; is_bot?: boolean }
export interface Chat { id: number | string; type: string }
export interface Message {
  message_id: number; chat: Chat; text?: string; from?: User;
  date?: number; photo?: { file_id: string }[];
  migrate_to_chat_id?: number; migrate_from_chat_id?: number;
}
export interface Callback { id: string; data?: string; from: User; message?: Message; inline_message_id?: string }
export interface Update {
  update_id: number; message?: Message; callback_query?: Callback;
  inline_query?: { id: string; query: string; offset: string; from: User };
  my_chat_member?: { chat: Chat; new_chat_member: { status: string } };
}
export interface Button { text: string; callback_data?: string; url?: string }
export interface Markup { inline_keyboard: Button[][] }
export interface ListState {
  mode: 'search' | 'allbooks' | 'publishers' | 'pubbooks';
  query: string; results: string[]; publishers?: [string, number][];
  page: number; cardId?: number; currentBookId?: string;
}
export const now = () => Math.floor(Date.now() / 1000);
export const id = (value: string | number) => String(value);
export const isGroup = (chat: Chat) => ['group', 'supergroup'].includes(chat.type);
export function setting(value: string | undefined, fallback: number, min = 0, max = 100000): number {
  const n = Number(value ?? fallback);
  return Math.min(max, Math.max(min, Number.isFinite(n) ? n : fallback));
}
// Leaves room for Telegram limits; do not cut a Unicode surrogate pair.
export const clip = (text: string, max: number) => text.length <= max ? text : text.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/, '') + '…';
