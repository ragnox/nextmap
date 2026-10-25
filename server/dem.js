// Elevation tiles on the server: the shared builder (shared/dem.js) with fetches through a limiter, Terrarium PNGs
// decoded with pngjs, and finished tiles kept on disk and the most recent in memory.
import zlib from 'node:zlib';
import { PNG } from 'pngjs';
import { cached, fetchBuf, limiter, once, tileSize, HALF } from './util.js';
import { buildDemTile, decodeTerrarium, terrariumUrl, sampleTile } from '../shared/dem.js';

export { N, S, MAX_Z } from '../shared/dem.js';

const wcsLimit = limiter(6);
const terrLimit = limiter(8);
const dedupe = once();

const terrMem = new Map();
async function terrariumTile(z, x, y) {
  const key = `${z}/${x}/${y}`;
  if (terrMem.has(key)) { const v = terrMem.get(key); terrMem.delete(key); terrMem.set(key, v); return v; }
  const png = await cached(`terrarium/${key}.png`, 0, async () => (await terrLimit(() => fetchBuf(terrariumUrl(z, x, y)))).buf);
  const h = png ? decodeTerrarium(PNG.sync.read(png).data) : null;
  terrMem.set(key, h);
  if (terrMem.size > 96) terrMem.delete(terrMem.keys().next().value);
  return h;
}

const io = {
  fetchBuffer: async (url) => {
    const r = await wcsLimit(() => fetchBuf(url, { timeout: 90000 }));
    return r.buf && r.type.includes('tiff') ? r.buf : null;
  },
  terrarium: terrariumTile,
  warn: (msg) => console.warn(msg),
};

// the raw grid (cached on disk, the most recent ones in memory); used by the tile endpoint and by route profiles
const mem = new Map();
export async function demTile(z, x, y) {
  const key = `${z}/${x}/${y}`;
  if (mem.has(key)) { const g = mem.get(key); mem.delete(key); mem.set(key, g); return g; }
  const buf = await dedupe(key, () => cached(`dem/v1/${key}.f32`, 0, async () => {
    const g = await buildDemTile(z, x, y, io);
    return Buffer.from(g.buffer);
  }));
  const g = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  mem.set(key, g);
  if (mem.size > 160) mem.delete(mem.keys().next().value);
  return g;
}

export async function demTileGz(z, x, y) {
  const g = await demTile(z, x, y);
  return zlib.gzipSync(Buffer.from(g.buffer, g.byteOffset, g.byteLength), { level: 4 });
}

// bilinear elevations for many points (Mercator metres) at one zoom level: loads the tiles in parallel, then samples
export async function sampleElevations(z, pts, onProgress) {
  const size = tileSize(z);
  const key = ([mx, my]) => `${Math.floor((mx + HALF) / size)},${Math.floor((HALF - my) / size)}`;
  const tiles = new Map();
  for (const p of pts) tiles.set(key(p), null);
  let done = 0;
  const load = limiter(6);
  await Promise.all([...tiles.keys()].map((k) => load(async () => {
    const [tx, ty] = k.split(',').map(Number);
    try { tiles.set(k, await demTile(z, tx, ty)); } catch (e) { console.warn('dem', z, k, e.message); }
    onProgress?.(++done, tiles.size);
  })));
  return pts.map((p) => { const g = tiles.get(key(p)); return g ? sampleTile(g, z, p[0], p[1]) : null; });
}
