// Finding the way on the path network (shared/network.js): a point snapped to the nearest way, and the quickest way
// between two points, an A* search over the tiles it reaches, loaded as it goes. Nothing is ruled out: the cost of an
// edge is the time it takes, walking, riding, or pushing and carrying the bike where riding is not on (harder than the
// chosen grade, too steep uphill, steps, signed for dismounting, against a one-way street), weighted by how welcome
// the way is (hikers keep off main roads, riders keep to tracks and the trails marked for bikes; paths harder than a
// hiker's grade, and ways closed to walkers, count three times). The stretches that are pushed, carried, harder than
// the grade or closed come back marked. Runs in the route worker (src/routeworker.js); tests feed it tiles from Node.
import { CLASSES, SURFACES, ACCESS, BAD_VISIBILITY, edgeLine } from './network.js';
import { tileLonLat, tileAt, lonToX, latToY, haversine } from './geo.js';
import { GRADES, RIDE } from './plan.js';

export const SNAP_M = 150;                               // a click this close to a way goes onto it
const ON_PATH_M = 2;                                     // a point this close is on it already (links round to ~1 m)
const MAX_KM = 60, MAX_SETTLED = 800000;
const MIN_MARK_M = 30;
const EPS = 2e-5;                                        // degrees: a junction this close to a tile edge joins tiles

// ---------------------------------------------------------------- activities
// hiking: DIN 33466 times (4 km/h, 300 m/h up, 500 m/h down), and how welcome each way is
const HIKE = { path: 1, footway: 1.05, steps: 1, bridleway: 1.05, pedestrian: 1.05, via_ferrata: 1.3, track: 1.1, service: 1.2,
  residential: 1.2, unclassified: 1.3, cycleway: 1.3, tertiary: 1.7, secondary: 2.4, primary: 3.2, trunk: 5 };
const SAC_SLOWER = [1, 1, 1.05, 1.15, 1.35, 1.6, 2];
const AVOID = 3;
// riding: how welcome each way is, how much slower each MTB grade rides, and the steepest climb still ridden
const BIKE = { track: 1, path: 1.1, cycleway: 0.95, residential: 1.05, service: 1.05, unclassified: 1.05, pedestrian: 1.5,
  footway: 1.3, bridleway: 1.2, tertiary: 1.25, secondary: 1.7, primary: 2.4, trunk: 3 };
const MTB_SLOWER = [1, 1.25, 1.6, 2.2, 3, 4];
const STEEPEST = { mtb: 0.22, emtb: 0.28 };
const TRAIL = new Set(['path', 'footway', 'bridleway']);
const PUSH = 1, CARRY = 2;

const din = (len, up, down) => { const h = len / (4000 / 3600), v = (up / 300 + down / 500) * 3600; return Math.max(h, v) + Math.min(h, v) / 2; };

