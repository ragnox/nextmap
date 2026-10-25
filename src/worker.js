// Data worker for the static site (no nextmap server behind it): builds the elevation tiles from the tiris WCS and
// Terrarium (kept in the browser's Cache Storage), patches orthophoto tiles, composes the Sentinel-2 snow tiles and
// samples elevations for profiles, all with the same code the server uses (shared/).
import { buildDemTile, decodeTerrarium, terrariumUrl, sampleTile } from '../shared/dem.js';
import { limiter, once, tileSize, HALF } from '../shared/geo.js';
import { basemapUrl, tirisOrthoUrl, eoxUrl, eoxFallback, needsPatch, patchWhite, overlayIds, overlayUrl } from '../shared/imagery.js';
import { visualUrl, ndsiUrl, composeSnow } from '../shared/sentinel.js';

const wcs = limiter(6), web = limiter(12);
const dedupe = once();
const DEM_CACHE = 'nextmap-dem-v1';

async function get(url, limit = web) {
  const res = await limit(() => fetch(url));
  return res.status === 200 ? res : null;
}

// pixels of a 256 px image, exactly as stored (no colour management, no premultiplying)
const canvas = new OffscreenCanvas(256, 256), ctx = canvas.getContext('2d', { willReadFrequently: true });
async function pixels(blob) {
  const bm = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  ctx.clearRect(0, 0, 256, 256); ctx.drawImage(bm, 0, 0, 256, 256); bm.close();
  return ctx.getImageData(0, 0, 256, 256).data;
}

// ---------------------------------------------------------------- elevation
const terrMem = new Map();
async function terrarium(z, x, y) {
  const key = `${z}/${x}/${y}`;
  if (!terrMem.has(key)) {
    terrMem.set(key, get(terrariumUrl(z, x, y)).then(async (r) => (r ? decodeTerrarium(await pixels(await r.blob())) : null)));
    if (terrMem.size > 96) terrMem.delete(terrMem.keys().next().value);
  }
  return terrMem.get(key);
}
const io = {
  fetchBuffer: async (url) => {
    const r = await get(url, wcs);
    return r && (r.headers.get('content-type') || '').includes('tiff') ? r.arrayBuffer() : null;
  },
  terrarium,
};

let demCache = null;
const openCache = () => (demCache ||= (self.caches ? caches.open(DEM_CACHE).catch(() => null) : Promise.resolve(null)));
async function dem(z, x, y) {
  const key = `https://nextmap.invalid/dem/${z}/${x}/${y}`;
  return dedupe(key, async () => {
    const cache = await openCache();
    const hit = cache && (await cache.match(key));
    if (hit) return hit.arrayBuffer();
    const grid = await buildDemTile(z, x, y, io);
    cache?.put(key, new Response(grid.buffer.slice(0))).catch(() => {});
    return grid.buffer;
  });
}

async function sample(z, pts) {
  const size = tileSize(z);
  const key = ([mx, my]) => `${Math.floor((mx + HALF) / size)},${Math.floor((HALF - my) / size)}`;
  const tiles = new Map();
  for (const p of pts) tiles.set(key(p), null);
  await Promise.all([...tiles.keys()].map(async (k) => {
    const [tx, ty] = k.split(',').map(Number);
    try { tiles.set(k, new Float32Array(await dem(z, tx, ty))); } catch { /* unknown there */ }
  }));
  return pts.map((p) => { const g = tiles.get(key(p)); return g ? sampleTile(g, z, p[0], p[1]) : null; });
}

// ---------------------------------------------------------------- imagery
async function bitmapOf(url) {
  const r = await get(url);
  return r ? createImageBitmap(await r.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' }) : null;
}
async function imagery(layer, z, x, y, extra) {
  if (layer === 'eox') return bitmapOf(eoxUrl(z, x, y));
  if (layer === 'over') { const ids = overlayIds(extra); return ids.length ? bitmapOf(overlayUrl(ids, z, x, y)) : null; }
  const src = await get(layer === 'tiris' ? tirisOrthoUrl(z, x, y) : basemapUrl(z, x, y), layer === 'tiris' ? wcs : web);
  if (!src || !(src.headers.get('content-type') || '').startsWith('image')) return z <= 16 ? bitmapOf(eoxUrl(z, x, y)) : null;
  const blob = await src.blob(), px = await pixels(blob);
  if (!needsPatch(px)) return createImageBitmap(blob);
  // outside the orthophoto's coverage: EOX Sentinel-2 cloudless in the white area
  const fb = eoxFallback(z, x, y), fr = await get(fb.url);
  if (fr) patchWhite(px, await pixels(await fr.blob()), fb);
  return createImageBitmap(new ImageData(px, 256, 256));
}

async function s2(sid, z, x, y) {
  const [v, n] = await Promise.all([get(visualUrl(sid, z, x, y)), get(ndsiUrl(sid, z, x, y))]);
  if (!v) return null;                                          // no scene covers this tile
  return composeSnow(await pixels(await v.blob()), n ? await pixels(await n.blob()) : null);
}

// ---------------------------------------------------------------- messages
// a copy of the tile goes out, since sending moves the buffer and the tile may still be in use here
const OPS = { dem: async (...a) => (await dem(...a)).slice(0), sample, imagery, s2 };
self.onmessage = async ({ data: { id, op, args } }) => {
  try {
    const result = await OPS[op](...args);
    const transfer = result instanceof ArrayBuffer ? [result] : result?.buffer instanceof ArrayBuffer ? [result.buffer]
      : typeof ImageBitmap !== 'undefined' && result instanceof ImageBitmap ? [result] : [];
    self.postMessage({ id, result }, transfer);
  } catch (e) {
    self.postMessage({ id, error: e.message || String(e) });
  }
};
