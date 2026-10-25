// Crawl jobs: run the route sources for a region one after another, add length/ascent from the DEM to routes that
// come with geometry, and keep the merged result in cache/routes/<region>.json (saved as results come in).
import { readJSON, writeJSON } from '../util.js';
import { profile, haversine } from '../geo.js';
import { resolveRegion } from './regions.js';
import { crawlOsm } from './osm.js';
import { crawlBergfex, fetchTrack, parseGpx, gpxUrl } from './bergfex.js';
import { RateLimited, blockedUntil } from './polite.js';
import { simplify } from '../geo.js';
import { bikeAndHike, COMBINE_VERSION } from './bikehike.js';

export const SOURCES = {
  osm: { label: 'OpenStreetMap', run: crawlOsm },
  bergfex: { label: 'bergfex.at', run: crawlBergfex },
};

const fileOf = (slug) => `routes/${slug}.json`;
export const loadRoutes = (slug) => readJSON(fileOf(slug), null);
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(ms, 0)));

// read-modify-write of a region's routes file, one at a time
const locks = new Map();
async function withStore(slug, fn) {
  const prev = locks.get(slug) || Promise.resolve();
  let release;
  const mine = new Promise((r) => { release = r; });
  locks.set(slug, prev.then(() => mine));
  await prev;
  try {
    const store = await loadRoutes(slug);
    const out = await fn(store);
    if (store && out !== undefined) { store.updated = new Date().toISOString(); await writeJSON(fileOf(slug), store); }
    return out;
  } finally { release(); }
}

let job = null;
export const jobStatus = () => job && { ...job, log: job.log.slice(-60) };

// stored stats older than this are measured again (2: climbs from elevations smoothed over 100 m)
const STATS_VERSION = 2;
const remeasuring = new Set();
export function remeasure(slug) {
  if (remeasuring.has(slug)) return;
  remeasuring.add(slug);
  withStore(slug, async (store) => {
    if (!needsRemeasure(store)) return undefined;
    if (store.statsVersion !== STATS_VERSION) {
      for (const r of store.routes) if (r.lines) { try { await measure(r); } catch { /* keep the old numbers */ } }
      store.statsVersion = STATS_VERSION;
    }
    if (store.pois) await recombine(store);                   // the Bike & Hike rules changed
    return true;
  }).catch((e) => console.warn('remeasure', slug, e.message)).finally(() => remeasuring.delete(slug));
}
export const needsRemeasure = (store) => store?.routes?.length && (store.statsVersion !== STATS_VERSION || (store.pois && store.combineVersion !== COMBINE_VERSION));

// length, climb and altitudes of a route's track on the DGM (a source's walking time is kept)
async function measure(r) {
  const p = await profile(r.lines, { z: 13, step: 25, maxPts: 1500 });
  r.stats = { length: p.length, ascent: p.ascent, descent: p.descent, min: p.min, max: p.max, duration: r.stats?.duration ?? null };
  r.measured = true;
  const top = p.e.indexOf(Math.max(...p.e.filter((v) => v != null)));
  if (top >= 0) r.top = [...p.coords[top], p.e[top]];
}

async function addStats(routes, log) {
  const todo = routes.filter((r) => r.lines && !r.measured);
  for (const [i, r] of todo.entries()) {
    try { await measure(r); } catch (e) { /* keep what the source said */ }
    if (i % 25 === 24 || i === todo.length - 1) log(`elevation: ${i + 1}/${todo.length} routes measured on the tiris DGM`);
  }
}

async function setTrack(r, lines) {
  r.lines = lines; r.start = lines[0][0]; delete r.noTrack;
  await measure(r);
}

// a single tour's track on demand (selected in the app before a crawl fetched it); throws RateLimited
export async function trackFor(regionName, id) {
  const region = await resolveRegion(regionName);
  if (!region) return null;
  const m = id.match(/^bergfex-(\d+)$/);
  const lines = m && !(await loadRoutes(region.slug))?.routes.find((x) => x.id === id)?.lines ? await fetchTrack(m[1]) : null;
  return withStore(region.slug, async (store) => {
    const r = store?.routes.find((x) => x.id === id);
    if (!r || (!r.lines && !lines)) return null;
    if (!r.lines) await setTrack(r, lines);
    return r;
  });
}

