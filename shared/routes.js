// Route logic used by both the local crawler (server/crawler) and the public site's crawler (src/crawl.js):
// OpenStreetMap routes from Overpass, their names, merging of split pieces, measuring on the DEM, and Bike & Hike.
import { haversine, lineLength, simplify, buildProfile } from './geo.js';

// ---------------------------------------------------------------- OpenStreetMap via Overpass
// Hiking and mountain-bike route relations, ski tours (route=ski relations that are not pistes or cross-country
// trails, and anything tagged piste:type=skitour) and freeride runs (downhill marked freeride, or ungroomed
// backcountry "Skirouten"), with geometry clipped to the region; plus peaks, huts and villages for naming.
export const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];

export function overpassQuery([w, s, e, n]) {
  const b = `${s},${w},${n},${e}`;
  return `[out:json][timeout:180];
(
  relation["type"="route"]["route"~"^(hiking|foot|mtb)$"](${b});
  relation["type"="route"]["route"="ski"](${b});
  relation["piste:type"="skitour"](${b});
  way["piste:type"="skitour"](${b});
  nwr["piste:type"="downhill"]["piste:difficulty"="freeride"](${b});
  nwr["piste:type"="downhill"]["piste:grooming"="backcountry"](${b});
)->.r;
.r out geom(${b});
(
  node["natural"~"^(peak|saddle)$"]["name"](${b});
  nwr["tourism"~"^(alpine_hut|wilderness_hut)$"]["name"](${b});
  node["place"~"^(town|village|hamlet)$"]["name"](${b});
)->.p;
.p out center tags;`;
}

export const NUMBERED = /^(?:wanderweg|weg|steig|route|trail|nr\.?|mtb|mtb-route|bike)?\s*[a-z]{0,2}\s?\d+[a-z]?$/i;

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

const EMTB = /\be[- ]?(mtb|bike|mountainbike)\b/i;
export function kindOf(t) {
  if (t.route === 'hiking' || t.route === 'foot') return 'hike';
  if (t.route === 'mtb') return EMTB.test(`${t.name || ''} ${t.description || ''}`) || t.e_bike === 'yes' || t.ebike === 'yes' ? 'emtb' : 'mtb';
  const pt = t['piste:type'];
  if (pt === 'downhill' && (t['piste:difficulty'] === 'freeride' || t['piste:grooming'] === 'backcountry')) return 'freeride';
  if (pt === 'skitour' || (t.route === 'ski' && !pt)) return 'skitour';
  return null;                                              // groomed pistes, nordic trails, sled runs
}
const GENERIC = { skitour: 'Skitour', freeride: 'Freeride', mtb: 'MTB-Route', emtb: 'E-MTB-Route', hike: 'Wanderweg' };

// an Overpass answer as routes (with tracks, not yet measured) and points of interest
export function parseOverpass(json) {
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
    if (numbered && /^\d/.test(own.trim())) own = `${kind === 'hike' ? 'Weg' : GENERIC[kind]} ${own.trim()}`;
    const name = own || (kind === 'hike' && t.ref ? `Weg ${t.ref}` : t.ref ? `${GENERIC[kind]} ${t.ref}` : GENERIC[kind]);
    routes.push({
      id: `osm-${el.type[0]}${el.id}`, source: 'osm', kind, name, generic: !own || numbered,
      ref: t.ref || null, network: t.network || null, operator: t.operator || null,
      difficulty: t.sac_scale || t['mtb:scale'] || t['mtb:scale:imba'] || t['piste:difficulty'] || t['ski:difficulty'] || null,
      from: t.from || null, to: t.to || null, description: t.description || t.note || null,
      url: `https://www.openstreetmap.org/${el.type}/${el.id}`, website: t.website || t.url || null,
      start: lines[0][0], lines,
    });
  }
  return { routes, pois };
}

// ---------------------------------------------------------------- names and pieces
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

// ---------------------------------------------------------------- measuring
// length, climb and altitudes of a route's track; sample(points) gives elevations (the 5 m DGM level, zoom 13);
// a source's walking time is kept
export async function measureRoute(r, sample) {
  const p = await buildProfile(r.lines, sample, { step: 25, maxPts: 1500 });
  r.stats = { length: p.length, ascent: p.ascent, descent: p.descent, min: p.min, max: p.max, duration: r.stats?.duration ?? null };
  r.measured = true;
  const top = p.e.indexOf(Math.max(...p.e.filter((v) => v != null)));
  if (top >= 0) r.top = [...p.coords[top], p.e[top]];
}

// ---------------------------------------------------------------- Bike & Hike
// Ride a mountain-bike (or e-MTB) route to its highest point, where a hiking route passes, and walk that route on
// to a summit or hut clearly above. No source lists these, so each combination is one bike route's track plus the
// hiking route's stretch from the meeting point to its top.
// what counts as a day out: a ride of at most 45 km and 1800 m, then a walk of at most 8 km and 1400 m up
const RIDE_KM = 45, RIDE_UP = 1800, WALK_KM = 8, WALK_UP = 1400;
export const COMBINE_VERSION = 2;

const BIKE = new Set(['mtb', 'emtb']);
const deg = (m) => m / 111320;

