// Converts a local copy of Railway STATE_DIR JSON into SQL; never connects to Railway.
// Run only against a fresh, stopped Worker database. Output contains user IDs: keep private.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
const directory = process.argv[2];
if (!directory) throw new Error('Usage: npm run import:railway -- /path/to/state-copy [/path/to/private-output.sql]');
const output = resolve(process.argv[3] ?? 'railway-import.sql');
const root = resolve(directory);
const read = (name, fallback) => existsSync(join(root, name)) ? JSON.parse(readFileSync(join(root, name), 'utf8')) : fallback;
const q = value => "'" + String(value).replace(/'/g, "''") + "'";
const normalize = value => String(value || '').normalize('NFKC').replace(/[.,!?()\[\]{}<>"'`~@#$%^&*_\-+=/\\|:;，。！？（）“”‘’]/g, '').replace(/\s+/gu, '').toLowerCase().replace(/ß/g, 'ss').replace(/ς/g, 'σ');
const hash = (title, author) => createHash('sha256').update(JSON.stringify([title, author])).digest('hex').slice(0, 32);
const lines = ['-- Private user data. Import only into a fresh Worker D1 database before enabling cron/webhook.'];
const at = Math.floor(Date.now() / 1000);
for (const [title, author] of read('known_books.json', [])) {
  lines.push(`INSERT OR IGNORE INTO known_books(id,first_seen) VALUES(${q(hash(title, author))},${at});`);
}
for (const uid of read('subscribers.json', [])) {
  lines.push(`INSERT OR IGNORE INTO subscribers(chat_id,enabled,updated_at) VALUES(${q(uid)},1,${at});`);
  lines.push(`INSERT OR IGNORE INTO usage_users(user_id,started,searches) VALUES(${q(uid)},1,0);`);
}
for (const gid of read('bot_groups.json', [])) lines.push(`INSERT OR IGNORE INTO groups(chat_id,chat_type,updated_at) VALUES(${q(gid)},'supergroup',${at});`);
for (const [name, value] of Object.entries(read('publisher_channels.json', {}))) {
  if (name.startsWith('_') || !value) continue;
  const clean = name.replace(/\u200b/g, '').trim();
  lines.push(`INSERT INTO publisher_links(name,name_n,url,updated_at) VALUES(${q(clean)},${q(normalize(clean))},${q(value)},${at}) ON CONFLICT(name) DO UPDATE SET url=excluded.url,name_n=excluded.name_n,updated_at=excluded.updated_at;`);
}
for (const [imageId, fileId] of Object.entries(read('book_file_ids.json', {}))) {
  lines.push(`INSERT OR REPLACE INTO cover_cache(image_id,file_id,cached,updated_at) VALUES(${q(imageId)},${q(fileId)},0,${at});`);
}
const usage = read('usage.json', {});
for (const uid of usage.start_users ?? []) lines.push(`INSERT INTO usage_users(user_id,started,searches) VALUES(${q(uid)},1,0) ON CONFLICT(user_id) DO UPDATE SET started=1;`);
for (const uid of usage.search_users ?? []) lines.push(`INSERT INTO usage_users(user_id,started,searches) VALUES(${q(uid)},0,1) ON CONFLICT(user_id) DO UPDATE SET searches=MAX(searches,1);`);
if (Number.isSafeInteger(usage.search_count) && usage.search_count >= 0) lines.push(`UPDATE counters SET value=${usage.search_count} WHERE key='search_count';`);
for (const [day, users] of Object.entries(usage.active_days ?? {})) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
  for (const uid of users) lines.push(`INSERT OR IGNORE INTO usage_days(day,user_id) VALUES(${q(day)},${q(uid)});`);
}
// Optional snapshot preserves exact old numeric summary IDs. Without it initial CSV order is best effort.
for (const book of read('books_snapshot.json', [])) {
  if (!Number.isSafeInteger(book.id)) continue;
  lines.push(`INSERT OR REPLACE INTO legacy_book_ids(legacy_id,book_id) VALUES(${book.id},${q(hash(normalize(book.title), normalize(book.author)))});`);
}
writeFileSync(output, lines.join('\n') + '\n', { mode: 0o600 });
console.log(`Wrote ${lines.length - 1} SQL statements to ${output}. No data was uploaded.`);