// a GPX file the user downloaded (e.g. from bergfex while logged in) attached to a route
export async function attachGpx(regionName, id, text) {
  const region = await resolveRegion(regionName);
  const lines = parseGpx(text).map((l) => simplify(l, 3)).filter((l) => l.length > 1);
  if (!region || !lines.length) return null;
  return withStore(region.slug, async (store) => {
    const r = store?.routes.find((x) => x.id === id);
    if (!r) return null;
    await setTrack(r, lines);
    r.trackFrom = 'upload';
    return r;
  });
}

// bergfex tracks that did not come with the crawl (its download quota ran out) follow at the pace bergfex allows
const backfills = new Map();
export function trackStatus(store) {
  const b = (store?.routes || []).filter((r) => r.source === 'bergfex');
  const st = backfills.get(store?.slug);
  return { total: b.length, withTrack: b.filter((r) => r.lines).length, running: !!st?.running, waitUntil: st?.waitUntil || 0 };
}
export function backfillTracks(slug) {
  if (backfills.get(slug)?.running) return;
  const st = { running: true, waitUntil: 0 };
  backfills.set(slug, st);
  (async () => {
    for (;;) {
      if (job?.state === 'running') { await sleep(15000); continue; }
      const store = await loadRoutes(slug);
      const r = (store?.routes || []).find((x) => x.source === 'bergfex' && !x.lines && !(x.noTrack > Date.now()));
      if (!r) break;
      const id = r.id.slice('bergfex-'.length);
      const wait = blockedUntil(gpxUrl(id));
      if (wait) { st.waitUntil = wait; await sleep(wait - Date.now() + 1000); continue; }
      st.waitUntil = 0;
      let lines = null;
      try { lines = await fetchTrack(id); } catch (e) { if (e instanceof RateLimited) continue; }
      await withStore(slug, async (s) => {
        const x = s?.routes.find((y) => y.id === r.id);
        if (!x || x.lines) return undefined;
        if (lines) await setTrack(x, lines); else x.noTrack = Date.now() + 7 * 86400e3;   // none there: ask again in a week
        return x;
      });
    }
    // new bike tracks may make new Bike & Hike tours
    await withStore(slug, async (s) => { if (s) await recombine(s); return s ? true : undefined; });
    st.running = false; st.waitUntil = 0;
  })().catch((e) => { console.warn('track backfill', slug, e.message); st.running = false; });
}

// unnamed routes are called after the summit or hut at their highest point, or the nearest village
export function nameRoutes(routes, pois = []) {
  const near = (pt, types, maxM) => {
    let best = null, bd = maxM;
    for (const p of pois) if (types.includes(p.type)) { const d = haversine(pt, p.at); if (d < bd) { bd = d; best = p; } }
    return best;
  };
  for (const r of routes) {
    if (!r.generic || !r.top) continue;
    const dest = near(r.top, ['peak'], 450) || near(r.top, ['hut', 'saddle'], 700) || near(r.top, ['peak', 'hut', 'saddle'], 1500);
    const place = near(r.start, ['place'], 6000);
    if (dest) r.name = `${r.name} → ${dest.name}`;
    else if (place) r.name = `${r.name} · ${place.name}`;
  }
}

// Bike & Hike tours from the region's bike and hiking routes, measured like the others
async function recombine(store, log = () => {}) {
  const base = store.routes.filter((r) => r.source !== 'combined');
  const combos = bikeAndHike(base, store.pois || []);
  for (const r of combos) { try { await measure(r); } catch { /* left without numbers */ } }
  store.routes = base.concat(combos);
  store.sources.combined = { label: 'Bike & Hike (combined)', count: combos.length, crawled: new Date().toISOString() };
  store.combineVersion = COMBINE_VERSION;
  log(`Bike & Hike: ${combos.length} tours combined from bike and hiking routes`);
}

