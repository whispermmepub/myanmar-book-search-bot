import type { Book, Env } from './types';

export const DEFAULT_CSV_URL = 'https://docs.google.com/spreadsheets/d/18gpNdDNHztbkQE9rRvw6Y0rPqtKjrROJdy4HnZXqTQw/export?format=csv';
const ALIASES: Record<string, string> = {
  'ဆုပြည့်စုံထွန်း': 'ဆုပြည့်စုံထွန်းစာပေ',
  'ဆုပြည်စုံထွန်းစာပေ': 'ဆုပြည့်စုံထွန်းစာပေ',
  'ွQuality Publishing House': 'Quality Publishing House',
  'Little Yangon Publcation': 'Little Yangon Publication',
  'ဆောင်းစုရတီစာပေ': 'ဆောင်းစုရတီ',
  'ပန်းဆက်လမ်းစာပေ': 'ပန်းဆက်လမ်း',
  'စာရိပ်မြိုင်စာပေ': 'စာရိပ်မြိုင် စာပေ',
  'လင်းသစ်ရောင်စဉ်': 'လင်းသစ်ရောင်စဉ် စာအုပ်တိုက်',
  'Linn Thit Pyi လင်းသစ်ပြည် စာပေ': 'Linn Thit Pyi လင်းသစ်ပြည်စာပေ',
};
export function canonicalPublisher(name: string): string {
  const clean = name.replace(/\u200b/g, '').trim();
  return ALIASES[clean] ?? clean;
}
export function normalize(text: string): string {
  return (text || '').normalize('NFKC')
    .replace(/[.,!?()\[\]{}<>"'`~@#$%^&*_\-+=/\\|:;，。！？（）“”‘’]/g, '')
    .replace(/\s+/gu, '').toLowerCase().replace(/ß/g, 'ss').replace(/ς/g, 'σ');
}
export function extractImageId(url: string): string | null {
  return /[?&]id=([\w-]+)/.exec(url)?.[1] ?? /\/d\/([\w-]+)/.exec(url)?.[1] ?? null;
}
export async function stableBookId(title: string, author: string): Promise<string> {
  const data = new TextEncoder().encode(JSON.stringify([normalize(title), normalize(author)]));
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return Array.from(hash.slice(0, 16), b => b.toString(16).padStart(2, '0')).join('');
}
// RFC4180-style CSV: quoted commas, doubled quotes, CRLF and embedded newlines.
export function parseCSV(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let field = ''; let quoted = false;
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; }
      else if (quoted || field.length === 0) quoted = !quoted;
      else field += c;
    } else if (c === ',' && !quoted) { row.push(field); field = ''; }
    else if ((c === '\n' || c === '\r') && !quoted) {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (quoted) throw new Error('Malformed CSV: unclosed quoted field');
  if (row.length || field.length) { row.push(field); rows.push(row); }
  return rows;
}
export async function parseBooks(text: string): Promise<Book[]> {
  const rows = parseCSV(text); const books: Book[] = []; const seen = new Set<string>();
  // Skip header, but do not blindly skip a valid second data row (original sheet has a spacer).
  for (const row of rows.slice(1)) {
    if (row.length <= 8) continue;
    const [timestamp, rawPublisher, month, image_url, author, title, edition, genre, price, description] =
      Array.from({ length: 10 }, (_, i) => (row[i] || '').trim());
    const publisher = canonicalPublisher(rawPublisher); const image_id = extractImageId(image_url);
    if (!(title && author && publisher && price && edition && image_id)) continue;
    const key = JSON.stringify([normalize(title), normalize(author)]);
    if (seen.has(key)) continue;
    seen.add(key);
    books.push({ id: await stableBookId(title, author), timestamp, publisher, month,
      image_url, image_id, author, title, edition, genre, price, description,
      title_n: normalize(title), author_n: normalize(author), publisher_n: normalize(publisher) });
  }
  return books.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}
export function search(books: Book[], query: string, limit = 100): Book[] {
  const q = normalize(query); if (!q) return [];
  const tokens = query.split(/\s+/).map(normalize).filter(Boolean);
  const scored = books.map(book => {
    const t = book.title_n, a = book.author_n, p = book.publisher_n;
    const score = q === t ? 100 : t.startsWith(q) ? 85 : t.includes(q) ? 70 :
      q === a ? 90 : a.startsWith(q) ? 75 : a.includes(q) ? 60 : p.includes(q) ? 30 :
      tokens.length > 1 && tokens.every(x => t.includes(x) || a.includes(x)) ? 50 : 0;
    return { book, score };
  }).filter(x => x.score);
  return scored.sort((a, b) => b.score - a.score || a.book.timestamp.localeCompare(b.book.timestamp))
    .slice(0, limit).map(x => x.book);
}
export async function allBooks(env: Env): Promise<Book[]> {
  return (await env.DB.prepare('SELECT * FROM books WHERE active=1 ORDER BY timestamp DESC, id').all<Book>()).results;
}
export async function byId(env: Env, bookId: string): Promise<Book | null> {
  if (/^\d+$/.test(bookId)) {
    return env.DB.prepare('SELECT b.* FROM books b JOIN legacy_book_ids l ON b.id=l.book_id WHERE l.legacy_id=?').bind(Number(bookId)).first<Book>();
  }
  if (!/^[a-f0-9]{32}$/.test(bookId)) return null;
  // Retained inactive rows let old cards and stable summary links remain meaningful.
  return env.DB.prepare('SELECT * FROM books WHERE id=?').bind(bookId).first<Book>();
}
export function publisherList(books: Book[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const book of books) counts.set(book.publisher, (counts.get(book.publisher) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].toLowerCase().localeCompare(b[0].toLowerCase()));
}
