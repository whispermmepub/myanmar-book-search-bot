import { now, type Env } from './types';

const MAX_BYTES = 5 * 1024 * 1024;
function imageType(bytes: Uint8Array): string | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((x, i) => bytes[i] === x)) return 'image/png';
  if (new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF' && new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP') return 'image/webp';
  return null;
}
export async function getCover(env: Env, imageId: string): Promise<{ data: ArrayBuffer; type: string } | null> {
  if (!/^[\w-]{1,200}$/.test(imageId)) return null;
  const key = `covers/${imageId}`;
  if (env.COVERS) {
    try {
      const cached = await env.COVERS.get(key);
      if (cached) return { data: await cached.arrayBuffer(), type: cached.httpMetadata?.contentType ?? 'image/jpeg' };
    } catch { console.warn('R2 read unavailable; using Drive fallback'); }
  }
  for (const url of [
    `https://drive.google.com/thumbnail?id=${imageId}&sz=w640`,
    `https://drive.google.com/uc?export=view&id=${imageId}`,
  ]) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'MyanmarBookWorker/1.0' } });
      if (!response.ok || Number(response.headers.get('content-length') ?? 0) > MAX_BYTES) { await response.body?.cancel(); continue; }
      // Read with a hard byte cap; do not buffer arbitrary large Drive responses.
      const reader = response.body?.getReader(); if (!reader) continue;
      const chunks: Uint8Array[] = []; let size = 0;
      while (true) {
        const part = await reader.read(); if (part.done) break;
        size += part.value.length;
        if (size > MAX_BYTES) { await reader.cancel(); break; }
        chunks.push(part.value);
      }
      if (size > MAX_BYTES || size === 0) continue;
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      const type = imageType(bytes); if (!type) continue;
      if (env.COVERS) {
        try {
          await env.COVERS.put(key, bytes, { httpMetadata: { contentType: type, cacheControl: 'public, max-age=86400' } });
          await env.DB.prepare(`INSERT INTO cover_cache(image_id,cached,updated_at) VALUES(?,1,?)
            ON CONFLICT(image_id) DO UPDATE SET cached=1,updated_at=excluded.updated_at`).bind(imageId, now()).run();
        } catch { console.warn('R2 cache write unavailable; image still usable'); }
      }
      return { data: bytes.buffer, type };
    } catch { /* Thumbnail or export can fail: try the next safe, fixed-host URL. */ }
  }
  await env.DB.prepare(`INSERT INTO cover_cache(image_id,cached,updated_at) VALUES(?,-1,?)
    ON CONFLICT(image_id) DO UPDATE SET cached=-1,updated_at=excluded.updated_at`).bind(imageId, now()).run();
  return null;
}
export async function coverResponse(env: Env, imageId: string): Promise<Response> {
  const exists = await env.DB.prepare('SELECT id FROM books WHERE image_id=? LIMIT 1').bind(imageId).first();
  if (!exists) return new Response('Not found', { status: 404 });
  const cover = await getCover(env, imageId);
  if (!cover) return new Response('Cover unavailable', { status: 404 });
  return new Response(cover.data, { headers: {
    'Content-Type': cover.type, 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff',
  } });
}
