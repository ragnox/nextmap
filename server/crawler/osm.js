// OpenStreetMap routes in the region via the Overpass API: hiking route relations and ski tours (route=ski relations
// that are not pistes or cross-country trails, and anything tagged piste:type=skitour). Geometry is kept, clipped to
// the region, so the routes can be drawn on the terrain.
import { fetchBuf } from '../util.js';
import { simplify } from '../geo.js';

const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];

function query([w, s, e, n]) {
  const b = `${s},${w},${n},${e}`;
  return `[out:json][timeout:180];
(
  relation["type"="route"]["route"~"^(hiking|foot)$"](${b});
  relation["type"="route"]["route"="ski"](${b});
  relation["piste:type"="skitour"](${b});
  way["piste:type"="skitour"](${b});
)->.r;
.r out geom(${b});
(
  node["natural"~"^(peak|saddle)$"]["name"](${b});
  nwr["tourism"~"^(alpine_hut|wilderness_hut)$"]["name"](${b});
  node["place"~"^(town|village|hamlet)$"]["name"](${b});
)->.p;
.p out center tags;`;
}

export const NUMBERED = /^(?:wanderweg|weg|steig|route|trail|nr\.?)?\s*[a-z]{0,2}\s?\d+[a-z]?$/i;

// geometry clipped to the bounding box has nulls where it leaves the box: split there
export function pieces(geom) {
  const out = []; let cur = [];
  for (const p of geom) {
    if (p) cur.push(p);
    else { if (cur.length > 1) out.push(cur); cur = []; }
  }
  if (cur.length > 1) out.push(cur);
  return out;
}

// join way geometries into as few lines as possible by matching end points
export function chain(ways) {
  const segs = ways.map((g) => g.map((p) => [p.lon, p.lat])).filter((g) => g.length > 1);
  const same = (a, b) => Math.abs(a[0] - b[0]) < 1e-7 && Math.abs(a[1] - b[1]) < 1e-7;
  const lines = [];
  while (segs.length) {
    let line = segs.shift(), grown = true;
    while (grown) {
      grown = false;
      for (let i = 0; i < segs.length; i++) {
        const s = segs[i], head = line[0], tail = line[line.length - 1];
        if (same(tail, s[0])) line = line.concat(s.slice(1));
        else if (same(tail, s[s.length - 1])) line = line.concat(s.slice(0, -1).reverse());
        else if (same(head, s[s.length - 1])) line = s.concat(line.slice(1));
        else if (same(head, s[0])) line = s.slice(1).reverse().concat(line);
        else continue;
        segs.splice(i, 1); grown = true; break;
      }
    }
    lines.push(line);
  }
  return lines;
}

export function kindOf(t) {
  if (t.route === 'hiking' || t.route === 'foot') return 'hike';
  const pt = t['piste:type'];
  if (pt === 'skitour' || (t.route === 'ski' && !pt)) return 'skitour';
  return null;                                              // downhill pistes, nordic trails, sled runs
}

export async function crawlOsm(region, log) {
  let json = null, lastErr;
  for (const url of ENDPOINTS) {
    try {
      log(`Overpass: asking ${new URL(url).host}`);
      const r = await fetchBuf(url, { method: 'POST', body: new URLSearchParams({ data: query(region.bbox) }), timeout: 200000, retries: 1 });
      if (r.buf) { json = JSON.parse(r.buf.toString('utf8')); break; }
    } catch (e) { lastErr = e; log(`Overpass: ${new URL(url).host} failed (${e.message})`); }
  }
  if (!json) throw lastErr || new Error('Overpass did not answer');
  const routes = [], pois = [];
  for (const el of json.elements) {
    const t = el.tags || {};
    const poiType = t.natural || (t.tourism ? 'hut' : t.place ? 'place' : null);
    if (poiType && !t.route && !t['piste:type']) {
      const c = el.type === 'node' ? [el.lon, el.lat] : el.center ? [el.center.lon, el.center.lat] : null;
      if (c) pois.push({ type: poiType, name: t.name, ele: Number(t.ele) || null, at: c });
      continue;
    }
    const kind = kindOf(t);
    if (!kind) continue;
    const geoms = el.type === 'way' ? [el.geometry || []] : (el.members || []).filter((m) => m.type === 'way' && m.geometry).map((m) => m.geometry);
    const ways = geoms.flatMap(pieces);
    const lines = chain(ways).map((l) => simplify(l, 4)).filter((l) => l.length > 1);
    if (!lines.length) continue;
    let own = t.name || t['name:de'] || (t.from && t.to ? `${t.from} – ${t.to}` : null);
    // a trail number ("5", "26a", "Wanderweg 21") says nothing about where the route goes
    const numbered = own && NUMBERED.test(own.trim()) && !['iwn', 'nwn'].includes(t.network);
    if (numbered && /^\d/.test(own.trim())) own = `Weg ${own.trim()}`;
    const name = own || (kind === 'skitour' ? 'Skitour' : t.ref ? `Weg ${t.ref}` : 'Wanderweg');
    routes.push({
      id: `osm-${el.type[0]}${el.id}`, source: 'osm', kind, name, generic: !own || numbered,
      ref: t.ref || null, network: t.network || null, operator: t.operator || null,
      difficulty: t.sac_scale || t['piste:difficulty'] || t['ski:difficulty'] || null,
      from: t.from || null, to: t.to || null, description: t.description || t.note || null,
      url: `https://www.openstreetmap.org/${el.type}/${el.id}`, website: t.website || t.url || null,
      start: lines[0][0], lines,
    });
  }
  routes.pois = pois;
  log(`Overpass: ${routes.length} routes (${routes.filter((r) => r.kind === 'hike').length} hiking, ${routes.filter((r) => r.kind === 'skitour').length} ski touring)`);
  return routes;
}
