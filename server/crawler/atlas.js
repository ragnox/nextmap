// The route atlas for the public site: OpenStreetMap routes for all of Tyrol and a margin around it, measured, named
// and combined like a region crawl, plus a list of places, peaks, huts, valleys and ranges to search. Built here
// with a few dozen Overpass queries (once, not by every visitor) and published as static files by scripts/build.js:
//   node server/crawler/atlas.js        writes cache/atlas/routes.json and cache/atlas/places.json
import { fetchBuf, writeJSON, readJSON, tileAt, lonToX, latToY, tileLonLat } from '../util.js';
import { OVERPASS, parseOverpass, nameRoutes, mergePieces, measureRoute, bikeAndHike } from '../../shared/routes.js';
import { sampleElevations } from '../dem.js';

// Tyrol (10.08-12.975 E, 46.63-47.758 N) and about 8 km around it
export const ATLAS_BBOX = [9.98, 46.55, 13.08, 47.84];
export const CHUNK_Z = 10;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[atlas]', ...a);

// the main Overpass server, waiting longer after each "at capacity" (its mirrors were down when this was written)
async function overpass(query) {
  for (let attempt = 0, wait = 10000; attempt < 40; attempt++, wait = Math.min(wait * 2, 120000)) {
    try {
      const r = await fetchBuf(OVERPASS[0], { method: 'POST', body: new URLSearchParams({ data: query }), timeout: 300000, retries: 0 });
      if (r.buf) return JSON.parse(r.buf.toString('utf8'));
      log(`answer ${r.status}`);
    } catch (e) { log(e.message.split('\n')[0]); }
    await sleep(wait * (0.75 + Math.random() / 2));
  }
  throw new Error('Overpass did not answer');
}

// routes meeting one chunk, their geometry clipped to the chunk and a small margin (asking for whole long-distance
// routes from every chunk makes answers the server gives up on); the pieces are put together again afterwards
const MARGIN = 0.01;
function chunkQuery([w, s, e, n]) {
  const b = `${s - MARGIN},${w - MARGIN},${n + MARGIN},${e + MARGIN}`;
  return `[out:json][timeout:240];
(
  relation["type"="route"]["route"~"^(hiking|foot|mtb)$"](${b});
  relation["type"="route"]["route"="ski"](${b});
  relation["piste:type"="skitour"](${b});
  way["piste:type"="skitour"](${b});
  nwr["piste:type"="downhill"]["piste:difficulty"="freeride"](${b});
  nwr["piste:type"="downhill"]["piste:grooming"="backcountry"](${b});
);
out geom(${b});`;
}

// a way's nodes outside the chunk come as null: the same element from two chunks fills in each other's gaps
const fill = (a, b) => (!a ? b : !b ? a : a.map((p, i) => p || b[i]));
function mergeElement(a, b) {
  if (a.type === 'way') a.geometry = fill(a.geometry, b.geometry);
  else if (a.members?.length === b.members?.length)
    a.members.forEach((m, i) => { if (m.type === 'way') m.geometry = fill(m.geometry, b.members[i].geometry); });
}

// places to search for: towns to hamlets, peaks, saddles, huts, and valleys and ranges with their extent
function placesQuery([W, S, E, N]) {
  const b = `${S},${W},${N},${E}`;
  return `[out:json][timeout:240];
(
  node["natural"~"^(peak|saddle)$"]["name"](${b});
  nwr["tourism"~"^(alpine_hut|wilderness_hut)$"]["name"](${b});
  node["place"~"^(city|town|village|hamlet)$"]["name"](${b});
  nwr["natural"~"^(valley|mountain_range)$"]["name"](${b});
  nwr["natural"="water"]["water"="lake"]["name"](${b});
);
out bb tags;`;
}

