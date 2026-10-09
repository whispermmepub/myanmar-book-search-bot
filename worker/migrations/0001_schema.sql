-- All times are Unix seconds, except usage_days.day (UTC YYYY-MM-DD).
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE books (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL, publisher TEXT NOT NULL, month TEXT NOT NULL,
  author TEXT NOT NULL, title TEXT NOT NULL, edition TEXT NOT NULL,
  genre TEXT NOT NULL, price TEXT NOT NULL, description TEXT NOT NULL,
  image_url TEXT NOT NULL, image_id TEXT NOT NULL,
  title_n TEXT NOT NULL, author_n TEXT NOT NULL, publisher_n TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL
);
CREATE INDEX books_active_timestamp ON books(active, timestamp DESC);
CREATE INDEX books_publisher ON books(active, publisher);
CREATE INDEX books_image ON books(image_id);
CREATE TABLE known_books (id TEXT PRIMARY KEY, first_seen INTEGER NOT NULL);
CREATE TABLE legacy_book_ids (legacy_id INTEGER PRIMARY KEY, book_id TEXT NOT NULL);
CREATE TABLE subscribers (chat_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL);
CREATE TABLE groups (chat_id TEXT PRIMARY KEY, chat_type TEXT NOT NULL DEFAULT 'supergroup', updated_at INTEGER NOT NULL);
CREATE TABLE publisher_links (name TEXT PRIMARY KEY, name_n TEXT NOT NULL, url TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX publisher_links_normalized ON publisher_links(name_n);
CREATE TABLE cover_cache (image_id TEXT PRIMARY KEY, file_id TEXT, cached INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0);
CREATE TABLE usage_users (user_id TEXT PRIMARY KEY, started INTEGER NOT NULL DEFAULT 0, searches INTEGER NOT NULL DEFAULT 0);
CREATE TABLE usage_days (day TEXT NOT NULL, user_id TEXT NOT NULL, PRIMARY KEY(day, user_id));
CREATE TABLE counters (key TEXT PRIMARY KEY, value INTEGER NOT NULL DEFAULT 0);
INSERT INTO counters(key, value) VALUES ('search_count', 0);
CREATE TABLE chat_state (chat_id TEXT PRIMARY KEY, last_book_id TEXT NOT NULL);
CREATE TABLE search_states (
  chat_id TEXT NOT NULL, message_id INTEGER NOT NULL,
  state TEXT NOT NULL, expires_at INTEGER NOT NULL,
  PRIMARY KEY(chat_id, message_id)
);
CREATE INDEX search_states_expiry ON search_states(expires_at);
CREATE TABLE summary_views (
  chat_id TEXT NOT NULL, card_id INTEGER NOT NULL, book_id TEXT NOT NULL,
  message_ids TEXT NOT NULL, expires_at INTEGER NOT NULL,
  PRIMARY KEY(chat_id, card_id, book_id)
);
CREATE TABLE locks (name TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE inbox (
  update_id INTEGER PRIMARY KEY, payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
  available_at INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, last_error TEXT
);
CREATE INDEX inbox_pending ON inbox(status, available_at, lease_until);
CREATE TABLE outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT, dedupe_key TEXT NOT NULL UNIQUE,
  chat_id TEXT NOT NULL, chat_type TEXT NOT NULL, book_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'new',
  status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
  available_at INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, last_error TEXT
);
CREATE INDEX outbox_pending ON outbox(status, available_at, lease_until);
CREATE TABLE deletions (
  chat_id TEXT NOT NULL, message_id INTEGER NOT NULL, due_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(chat_id, message_id)
);
CREATE INDEX deletions_due ON deletions(due_at, lease_until);
CREATE TABLE refresh_requests (
  chat_id TEXT NOT NULL, message_id INTEGER NOT NULL, chat_type TEXT NOT NULL,
  created_at INTEGER NOT NULL, PRIMARY KEY(chat_id, message_id)
);
