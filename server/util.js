// Server helpers: a disk cache and HTTP fetching (tile maths comes from shared/geo.js).
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CACHE = path.join(ROOT, 'cache');
export const UA = 'nextmap/0.1 (personal 3D map; +https://wechs.at)';

// tile maths and the small async helpers are shared with the browser
export { HALF, tileSize, lonToX, latToY, xToLon, yToLat, tileBounds, tileLonLat, tileAt, limiter, once, slug } from '../shared/geo.js';

// ---------------------------------------------------------------- disk cache
export async function cached(rel, maxAgeMs, produce) {
  const file = path.join(CACHE, rel);
  try {
    const st = await fs.stat(file);
    if (!maxAgeMs || Date.now() - st.mtimeMs < maxAgeMs) return await fs.readFile(file);
  } catch {}
  const buf = await produce();
  if (buf) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = file + '.' + process.pid + '.' + Math.random().toString(36).slice(2) + '.tmp';
    await fs.writeFile(tmp, buf);
    await fs.rename(tmp, file);
  }
  return buf;
}
export async function readJSON(rel, fallback = null) {
  try { return JSON.parse(await fs.readFile(path.join(CACHE, rel), 'utf8')); } catch { return fallback; }
}
export async function writeJSON(rel, data) {
  const file = path.join(CACHE, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.' + Math.random().toString(36).slice(2) + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(data));
  await fs.rename(tmp, file);
}

// ---------------------------------------------------------------- fetching
export async function fetchBuf(url, opts = {}) {
  const { retries = 2, timeout = 45000, headers = {}, method, body, okStatus } = opts;
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, { method, body, headers: { 'User-Agent': UA, ...headers }, signal: AbortSignal.timeout(timeout) });
      if (okStatus ? okStatus.includes(res.status) : res.ok) return { status: res.status, type: res.headers.get('content-type') || '', buf: Buffer.from(await res.arrayBuffer()) };
      if (res.status === 404 || res.status === 400 || res.status === 403) return { status: res.status, type: '', buf: null };
      lastErr = new Error(`${res.status} ${url}`);
    } catch (e) { lastErr = e; }
    await new Promise((r) => setTimeout(r, 400 * (i + 1)));
  }
  throw lastErr;
}
export async function fetchJSON(url, opts = {}) {
  const r = await fetchBuf(url, opts);
  if (!r.buf) throw new Error(`${r.status} ${url}`);
  return JSON.parse(r.buf.toString('utf8'));
}