// the places answer as points of interest (route naming, Bike & Hike goals) and the search box's place list
export function parsePlaces(json) {
  const out = [];
  for (const el of json.elements) {
    const t = el.tags || {}, bb = el.bounds;
    const at = el.type === 'node' ? [el.lon, el.lat] : bb ? [(bb.minlon + bb.maxlon) / 2, (bb.minlat + bb.maxlat) / 2] : null;
    if (!at || !t.name) continue;
    const type = t.natural === 'peak' ? 'peak' : t.natural === 'saddle' ? 'saddle' : t.tourism ? 'hut' : t.place ? 'place'
      : t.natural === 'valley' ? 'valley' : t.natural === 'mountain_range' ? 'range' : t.natural === 'water' ? 'lake' : null;
    if (!type) continue;
    out.push({ type, cls: t.place || null, name: t.name, name_de: t['name:de'] || null, ele: Number(t.ele) || null, at,
      bbox: bb && el.type !== 'node' ? [bb.minlon, bb.minlat, bb.maxlon, bb.maxlat] : null });
  }
  return out;
}

export function chunksOf(bbox) {
  const [x0, y0] = tileAt(CHUNK_Z, lonToX(bbox[0]), latToY(bbox[3])), [x1, y1] = tileAt(CHUNK_Z, lonToX(bbox[2]), latToY(bbox[1]));
  const out = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push([x, y]);
  return out;
}

async function crawl() {
  const chunks = chunksOf(ATLAS_BBOX);
  log(`${chunks.length} chunks at zoom ${CHUNK_Z}`);
  const byId = new Map();
  for (const [i, [x, y]] of chunks.entries()) {
    const key = `atlas/raw/${CHUNK_Z}_${x}_${y}.json`;
    let json = await readJSON(key);
    if (!json) {
      json = await overpass(chunkQuery(tileLonLat(CHUNK_Z, x, y)));
      await writeJSON(key, json);
      await sleep(3000);                                     // be gentle with the public Overpass server
    }
    let added = 0;
    for (const el of json.elements) {
      const id = `${el.type}/${el.id}`, old = byId.get(id);
      if (old) mergeElement(old, el); else { byId.set(id, el); added++; }
    }
    log(`chunk ${i + 1}/${chunks.length} (${x}/${y}): ${json.elements.length} elements, ${added} new, ${byId.size} so far`);
  }
  const { routes } = parseOverpass({ elements: [...byId.values()] });
  let poisJson = await readJSON('atlas/raw/places.json');
  if (!poisJson) { poisJson = await overpass(placesQuery(ATLAS_BBOX)); await writeJSON('atlas/raw/places.json', poisJson); }
  const pois = parsePlaces(poisJson);
  log(`${routes.length} routes, ${pois.length} places`);
  return { routes, pois };
}

async function main() {
  const { routes, pois } = await crawl();
  const sample = (pts) => sampleElevations(13, pts);
  for (const [i, r] of routes.entries()) {
    try { await measureRoute(r, sample); } catch { /* left without numbers */ }
    if (i % 200 === 199 || i === routes.length - 1) log(`measured ${i + 1}/${routes.length}`);
  }
  // routes that only touch the margin leave a scrap of a few metres
  const kept = routes.filter((r) => (r.stats?.length ?? 0) >= 200);
  nameRoutes(kept, pois);
  const merged = mergePieces(kept);
  const combos = bikeAndHike(merged, pois, { max: Infinity });
  for (const r of combos) { try { await measureRoute(r, sample); } catch { /* left without numbers */ } }
  log(`${merged.length} routes after merging, ${combos.length} Bike & Hike`);
  const now = new Date().toISOString();
  await writeJSON('atlas/routes.json', { bbox: ATLAS_BBOX, chunkZ: CHUNK_Z, crawled: now, routes: merged.concat(combos) });
  await writeJSON('atlas/places.json', { bbox: ATLAS_BBOX, crawled: now, places: pois });
  log('written cache/atlas/routes.json and cache/atlas/places.json');
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