// a profile: rule(kind) says how a kind of way is gone along, time() what an edge takes and mark() what is marked on it
export function profileFor({ activity = 'hike', grade } = {}) {
  const ride = RIDE[activity], g = grade ?? GRADES[activity]?.def ?? 3;
  const key = `${activity}:${g}`;
  if (!ride) {
    return {
      key, vmax: 4000 / 3600,
      rule(k) {
        const cls = CLASSES[k.cls];
        let f = (HIKE[cls] ?? 1.2) * SAC_SLOWER[k.sac], mark = null;
        if (k.flags & BAD_VISIBILITY) f *= 1.25;
        if (SURFACES[k.surface] === 'paved' && (cls === 'track' || cls === 'path')) f *= 1.1;
        if (k.sac > g || (cls === 'via_ferrata' && g < 5)) { f *= AVOID; mark = 'hard'; }
        if (ACCESS[k.foot] === 'no') { f *= AVOID; mark ||= 'closed'; }
        return { f, mark };
      },
      time: (len, up, down, r) => din(len, up, down) * r.f,
      mark: (len, up, r) => r.mark,
    };
  }
  const [flat, climb, downhill] = ride, steepest = STEEPEST[activity];
  // why the bike is pushed or carried along this edge, this way: harder than the grade or signed so ('push'), steps,
  // via ferratas and alpine paths ('carry'), against a one-way street ('against'), too steep to ride up ('steep')
  const why = (len, up, r, fwd) => (r.walk === CARRY ? 'carry' : r.walk === PUSH ? 'push' : (fwd ? r.against === 1 : r.against === 2) ? 'against'
    : len > 30 && up / len > steepest ? 'steep' : null);
  return {
    key, vmax: Math.max(flat, downhill) / 3.6 / 0.8,
    rule(k) {
      const cls = CLASSES[k.cls], bike = ACCESS[k.bike];
      const against = k.oneway === 2 ? 1 : k.oneway === 1 ? 2 : 0;       // 1: going from a to b is against it
      if (cls === 'steps' || cls === 'via_ferrata') return { f: 1, walk: CARRY, against };
      // how hard it is to ride: the MTB grade where mapped, else guessed from the hiking grade or the kind of way
      const s = k.mtb ? k.mtb - 1 : TRAIL.has(cls) ? [1, 1, 2, 3, 5, 5, 5][k.sac] : cls === 'track' && k.tracktype >= 4 ? 1 : 0;
      let f = (BIKE[cls] ?? 1.2) * (MTB_SLOWER[s] ?? 4);
      if (bike === 'designated') f *= 0.85;
      if (k.flags & BAD_VISIBILITY) f *= 1.3;
      const walk = !k.mtb && k.sac >= 4 ? CARRY : s > g || bike === 'dismount' ? PUSH : 0;
      return { f, walk, against };
    },
    time(len, up, down, r, fwd) {
      const w = why(len, up, r, fwd);
      if (w) return din(len, up, down) * (w === 'carry' ? 1.6 : 1.25);
      const t = up > down ? Math.max(len / (flat / 3.6), up / (climb / 3600)) : len / ((down / Math.max(len, 1) > 0.04 ? downhill : flat) / 3.6);
      return t * r.f;
    },
    mark: why,
  };
}

// ---------------------------------------------------------------- tiles
// the network as far as it is loaded: tiles by x/y, each with its junctions' edges and the junctions it shares with
// the tiles around it; load(x, y) gives a decoded tile (decodeTile) or null
export class Graph {
  constructor(index, load, { keep = 160 } = {}) {
    this.index = index; this.load = load; this.keep = keep;
    this.tiles = new Map();
  }
  covers([lon, lat]) { const [w, s, e, n] = this.index.bbox; return lon >= w && lon <= e && lat >= s && lat <= n; }
  has(x, y) { return !!this.index.tiles[`${x}/${y}`]; }
  // the tile if it is loaded (null where there is none), else undefined
  ready(x, y) {
    if (!this.has(x, y)) return null;
    const t = this.tiles.get(`${x}/${y}`);
    return t && !(t instanceof Promise) ? t : undefined;
  }
  tile(x, y) {
    if (!this.has(x, y)) return Promise.resolve(null);
    const k = `${x}/${y}`;
    if (!this.tiles.has(k)) {
      this.tiles.set(k, Promise.resolve(this.load(x, y)).then((t) => { const p = t && prepare(t); this.tiles.set(k, p); return p; })
        .catch((e) => { this.tiles.delete(k); throw e; }));
      if (this.tiles.size > this.keep) this.tiles.delete(this.tiles.keys().next().value);
    }
    return Promise.resolve(this.tiles.get(k));
  }
}

// a decoded tile with what the search needs: each junction's edges (k for leaving by the edge's start, ~k for its
// end), which tile edges a junction lies on, and junction ids to local indexes for those
function prepare(t) {
  const nj = t.ids.length, ne = t.ea.length, start = new Int32Array(nj + 1), adj = new Int32Array(2 * ne);
  for (let k = 0; k < ne; k++) { start[t.ea[k] + 1]++; start[t.eb[k] + 1]++; }
  for (let j = 0; j < nj; j++) start[j + 1] += start[j];
  const fill = start.slice(0, nj);
  for (let k = 0; k < ne; k++) { adj[fill[t.ea[k]]++] = k; adj[fill[t.eb[k]]++] = ~k; }
  const [w, s, e, n] = tileLonLat(t.z, t.x, t.y), side = new Uint8Array(nj), byId = new Map();
  for (let j = 0; j < nj; j++) {
    const x = t.lon[j], y = t.lat[j];
    const f = (Math.abs(x - w) < EPS ? 1 : 0) | (Math.abs(x - e) < EPS ? 2 : 0) | (Math.abs(y - n) < EPS ? 4 : 0) | (Math.abs(y - s) < EPS ? 8 : 0);
    if (f) { side[j] = f; byId.set(t.ids[j], j); }
  }
  return { ...t, start, adj, side, byId, rules: null, rulesFor: null, box: null };
}

