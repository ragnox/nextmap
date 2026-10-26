// Route search on the public site: OpenStreetMap only, straight from the visitor's browser (Overpass allows that),
// measured on the terrain by the data worker and kept in the browser's Cache Storage. Parsing, naming and Bike &
// Hike are the local crawler's own code (shared/routes.js); bergfex and other route sites need the local app.
import { OVERPASS, overpassQuery, osmRoutes, withBikeAndHike, COMBINE_VERSION } from '../shared/routes.js';

const CACHE = 'nextmap-routes-v1';
const keyOf = (slug) => `https://nextmap.invalid/routes/${slug}.json`;

// sample(points) -> elevations at the 5 m DGM level (zoom 13)
export function createBrowserCrawler(sample) {
  let job = null;

  async function load(slug) {
    try { const hit = await (await caches.open(CACHE)).match(keyOf(slug)); return hit ? hit.json() : null; } catch { return null; }
  }
  async function keep(data) {
    try { await (await caches.open(CACHE)).put(keyOf(data.slug), new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } })); } catch { /* storage refused */ }
  }

  async function run(region) {
    const log = (msg) => job.log.push({ t: Date.now(), msg });
    const src = job.sources[0];
    src.state = 'running';
    log(`Region ${region.name}: ${region.bbox.join(', ')}`);
    let json = null;
    for (const url of OVERPASS) {
      try {
        log(`Overpass: asking ${new URL(url).host}`);
        const res = await fetch(url, { method: 'POST', body: new URLSearchParams({ data: overpassQuery(region.bbox) }) });
        if (res.ok) { json = await res.json(); break; }
        log(`Overpass: ${new URL(url).host} answered ${res.status}`);
      } catch (e) { log(`Overpass: ${new URL(url).host} failed (${e.message})`); }
    }
    if (!json) throw new Error('Overpass did not answer, try again in a minute');
    src.state = 'measuring';
    const { routes, pois } = await osmRoutes(json, sample, (i, n) => {
      src.found = n;
      if (i % 50 === 0 || i === n) log(`elevation: ${i}/${n} routes measured on the terrain`);
    });
    const { routes: all, combos } = await withBikeAndHike(routes, pois, sample);
    log(`Bike & Hike: ${combos.length} tours combined from bike and hiking routes`);
    const now = new Date().toISOString();
    await keep({
      region: region.name, slug: region.slug, bbox: region.bbox, view: region.view, updated: now, searchedHere: true,
      sources: { osm: { label: 'OpenStreetMap', count: routes.length, crawled: now }, combined: { label: 'Bike & Hike (combined)', count: combos.length, crawled: now } },
      combineVersion: COMBINE_VERSION, routes: all,
    });
    src.state = 'done'; src.found = routes.length;
    log(`Done: ${all.length} routes for ${region.name}`);
  }

  return {
    load,
    start(region) {
      if (job?.state === 'running') return job;
      job = { state: 'running', region: region.name, slug: region.slug, log: [], sources: [{ id: 'osm', label: 'OpenStreetMap', state: 'waiting', found: 0 }] };
      run(region).then(() => { job.state = 'done'; }, (e) => {
        job.state = 'failed'; job.error = e.message; job.sources[0].state = 'failed';
        job.log.push({ t: Date.now(), msg: `Search failed: ${e.message}` });
      });
      return job;
    },
    status: () => (job ? { ...job, sources: job.sources.map((s) => ({ ...s })), log: job.log.slice(-30) } : { state: 'idle' }),
  };
}
