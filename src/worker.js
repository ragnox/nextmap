// Data worker. On the static site (no nextmap server behind it) it builds the elevation tiles from the tiris WCS and
// Terrarium (kept in the browser's Cache Storage), patches orthophoto tiles, composes the Sentinel-2 snow tiles and
// samples elevations for profiles, all with the same code the server uses (shared/). In both modes it draws the
// hybrid layer and reads the names for labels from OpenStreetMap vector tiles (hybrid.js).
import { buildDemTile, decodeTerrarium, terrariumUrl, sampleTile } from '../shared/dem.js';
import { limiter, once, tileSize, HALF } from '../shared/geo.js';
import { basemapUrl, tirisOrthoUrl, eoxUrl, eoxFallback, ancestorTile, needsPatch, patchWhite, overlayIds, overlayUrl } from '../shared/imagery.js';
import { visualUrl, ndsiUrl, composeSnow } from '../shared/sentinel.js';
import { hybridTile, labelsTile } from './hybrid.js';

const wcs = limiter(6), web = limiter(12);
const dedupe = once();
const DEM_CACHE = 'nextmap-dem-v2';                    // v1 has eastern Tyrol at zoom 11-13 without tiris

// on the public site the Land Tirol's data comes through nextmap's own cache (functions/up/), and straight from the
// Land where that is missing (a plain static server) or fails
const PROXY = globalThis.NEXTMAP_PROXY ? new URL('up/', self.location).href : null;
const viaProxy = (url) => (PROXY && url.startsWith('https://gis.tirol.gv.at/arcgis/')
  ? url.replace('https://gis.tirol.gv.at/arcgis/services/Service_Public/terrain/MapServer/WCSServer', `${PROXY}wcs`)
    .replace('https://gis.tirol.gv.at/arcgis/rest/services/Service_Public/', `${PROXY}tiris/`)
  : null);

async function get(url, limit = web) {
  const own = viaProxy(url);
  if (own) { const r = await limit(() => fetch(own)).catch(() => null); if (r?.status === 200) return r; }
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
const openCache = () => (demCache ||= (self.caches ? caches.delete('nextmap-dem-v1').catch(() => {}).then(() => caches.open(DEM_CACHE)).catch(() => null) : Promise.resolve(null)));
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

// the grids most recently sampled, so measuring many routes does not read the same tiles again and again
const grids = new Map();
async function grid(z, x, y) {
  const k = `${z}/${x}/${y}`;
  if (grids.has(k)) { const g = grids.get(k); grids.delete(k); grids.set(k, g); return g; }
  const g = new Float32Array(await dem(z, x, y));
  grids.set(k, g);
  if (grids.size > 120) grids.delete(grids.keys().next().value);
  return g;
}

async function sample(z, pts) {
  const size = tileSize(z);
  const key = ([mx, my]) => `${Math.floor((mx + HALF) / size)},${Math.floor((HALF - my) / size)}`;
  const tiles = new Map();
  for (const p of pts) tiles.set(key(p), null);
  await Promise.all([...tiles.keys()].map(async (k) => {
    const [tx, ty] = k.split(',').map(Number);
    try { tiles.set(k, await grid(z, tx, ty)); } catch { /* unknown there */ }
  }));
  return pts.map((p) => { const g = tiles.get(key(p)); return g ? sampleTile(g, z, p[0], p[1]) : null; });
}

// ---------------------------------------------------------------- imagery
async function bitmapOf(url) {
  const r = await get(url);
  return r ? createImageBitmap(await r.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' }) : null;
}
// where the orthophoto has no data: nextmap's own Sentinel-2 summer mosaic on the public site (data/s2.json says
// which), else EOX Sentinel-2 cloudless
const mosaic = PROXY ? fetch(new URL('data/s2.json', self.location)).then((r) => r.json()).then((d) => d.summer || null).catch(() => null) : Promise.resolve(null);
// the tiles to try: the mosaic at its own detail, then its wide-area levels (the far views), or EOX
async function fallbacks(z, x, y) {
  const m = await mosaic;
  if (!m || z < m.minZoom) return [eoxFallback(z, x, y)];
  const at = (maxZ) => ancestorTile((zz, xx, yy) => `${PROXY}s2/${m.name}/${zz}/${xx}/${yy}.jpg`, maxZ, z, x, y);
  return z > m.wideMaxZoom ? [at(m.maxZoom), at(m.wideMaxZoom)] : [at(m.maxZoom)];
}

async function imagery(layer, z, x, y, extra) {
  if (layer === 'eox') return bitmapOf(eoxUrl(z, x, y));
  if (layer === 'over') { const ids = overlayIds(extra); return ids.length ? bitmapOf(overlayUrl(ids, z, x, y)) : null; }
  const src = await get(layer === 'tiris' ? tirisOrthoUrl(z, x, y) : basemapUrl(z, x, y), layer === 'tiris' ? wcs : web);
  const ok = src && (src.headers.get('content-type') || '').startsWith('image');
  const blob = ok && await src.blob(), px = blob ? await pixels(blob) : new Uint8ClampedArray(256 * 256 * 4).fill(255);
  if (blob && !needsPatch(px)) return createImageBitmap(blob);
  // outside the orthophoto's coverage: the fallback in the white area (all of it where there was no photo)
  let fb, fr;
  for (fb of await fallbacks(z, x, y)) if ((fr = await get(fb.url))) break;
  if (!fr) return blob ? createImageBitmap(blob) : null;
  if (!blob && fb.k === 1) return createImageBitmap(await fr.blob());
  patchWhite(px, await pixels(await fr.blob()), fb);
  return createImageBitmap(new ImageData(px, 256, 256));
}

async function s2(sid, z, x, y) {
  const [v, n] = await Promise.all([get(visualUrl(sid, z, x, y)), get(ndsiUrl(sid, z, x, y))]);
  if (!v) return null;                                          // no scene covers this tile
  return composeSnow(await pixels(await v.blob()), n ? await pixels(await n.blob()) : null);
}

// ---------------------------------------------------------------- messages
// a copy of the tile goes out, since sending moves the buffer and the tile may still be in use here
const OPS = { dem: async (...a) => (await dem(...a)).slice(0), sample, imagery, s2, hybrid: hybridTile, labels: labelsTile };
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
