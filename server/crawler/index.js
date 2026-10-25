// Crawl jobs: run the route sources for a region one after another, add length/ascent from the DEM to routes that
// come with geometry, and keep the merged result in cache/routes/<region>.json (saved as results come in).
import { readJSON, writeJSON } from '../util.js';
import { profile, haversine } from '../geo.js';
import { resolveRegion } from './regions.js';
import { crawlOsm } from './osm.js';
import { crawlBergfex } from './bergfex.js';

export const SOURCES = {
  osm: { label: 'OpenStreetMap', run: crawlOsm },
  bergfex: { label: 'bergfex.at', run: crawlBergfex },
};

const fileOf = (slug) => `routes/${slug}.json`;
export const loadRoutes = (slug) => readJSON(fileOf(slug), null);

let job = null;
export const jobStatus = () => job && { ...job, log: job.log.slice(-60) };

async function addStats(routes, log) {
  const todo = routes.filter((r) => r.lines && !r.stats);
  for (const [i, r] of todo.entries()) {
    try {
      const p = await profile(r.lines, { z: 13, step: 25, maxPts: 1500 });
      r.stats = { length: p.length, ascent: p.ascent, descent: p.descent, min: p.min, max: p.max, duration: null };
      const top = p.e.indexOf(Math.max(...p.e.filter((v) => v != null)));
      if (top >= 0) r.top = [...p.coords[top], p.e[top]];
    } catch (e) { r.stats = null; }
    if (i % 25 === 24 || i === todo.length - 1) log(`elevation: ${i + 1}/${todo.length} routes measured on the tiris DGM`);
  }
}

// unnamed routes are called after the summit or hut at their highest point, or the nearest village
function nameRoutes(routes, pois = []) {
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

// OSM often maps one ski tour as several unnamed ways: merge pieces that got the same name and lie close together
function mergePieces(routes) {
  const out = [], groups = new Map();
  for (const r of routes) {
    if (!r.generic || r.kind !== 'skitour') { out.push(r); continue; }
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
    const store = (await loadRoutes(region.slug)) || { region: region.name, slug: region.slug, bbox: region.bbox, view: region.view, sources: {}, routes: [] };
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
    job.state = 'done'; job.finished = Date.now();
    log(`Done: ${store.routes.length} routes for ${region.name}`);
  })().catch((e) => { job.state = 'failed'; job.error = e.message; log(`Crawl failed: ${e.message}`); });
  return job;
}