// the tiles around a tile edge junction: west/east, north/south and the corner between
function across(t, j) {
  const f = t.side[j], dx = f & 1 ? -1 : f & 2 ? 1 : 0, dy = f & 4 ? -1 : f & 8 ? 1 : 0, out = [];
  if (dx) out.push([t.x + dx, t.y]);
  if (dy) out.push([t.x, t.y + dy]);
  if (dx && dy) out.push([t.x + dx, t.y + dy]);
  return out;
}

const rulesOf = (t, P) => { if (t.rulesFor !== P.key) { t.rules = t.kinds.map((k) => P.rule(k)); t.rulesFor = P.key; } return t.rules; };

// seconds to go along edge k of tile t, from its start (fwd) or from its end; and what is marked on it that way
const ends = (t, k, fwd) => (fwd ? [t.up[k], t.down[k]] : [t.down[k], t.up[k]]);
function cost(t, k, fwd, P) {
  const [up, down] = ends(t, k, fwd);
  return P.time(t.length[k], up, down, rulesOf(t, P)[t.kind[k]], fwd);
}
const markOf = (t, k, fwd, P) => P.mark(t.length[k], ends(t, k, fwd)[0], rulesOf(t, P)[t.kind[k]], fwd);

// ---------------------------------------------------------------- snapping
const round5 = (v) => Math.round(v * 1e5) / 1e5;

// metres from p to the segment a-b in a plane around p, and where along it (0..1)
function seg(px, py, ax, ay, bx, by, kx) {
  const Ax = (ax - px) * kx, Ay = (ay - py) * 111320, Bx = (bx - px) * kx, By = (by - py) * 111320;
  const dx = Bx - Ax, dy = By - Ay, L = dx * dx + dy * dy, t = L ? Math.max(0, Math.min(1, -(Ax * dx + Ay * dy) / L)) : 0;
  return [Math.hypot(Ax + t * dx, Ay + t * dy), t];
}

// the tiles within r metres of p
function tilesNear(graph, [lon, lat], r) {
  const z = graph.index.z, dlat = r / 111320, dlon = r / (111320 * Math.cos(lat * Math.PI / 180));
  const [x0, y0] = tileAt(z, lonToX(lon - dlon), latToY(lat + dlat)), [x1, y1] = tileAt(z, lonToX(lon + dlon), latToY(lat - dlat));
  const out = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (graph.has(x, y)) out.push([x, y]);
  return out;
}

// the nearest point on the network within r metres of p: { t (tile), k (edge), s (segment), u (0..1 along it),
// f (0..1 along the edge), at (the point on the edge), point (where the waypoint goes), d (metres) }, or null
export async function snap(graph, p, r = SNAP_M) {
  if (!graph.covers(p)) return null;
  const tiles = (await Promise.all(tilesNear(graph, p, r).map(([x, y]) => graph.tile(x, y)))).filter(Boolean);
  const [px, py] = p, kx = 111320 * Math.cos(py * Math.PI / 180), dlon = r / kx, dlat = r / 111320;
  let best = null;
  for (const t of tiles) {
    const ne = t.ea.length;
    if (!t.box) {
      t.box = new Float64Array(4 * ne);
      for (let k = 0; k < ne; k++) {
        let w = Math.min(t.lon[t.ea[k]], t.lon[t.eb[k]]), e = Math.max(t.lon[t.ea[k]], t.lon[t.eb[k]]);
        let s = Math.min(t.lat[t.ea[k]], t.lat[t.eb[k]]), n = Math.max(t.lat[t.ea[k]], t.lat[t.eb[k]]);
        for (let q = t.first[k]; q < t.first[k + 1]; q++) {
          const x = t.pts[2 * q], y = t.pts[2 * q + 1];
          if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y;
        }
        t.box.set([w, s, e, n], 4 * k);
      }
    }
    for (let k = 0; k < ne; k++) {
      const b = 4 * k;
      if (px < t.box[b] - dlon || px > t.box[b + 2] + dlon || py < t.box[b + 1] - dlat || py > t.box[b + 3] + dlat) continue;
      let ax = t.lon[t.ea[k]], ay = t.lat[t.ea[k]];
      const last = t.first[k + 1] - t.first[k];
      for (let i = 0; i <= last; i++) {
        const q = t.first[k] + i, bx = i < last ? t.pts[2 * q] : t.lon[t.eb[k]], by = i < last ? t.pts[2 * q + 1] : t.lat[t.eb[k]];
        const [d, u] = seg(px, py, ax, ay, bx, by, kx);
        if (d <= r && (!best || d < best.d)) best = { t, k, s: i, u, d };
        ax = bx; ay = by;
      }
    }
  }
  if (!best) return null;
  const line = edgeLine(best.t, best.k), a = line[best.s], b = line[best.s + 1];
  const at = [a[0] + (b[0] - a[0]) * best.u, a[1] + (b[1] - a[1]) * best.u];
  let along = 0, total = 0;
  for (let i = 1; i < line.length; i++) { const L = haversine(line[i - 1], line[i]); total += L; if (i <= best.s) along += L; }
  along += haversine(a, at);
  best.line = line; best.f = total ? along / total : 0; best.at = at;
  best.point = best.d <= ON_PATH_M ? [round5(px), round5(py)] : [round5(at[0]), round5(at[1])];
  return best;
}