// routes: measured routes (with `top` = [lon, lat, ele]); pois: peaks, huts and saddles from OSM
export function bikeAndHike(routes, pois = [], { near = 250, minGain = 200, perBike = 2, perSummit = 2, max = 120 } = {}) {
  const goals = pois.filter((p) => p.type === 'peak' || p.type === 'hut');
  const bikes = routes.filter((r) => BIKE.has(r.kind) && r.lines && r.top && (r.stats?.length ?? 0) <= RIDE_KM * 1000 && Math.max(r.stats?.ascent ?? 0, r.stats?.descent ?? 0) <= RIDE_UP);
  const hikes = routes.filter((r) => r.kind === 'hike' && r.lines && r.top).map((h) => {
    const pts = h.lines.flat();
    return { h, box: pts.reduce((b, [x, y]) => [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)], [Infinity, Infinity, -Infinity, -Infinity]) };
  });
  const goalNear = (pt) => {
    let best = null, bd = Infinity;
    for (const g of goals) {
      const d = haversine(pt, g.at), lim = g.type === 'peak' ? 400 : 250;
      if (d < lim && d + (g.type === 'peak' ? 0 : 150) < bd) { bd = d; best = g; }
    }
    return best;
  };

  const combos = [];
  for (const b of bikes) {
    const T = b.top, dLat = deg(near), dLon = dLat / Math.cos(T[1] * Math.PI / 180);
    const found = [];
    for (const { h, box } of hikes) {
      if (h.top[2] < T[2] + minGain || h.top[2] > T[2] + WALK_UP || T[0] < box[0] - dLon || T[0] > box[2] + dLon || T[1] < box[1] - dLat || T[1] > box[3] + dLat) continue;
      // where the hiking route comes closest to the bike route's top, and its own top on the same piece
      let join = null;
      h.lines.forEach((l, li) => l.forEach((p, pi) => { const d = haversine(p, T); if (d < near && (!join || d < join.d)) join = { d, li, pi }; }));
      if (!join) continue;
      const line = h.lines[join.li];
      let ti = 0;
      line.forEach((p, i) => { if (haversine(p, h.top) < haversine(line[ti], h.top)) ti = i; });
      if (haversine(line[ti], h.top) > 200) continue;
      const seg = join.pi <= ti ? line.slice(join.pi, ti + 1) : line.slice(ti, join.pi + 1).reverse();
      const goal = seg.length > 1 && lineLength(seg) <= WALK_KM * 1000 && goalNear(h.top);
      if (goal) found.push({ b, h, seg, goal, gain: h.top[2] - T[2] });
    }
    found.sort((x, y) => y.gain - x.gain);
    const goalsHere = new Set();
    for (const f of found) {
      if (goalsHere.has(f.goal.name)) continue;
      goalsHere.add(f.goal.name); combos.push(f);
      if (goalsHere.size >= perBike) break;
    }
  }

  // a summit reached from several bike routes: keep the shortest rides to it
  const bySummit = new Map();
  for (const c of combos) { const k = c.goal.name; if (!bySummit.has(k)) bySummit.set(k, []); bySummit.get(k).push(c); }
  const kept = [...bySummit.values()].flatMap((cs) => cs.sort((x, y) => (x.b.stats?.length ?? 1e9) - (y.b.stats?.length ?? 1e9)).slice(0, perSummit));
  kept.sort((x, y) => y.gain - x.gain);

  return kept.slice(0, max).map(({ b, h, seg, goal }) => ({
    id: `bh-${b.id}-${h.id}`, source: 'combined', kind: 'bikehike',
    name: `${goal.name} – ${b.name}`,
    description: `By ${b.kind === 'emtb' ? 'e-MTB' : 'mountain bike'} on “${b.name}” up to about ${Math.round(b.top[2])} m, then on foot along “${h.name}” to ${goal.name}${goal.ele ? ` (${goal.ele} m)` : ''}, and back down the same way.`,
    difficulty: h.difficulty || null, url: b.url, start: b.start,
    lines: [...b.lines, seg],
    parts: [{ role: 'bike', id: b.id, name: b.name, url: b.url, kind: b.kind, source: b.source }, { role: 'hike', id: h.id, name: h.name, url: h.url, source: h.source }],
    goal: { name: goal.name, ele: goal.ele, at: goal.at },
  }));
}

// ---------------------------------------------------------------- the whole steps
// an Overpass answer as finished routes: parsed, measured, named, split pieces merged
export async function osmRoutes(json, sample, onProgress) {
  const { routes, pois } = parseOverpass(json);
  for (const [i, r] of routes.entries()) {
    try { await measureRoute(r, sample); } catch { /* left without numbers */ }
    onProgress?.(i + 1, routes.length);
  }
  nameRoutes(routes, pois);
  return { routes: mergePieces(routes), pois };
}

// the routes with their Bike & Hike tours made anew
export async function withBikeAndHike(routes, pois, sample) {
  const base = routes.filter((r) => r.source !== 'combined');
  const combos = bikeAndHike(base, pois);
  for (const r of combos) { try { await measureRoute(r, sample); } catch { /* left without numbers */ } }
  return { routes: base.concat(combos), combos };
}
