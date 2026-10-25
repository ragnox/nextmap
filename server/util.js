// Shared helpers for the server: Web Mercator tile math, a disk cache and polite HTTP fetching.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CACHE = path.join(ROOT, 'cache');
export const UA = 'nextmap/0.1 (personal 3D map; +https://wechs.at)';

// ---------------------------------------------------------------- Web Mercator (EPSG:3857)
const R = 6378137;
export const HALF = Math.PI * R;
export const tileSize = (z) => (2 * HALF) / 2 ** z;
export const lonToX = (lon) => (lon * Math.PI / 180) * R;
export const latToY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI / 180) / 2)) * R;
export const xToLon = (x) => (x / R) * 180 / Math.PI;
export const yToLat = (y) => (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180 / Math.PI;

// tile bounds in mercator metres: [x0, y0 (south), x1, y1 (north)]
export function tileBounds(z, x, y) {
  const s = tileSize(z);
  return [-HALF + x * s, HALF - (y + 1) * s, -HALF + (x + 1) * s, HALF - y * s];
}
export function tileLonLat(z, x, y) {
  const [x0, y0, x1, y1] = tileBounds(z, x, y);
  return [xToLon(x0), yToLat(y0), xToLon(x1), yToLat(y1)];
}
export function tileAt(z, mx, my) {
  const s = tileSize(z);
  return [Math.floor((mx + HALF) / s), Math.floor((HALF - my) / s)];
}

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

// run async jobs with a concurrency limit
export function limiter(n) {
  let active = 0; const queue = [];
  const next = () => {
    if (active >= n || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => { active--; next(); });
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}

// de-duplicate concurrent requests for the same key
export function once() {
  const pending = new Map();
  return (key, fn) => {
    if (pending.has(key)) return pending.get(key);
    const p = fn().finally(() => pending.delete(key));
    pending.set(key, p);
    return p;
  };
}

export const slug = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