// ---------------------------------------------------------------- the search
// a binary heap of [priority, payload]
class Heap {
  constructor() { this.p = []; this.v = []; }
  get size() { return this.p.length; }
  push(pri, val) {
    const p = this.p, v = this.v;
    let i = p.length; p.push(pri); v.push(val);
    while (i > 0) { const up = (i - 1) >> 1; if (p[up] <= pri) break; p[i] = p[up]; v[i] = v[up]; i = up; }
    p[i] = pri; v[i] = val;
  }
  pop() {
    const p = this.p, v = this.v, top = v[0], lp = p.pop(), lv = v.pop(), n = p.length;
    if (n) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && p[c + 1] < p[c]) c++;
        if (p[c] >= lp) break;
        p[i] = p[c]; v[i] = v[c]; i = c;
      }
      p[i] = lp; v[i] = lv;
    }
    return top;
  }
}

const TARGET = -1;

// the quickest way from a to b ([lon, lat]) for profile P: { via (the points between from and to), from, to (a and b
// on the network), marks ([first, last, why] as indexes into [from, ...via, to]), length (m), time (s) }, or
// { error } with 'outside' (not in the network's area), 'from' or 'to' (no way within SNAP_M), 'far' (too long a leg
// to search) or 'none' (no way joins them)
export async function route(graph, a, b, P) {
  if (!graph.covers(a) || !graph.covers(b)) return { error: 'outside' };
  const [A, B] = await Promise.all([snap(graph, a), snap(graph, b)]);
  if (!A) return { error: 'from' };
  if (!B) return { error: 'to' };
  if (haversine(A.at, B.at) > MAX_KM * 1000) return { error: 'far' };
  // the search stays in the tiles around the two points, and starts loading those along the straight line
  const z = graph.index.z, [ax, ay] = tileAt(z, lonToX(A.at[0]), latToY(A.at[1])), [bx, by] = tileAt(z, lonToX(B.at[0]), latToY(B.at[1]));
  const m = Math.max(2, Math.ceil(Math.max(Math.abs(ax - bx), Math.abs(ay - by)) / 2));
  const box = [Math.min(ax, bx) - m, Math.min(ay, by) - m, Math.max(ax, bx) + m, Math.max(ay, by) + m];
  const inBox = (x, y) => x >= box[0] && x <= box[2] && y >= box[1] && y <= box[3];
  for (let i = 0, n = Math.max(Math.abs(ax - bx), Math.abs(ay - by)); i <= n; i++)
    graph.tile(Math.round(ax + (bx - ax) * i / (n || 1)), Math.round(ay + (by - ay) * i / (n || 1))).catch(() => null);

  const kx = 111320 * Math.cos(B.at[1] * Math.PI / 180), h = (lon, lat) => Math.hypot((lon - B.at[0]) * kx, (lat - B.at[1]) * 111320) * 0.99 / P.vmax;
  const best = new Map(), prev = new Map(), heap = new Heap(), done = new Set();
  const reach = (id, g, t, j, how) => {
    if (!(g < (best.get(id) ?? Infinity))) return;
    best.set(id, g); prev.set(id, how);
    heap.push(g + (id === TARGET ? 0 : h(t.lon[j], t.lat[j])), [id, t, j]);
  };
  // from the start: to either end of its edge, or straight along it to the end point
  reach(A.t.ids[A.t.eb[A.k]], cost(A.t, A.k, true, P) * (1 - A.f), A.t, A.t.eb[A.k], { from: 'S', t: A.t, k: A.k, fwd: true });
  reach(A.t.ids[A.t.ea[A.k]], cost(A.t, A.k, false, P) * A.f, A.t, A.t.ea[A.k], { from: 'S', t: A.t, k: A.k, fwd: false });
  if (A.t === B.t && A.k === B.k) {
    const fwd = B.f >= A.f;
    reach(TARGET, cost(A.t, A.k, fwd, P) * Math.abs(B.f - A.f), null, 0, { from: 'S', direct: true, t: A.t, k: A.k, fwd });
  }
  const endA = B.t.ids[B.t.ea[B.k]], endB = B.t.ids[B.t.eb[B.k]];
  let settled = 0;
  while (heap.size) {
    const [id, t, j] = heap.pop();
    if (done.has(id)) continue;
    done.add(id);
    if (id === TARGET) return path(prev, A, B, best.get(TARGET), P);
    if (++settled > MAX_SETTLED) break;
    const g = best.get(id);
    // the edges of this junction: in its tile, and in the tiles it shares with
    const at = [[t, j]];
    if (t.side[j]) {
      for (const [x, y] of across(t, j)) {
        if (!inBox(x, y)) continue;
        let u = graph.ready(x, y);
        if (u === undefined) u = await graph.tile(x, y).catch(() => null);
        const lj = u?.byId.get(id);
        if (lj !== undefined) at.push([u, lj]);
      }
    }
    for (const [u, lj] of at) {
      for (let q = u.start[lj]; q < u.start[lj + 1]; q++) {
        const e = u.adj[q], fwd = e >= 0, k = fwd ? e : ~e, o = fwd ? u.eb[k] : u.ea[k];
        reach(u.ids[o], g + cost(u, k, fwd, P), u, o, { from: id, t: u, k, fwd });
      }
    }
    // the end point lies on an edge of this junction
    if (id === endA) reach(TARGET, g + cost(B.t, B.k, true, P) * B.f, null, 0, { from: id, last: true, t: B.t, k: B.k, fwd: true });
    if (id === endB) reach(TARGET, g + cost(B.t, B.k, false, P) * (1 - B.f), null, 0, { from: id, last: true, t: B.t, k: B.k, fwd: false });
  }
  return { error: 'none' };
}

