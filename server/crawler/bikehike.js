// Bike & Hike tours, combined from the crawled routes: ride a mountain-bike (or e-MTB) route to its highest point,
// where a hiking route passes, and walk that route on to a summit or hut clearly above. No source lists these, so
// each combination is one bike route's track plus the hiking route's stretch from the meeting point to its top.
import { haversine, lineLength } from '../../shared/geo.js';

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
