// Where the data comes from. With the local nextmap server (npm start) everything goes through its API, including
// the crawler and bergfex. On a static host (Cloudflare Pages) the browser does the work itself: the data worker
// builds tiles from the same public sources, and routes come from the Tyrol atlas in data/.
import { buildProfile, tileAt, lonToX, latToY } from '../shared/geo.js';
import { findScene } from '../shared/sentinel.js';
import { PRESETS, presetRegion, geocodeUrl, pickGeocodeHit, regionFromHit } from '../shared/regions.js';
import { unpackPlaces, findPlace, regionFromPlace } from '../shared/places.js';
import { createBrowserCrawler } from './crawl.js';

// one shared promise for a value fetched on first use
const lazy = (fn) => { let p = null; return () => (p ||= fn()); };

async function getJSON(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw Object.assign(new Error(body.error || r.statusText), { status: r.status, until: body.until });
  }
  return r.json();
}
const post = (url, body, type = 'application/json') =>
  getJSON(url, { method: 'POST', headers: { 'Content-Type': type }, body: type === 'application/json' ? JSON.stringify(body) : body });
const q = encodeURIComponent;
const nearArg = (near) => (near ? `&near=${near.map((v) => v.toFixed(4)).join(',')}` : '');

async function bitmap(url) {
  const res = await fetch(url);
  if (res.status === 204) return null;
  if (!res.ok) throw Object.assign(new Error(`${res.status} ${url}`), { status: res.status });
  return createImageBitmap(await res.blob(), { imageOrientation: 'none', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
}

// the data worker, started on first use
let workerCall = null;
function dataWorker() {
  if (workerCall) return workerCall;
  const worker = new Worker(new URL(globalThis.NEXTMAP_WORKER || 'worker.js', document.baseURI), { type: 'module' });
  let seq = 0;
  const calls = new Map();
  worker.onmessage = ({ data: { id, result, error } }) => {
    const c = calls.get(id); calls.delete(id);
    error ? c.reject(new Error(error)) : c.resolve(result);
  };
  workerCall = (op, ...args) => new Promise((resolve, reject) => { const id = ++seq; calls.set(id, { resolve, reject }); worker.postMessage({ id, op, args }); });
  return workerCall;
}
// both modes draw the hybrid layer and read label names in the browser
const hybridParts = {
  hybridTile: (z, x, y) => dataWorker()('hybrid', z, x, y),
  labels: (z, x, y) => dataWorker()('labels', z, x, y),
};

function serverBackend() {
  return {
    mode: 'server', ...hybridParts,
    demTile: (z, x, y) => fetch(`api/dem/${z}/${x}/${y}`).then((r) => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); }),
    imagery: (layer, z, x, y, extra) => bitmap(`api/img/${layer}/${z}/${x}/${y}${extra ? `?l=${extra}` : ''}`),
    s2Tile: async (sid, z, x, y) => { const b = await bitmap(`api/s2tile/${sid}/${z}/${x}/${y}`); return b && b.width > 1 ? { bitmap: b } : null; },
    regions: () => getJSON('api/regions'),
    places: lazy(() => getJSON('api/places').then(unpackPlaces).catch(() => [])),
    region: (name, near) => getJSON(`api/region?q=${q(name)}${nearArg(near)}`),
    routes: (region) => getJSON(`api/routes?region=${q(region.name)}${nearArg(region.view)}`),
    profile: (lines) => post('api/profile', { lines }),
    s2Scene: (season, region) => getJSON(`api/s2/${season}?region=${q(region.name)}`),
    sources: () => getJSON('api/sources'),
    startCrawl: (region, sources) => post('api/crawl', { region, sources }),
    crawlStatus: () => getJSON('api/crawl'),
    track: (region, id) => getJSON(`api/track?region=${q(region.name)}&id=${q(id)}`),
    attachGpx: (region, id, text) => post(`api/track?region=${q(region.name)}&id=${q(id)}`, text, 'application/gpx+xml'),
  };
}