// the line of the way found, from the start point to the end point, with its marked stretches
function path(prev, A, B, time, P) {
  const steps = [];
  for (let id = TARGET; ;) { const s = prev.get(id); steps.push(s); if (s.from === 'S') break; id = s.from; }
  steps.reverse();
  const line = [[round5(A.at[0]), round5(A.at[1])]], marks = [];
  // points along one step, rounded as links keep them; a marked step marks from where it starts to where it ends
  const add = (pts, why) => {
    const from = line.length - 1;
    for (const [x, y] of pts) {
      const p = [round5(x), round5(y)], l = line[line.length - 1];
      if (p[0] !== l[0] || p[1] !== l[1]) line.push(p);
    }
    if (!why || line.length - 1 === from) return;
    const m = marks[marks.length - 1];
    if (m && m[2] === why && m[1] === from) m[1] = line.length - 1; else marks.push([from, line.length - 1, why]);
  };
  for (const [i, s] of steps.entries()) {
    const why = markOf(s.t, s.k, s.fwd, P);
    if (s.direct) {                                          // along the one edge both points are on
      add(s.fwd ? A.line.slice(A.s + 1, B.s + 1) : A.line.slice(B.s + 1, A.s + 1).reverse(), why);
    } else if (i === 0) add(s.fwd ? A.line.slice(A.s + 1) : A.line.slice(0, A.s + 1).reverse(), why);
    else if (s.last) add(s.fwd ? B.line.slice(0, B.s + 1) : B.line.slice(B.s + 1).reverse(), why);
    else { const l = edgeLine(s.t, s.k); add(s.fwd ? l : l.reverse(), why); }
    if (s.last || s.direct) add([B.at], why);
  }
  const at = [0];
  for (let i = 1; i < line.length; i++) at.push(at[i - 1] + haversine(line[i - 1], line[i]));
  // a few metres from a point to the junction next to it are not worth a mark
  const kept = marks.filter(([a, b]) => at[b] - at[a] >= MIN_MARK_M);
  return { via: line.slice(1, -1), from: A.point, to: B.point, marks: kept, length: Math.round(at.at(-1)), time: Math.round(time) };
}
