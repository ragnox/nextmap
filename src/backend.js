// Where the data comes from. With the local nextmap server (npm start) everything goes through its API, including
// the crawler and bergfex. On a static host (Cloudflare Pages) the browser does the work itself: the data worker
// builds tiles from the same public sources, and routes come from the snapshot in data/.
import { buildProfile } from '../shared/geo.js';
import { findScene } from '../shared/sentinel.js';
import { PRESETS, presetRegion, geocodeUrl, pickGeocodeHit, regionFromHit } from '../shared/regions.js';
import { createBrowserCrawler } from './crawl.js';

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

async function bitmap(url) {
  const res = await fetch(url);
  if (res.status === 204) return null;
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return createImageBitmap(await res.blob(), { imageOrientation: 'none', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
}

function serverBackend() {
  return {
    mode: 'server',
    demTile: (z, x, y) => fetch(`api/dem/${z}/${x}/${y}`).then((r) => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); }),
    imagery: (layer, z, x, y, extra) => bitmap(`api/img/${layer}/${z}/${x}/${y}${extra ? `?l=${extra}` : ''}`),
    s2Tile: async (sid, z, x, y) => { const b = await bitmap(`api/s2tile/${sid}/${z}/${x}/${y}`); return b && b.width > 1 ? { bitmap: b } : null; },
    regions: () => getJSON('api/regions'),
    region: (name) => getJSON(`api/region?q=${q(name)}`),
    routes: (region) => getJSON(`api/routes?region=${q(region.name)}`),
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
  const worker = new Worker(new URL(globalThis.NEXTMAP_WORKER || 'worker.js', document.baseURI), { type: 'module' });
  let seq = 0;
  const calls = new Map();
  worker.onmessage = ({ data: { id, result, error } }) => {
    const c = calls.get(id); calls.delete(id);
    error ? c.reject(new Error(error)) : c.resolve(result);
  };
  const call = (op, ...args) => new Promise((resolve, reject) => { const id = ++seq; calls.set(id, { resolve, reject }); worker.postMessage({ id, op, args }); });

  const geocoded = new Map();
  const none = () => Promise.reject(Object.assign(new Error('only in the local app'), { status: 501 }));
  const crawler = createBrowserCrawler((pts) => call('sample', 13, pts));
  const region = async (name) => {
    const p = presetRegion(name);
    if (p) return p;
    if (!geocoded.has(name)) geocoded.set(name, getJSON(geocodeUrl(name)).then(pickGeocodeHit));
    const hit = await geocoded.get(name);
    if (!hit) throw new Error('not found');
    return regionFromHit(hit, name);
  };
  return {
    mode: 'static',
    demTile: (z, x, y) => call('dem', z, x, y),
    imagery: (layer, z, x, y, extra) => call('imagery', layer, z, x, y, extra),
    s2Tile: async (sid, z, x, y) => { const rgba = await call('s2', sid, z, x, y); return rgba ? { rgba } : null; },
    regions: async () => PRESETS.map(({ name, bbox, view }) => ({ name, bbox, view })),
    region,
    // the published snapshot, or what this browser searched itself if that is newer
    routes: async (r) => {
      const [snap, mine] = await Promise.all([getJSON(`data/routes/${r.slug}.json`).catch(() => null), crawler.load(r.slug)]);
      if (mine && (!snap || mine.updated > snap.updated)) return mine;
      return snap || { region: r.name, slug: r.slug, bbox: r.bbox, view: r.view, sources: {}, routes: [] };
    },
    profile: (lines) => buildProfile(lines, (pts) => call('sample', 14, pts), { step: 10, maxPts: 3000 }),
    // a scene per season and region, looked up once a day
    s2Scene: async (season, region) => {
      const key = `nextmap-s2-${season}-${region.bbox.map((v) => v.toFixed(2)).join('_')}`;
      try { const old = JSON.parse(localStorage.getItem(key)); if (old && Date.now() - old.checked < 86400e3) return old; } catch { /* none kept */ }
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