function staticBackend() {
  const call = dataWorker();

  const geocoded = new Map();
  const none = () => Promise.reject(Object.assign(new Error('only in the local app'), { status: 501 }));
  const crawler = createBrowserCrawler((pts) => call('sample', 13, pts));
  const places = lazy(() => getJSON('data/places.json').then(unpackPlaces).catch(() => []));
  const region = async (name, near) => {
    const p = presetRegion(name);
    if (p) return p;
    const place = findPlace(await places(), name, near);
    if (place) return regionFromPlace(place);
    if (!geocoded.has(name)) geocoded.set(name, getJSON(geocodeUrl(name)).then(pickGeocodeHit));
    const hit = await geocoded.get(name);
    if (!hit) throw new Error('not found');
    return regionFromHit(hit, name);
  };
  // the atlas: OpenStreetMap routes for Tyrol and around it, in chunks by where they start
  const atlasIndex = lazy(() => getJSON('data/atlas/index.json').catch(() => null));
  const mosaics = lazy(() => getJSON('data/s2.json').catch(() => null));
  const chunks = new Map();
  const chunk = (k) => {
    if (!chunks.has(k)) chunks.set(k, getJSON(`data/atlas/${k}.json`).then((d) => d.routes).catch(() => { chunks.delete(k); return []; }));
    return chunks.get(k);
  };
  // every route that passes through the region: the chunks under it and around it (routes are filed where they
  // start, and many come in from outside)
  const AROUND = 0.15;
  async function atlasRoutes(r) {
    const A = await atlasIndex(), [w, s, e, n] = r.bbox;
    if (!A || w > A.bbox[2] || e < A.bbox[0] || s > A.bbox[3] || n < A.bbox[1]) return getJSON(`data/routes/${r.slug}.json`);
    const [x0, y0] = tileAt(A.chunkZ, lonToX(w - AROUND), latToY(n + AROUND)), [x1, y1] = tileAt(A.chunkZ, lonToX(e + AROUND), latToY(s - AROUND));
    const keys = [];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (A.chunks[`${x}/${y}`]) keys.push(`${A.chunkZ}/${x}/${y}`);
    const inside = ([lon, lat]) => lon >= w && lon <= e && lat >= s && lat <= n;
    const routes = (await Promise.all(keys.map(chunk))).flat().filter((x) => inside(x.start) || x.lines.some((l) => l.some(inside)));
    const sources = { osm: { label: 'OpenStreetMap', crawled: A.crawled, count: routes.filter((x) => x.source === 'osm').length } };
    const combined = routes.filter((x) => x.source === 'combined').length;
    if (combined) sources.combined = { label: 'Bike & Hike', crawled: A.crawled, count: combined };
    return { region: r.name, slug: r.slug, bbox: r.bbox, view: r.view, updated: A.crawled, sources, routes };
  }

  return {
    mode: 'static', ...hybridParts,
    demTile: (z, x, y) => call('dem', z, x, y),
    imagery: (layer, z, x, y, extra) => call('imagery', layer, z, x, y, extra),
    s2Tile: async (sid, z, x, y) => {
      if (sid.startsWith('own:')) { const b = await bitmap(`up/s2/${sid.slice(4)}/${z}/${x}/${y}.png`).catch((e) => (e.status === 404 ? null : Promise.reject(e))); return b && { bitmap: b }; }
      const rgba = await call('s2', sid, z, x, y); return rgba ? { rgba } : null;
    },
    regions: async () => PRESETS.map(({ name, bbox, view }) => ({ name, bbox, view })),
    region,
    places,
    // the routes of the atlas that start in the region (or a region snapshot), or what this browser searched itself
    // if that is newer
    routes: async (r) => {
      const [snap, mine] = await Promise.all([atlasRoutes(r).catch(() => null), crawler.load(r.slug)]);
      if (mine && (!snap || mine.updated > snap.updated)) return mine;
      return snap || { region: r.name, slug: r.slug, bbox: r.bbox, view: r.view, sources: {}, routes: [] };
    },
    profile: (lines) => buildProfile(lines, (pts) => call('sample', 14, pts), { step: 10, maxPts: 3000 }),
    // nextmap's own mosaic of the season where it covers the region; else a scene per season and region, looked up
    // twice a day (the tiler's mosaic ids expire after a day)
    s2Scene: async (season, region) => {
      const m = (await mosaics())?.[season], [west, south, east, north] = region.bbox;
      if (m && west < m.bbox[2] && east > m.bbox[0] && south < m.bbox[3] && north > m.bbox[1]) return { season, mosaic: true, searchid: `own:${m.name}`, window: m.window, maxZoom: m.maxZoom };
      const key = `nextmap-s2-${season}-${region.bbox.map((v) => v.toFixed(2)).join('_')}`;
      try { const old = JSON.parse(localStorage.getItem(key)); if (old && Date.now() - old.checked < 43200e3) return old; } catch { /* none kept */ }
      const s = { ...(await findScene((url, body) => post(url, body), season, region.bbox)), checked: Date.now() };
      try { localStorage.setItem(key, JSON.stringify(s)); } catch { /* private mode */ }
      return s;
    },
    sources: async () => [{ id: 'osm', label: 'OpenStreetMap' }],
    startCrawl: async (name) => crawler.start(await region(name)),
    crawlStatus: async () => crawler.status(),
    track: none, attachGpx: none,
  };
}

// the local server answers api/regions with JSON; a static host either has no such file or serves the page instead
export async function createBackend() {
  let mode = document.querySelector('meta[name="nextmap-mode"]')?.content;
  if (!mode) {
    try {
      const r = await fetch('api/regions');
      mode = r.ok && (r.headers.get('content-type') || '').includes('json') ? 'server' : 'static';
    } catch { mode = 'static'; }
  }
  return mode === 'server' ? serverBackend() : staticBackend();
}
