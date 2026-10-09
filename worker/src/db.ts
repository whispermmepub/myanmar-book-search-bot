import { id, isGroup, now, setting, type Chat, type Env, type ListState } from './types';

export async function meta(env: Env, key: string): Promise<string | null> {
  return env.DB.prepare('SELECT value FROM meta WHERE key=?').bind(key).first<string>('value');
}
export async function setMeta(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(key, value).run();
}
export async function lease(env: Env, name: string, seconds = 60): Promise<string | null> {
  const owner = crypto.randomUUID(); const at = now();
  const row = await env.DB.prepare(`INSERT INTO locks(name,owner,expires_at) VALUES(?,?,?)
    ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at
    WHERE locks.expires_at<=? RETURNING owner`).bind(name, owner, at + seconds, at).first<{owner: string}>();
  return row?.owner === owner ? owner : null;
}
export async function release(env: Env, name: string, owner: string): Promise<void> {
  await env.DB.prepare('DELETE FROM locks WHERE name=? AND owner=?').bind(name, owner).run();
}
export async function markActive(env: Env, userId: number, started = false, searched = false): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  const statements = [
    env.DB.prepare(`INSERT INTO usage_users(user_id,started,searches) VALUES(?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET started=MAX(started,excluded.started),searches=searches+excluded.searches`)
      .bind(id(userId), Number(started), Number(searched)),
    env.DB.prepare('INSERT OR IGNORE INTO usage_days(day,user_id) VALUES(?,?)').bind(day, id(userId)),
  ];
  if (searched) statements.push(env.DB.prepare("UPDATE counters SET value=value+1 WHERE key='search_count'"));
  await env.DB.batch(statements);
}
export async function subscribe(env: Env, chat: Chat, enabled: boolean): Promise<void> {
  await env.DB.prepare(`INSERT INTO subscribers(chat_id,enabled,updated_at) VALUES(?,?,?)
    ON CONFLICT(chat_id) DO UPDATE SET enabled=excluded.enabled,updated_at=excluded.updated_at`)
    .bind(id(chat.id), Number(enabled), now()).run();
}
export async function autoSubscribe(env: Env, chat: Chat): Promise<void> {
  if (chat.type !== 'private') return;
  // Explicit opt-out persists until /start or /subscribe, unlike the original text re-subscribe behavior.
  await env.DB.prepare('INSERT OR IGNORE INTO subscribers(chat_id,enabled,updated_at) VALUES(?,1,?)').bind(id(chat.id), now()).run();
}
export async function rememberGroup(env: Env, chat: Chat): Promise<void> {
  if (!isGroup(chat)) return;
  await env.DB.prepare(`INSERT INTO groups(chat_id,chat_type,updated_at) VALUES(?,?,?)
    ON CONFLICT(chat_id) DO UPDATE SET chat_type=excluded.chat_type,updated_at=excluded.updated_at`)
    .bind(id(chat.id), chat.type, now()).run();
}
export async function scheduleDelete(env: Env, chat: Chat, messageId: number): Promise<void> {
  if (!isGroup(chat)) return;
  await env.DB.prepare(`INSERT INTO deletions(chat_id,message_id,due_at) VALUES(?,?,?)
    ON CONFLICT(chat_id,message_id) DO UPDATE SET due_at=excluded.due_at,attempts=0,lease_until=0`)
    .bind(id(chat.id), messageId, now() + setting(env.AUTO_DELETE_SECONDS, 300, 60, 86400)).run();
}
export async function saveState(env: Env, chat: Chat, messageId: number, state: ListState): Promise<void> {
  await env.DB.prepare(`INSERT INTO search_states(chat_id,message_id,state,expires_at) VALUES(?,?,?,?)
    ON CONFLICT(chat_id,message_id) DO UPDATE SET state=excluded.state,expires_at=excluded.expires_at`)
    .bind(id(chat.id), messageId, JSON.stringify(state), now() + setting(env.STATE_TTL_HOURS, 168, 1, 720) * 3600).run();
}
export async function loadState(env: Env, chat: Chat, messageId: number): Promise<ListState | null> {
  const row = await env.DB.prepare('SELECT state FROM search_states WHERE chat_id=? AND message_id=? AND expires_at>?')
    .bind(id(chat.id), messageId, now()).first<{state: string}>();
  return row ? JSON.parse(row.state) as ListState : null;
}