// OSM often maps one ski tour as several unnamed ways: merge pieces that got the same name and lie close together
export function mergePieces(routes) {
  const out = [], groups = new Map();
  for (const r of routes) {
    if (!r.generic || (r.kind !== 'skitour' && r.kind !== 'freeride')) { out.push(r); continue; }
    const g = groups.get(r.name) || []; groups.set(r.name, g); g.push(r);
  }
  for (const g of groups.values()) {
    const used = new Set();
    for (const a of g) {
      if (used.has(a)) continue;
      used.add(a);
      const parts = [a];
      for (const b of g) if (!used.has(b) && parts.some((p) => haversine(p.top || p.start, b.top || b.start) < 2500)) { used.add(b); parts.push(b); }
      if (parts.length === 1) { out.push(a); continue; }
      const st = parts.map((p) => p.stats).filter(Boolean);
      out.push({
        ...a, id: parts.map((p) => p.id).sort()[0], lines: parts.flatMap((p) => p.lines), parts: parts.map((p) => p.url),
        start: parts.reduce((lo, p) => ((p.stats?.min ?? 1e9) < (lo.stats?.min ?? 1e9) ? p : lo)).start,
        top: parts.reduce((hi, p) => ((p.top?.[2] ?? -1) > (hi.top?.[2] ?? -1) ? p : hi)).top,
        stats: st.length ? {
          length: st.reduce((s, x) => s + x.length, 0), ascent: Math.max(...st.map((x) => Math.max(x.ascent, x.descent))),
          descent: Math.max(...st.map((x) => Math.max(x.ascent, x.descent))), min: Math.min(...st.map((x) => x.min)), max: Math.max(...st.map((x) => x.max)), duration: null,
        } : null,
      });
    }
  }
  return out;
}

export function startCrawl(regionName, sourceIds = Object.keys(SOURCES)) {
  if (job && job.state === 'running') return job;
  job = { state: 'running', region: regionName, sources: sourceIds.map((id) => ({ id, label: SOURCES[id]?.label || id, state: 'waiting', found: 0 })), log: [], started: Date.now() };
  const log = (msg) => { job.log.push({ t: Date.now(), msg }); console.log('[crawl]', msg); };
  (async () => {
    const region = await resolveRegion(regionName);
    if (!region) throw new Error(`Could not find "${regionName}"`);
    job.region = region.name; job.slug = region.slug;
    log(`Region ${region.name}: ${region.bbox.join(', ')}`);
    const store = (await loadRoutes(region.slug)) || { region: region.name, slug: region.slug, bbox: region.bbox, view: region.view, sources: {}, routes: [], statsVersion: STATS_VERSION };
    store.bbox = region.bbox; store.view = region.view;
    const save = async (srcId, routes) => {
      store.routes = store.routes.filter((r) => r.source !== srcId).concat(routes);
      store.sources[srcId] = { label: SOURCES[srcId].label, count: routes.length, crawled: new Date().toISOString() };
      store.updated = new Date().toISOString();
      await writeJSON(fileOf(region.slug), store);
    };
    for (const src of job.sources) {
      const S = SOURCES[src.id];
      if (!S) { src.state = 'unknown'; continue; }
      src.state = 'running';
      try {
        let routes = await S.run(region, log, (partial) => { src.found = partial.length; save(src.id, partial); });
        if (routes.pois) store.pois = routes.pois;           // peaks and huts, for naming and Bike & Hike
        if (routes.some((r) => r.lines)) {
          src.state = 'measuring'; await addStats(routes, log); nameRoutes(routes, routes.pois);
          routes = mergePieces(routes);
        }
        src.found = routes.length;
        await save(src.id, routes);
        src.state = 'done';
      } catch (e) {
        src.state = 'failed'; src.error = e.message; log(`${S.label} failed: ${e.message}`);
      }
    }
    await recombine(store, log);
    await writeJSON(fileOf(region.slug), store);
    job.state = 'done'; job.finished = Date.now();
    log(`Done: ${store.routes.length} routes for ${region.name}`);
    if (store.routes.some((r) => r.source === 'bergfex' && !r.lines)) backfillTracks(region.slug);
  })().catch((e) => { job.state = 'failed'; job.error = e.message; log(`Crawl failed: ${e.message}`); });
  return job;
}
