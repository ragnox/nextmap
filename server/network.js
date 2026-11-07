// Building the path network (shared/network.js) from an OpenStreetMap extract, for scripts/network.js: which ways
// count and what is kept of their tags, the ways split into edges from junction to junction, the edges cut where
// they cross a tile edge, and every edge measured (length, climb and descent on the elevation model).
import { NET_Z, CLASSES, SURFACES, ACCESS, BAD_VISIBILITY } from '../shared/network.js';
import { HALF, tileSize, lonToX, latToY, xToLon, yToLat, lineLength, densify, simplify } from '../shared/geo.js';

// ---------------------------------------------------------------- which ways, and their kind
const CLASS_OF = {
  trunk: 'trunk', trunk_link: 'trunk', primary: 'primary', primary_link: 'primary', secondary: 'secondary',
  secondary_link: 'secondary', tertiary: 'tertiary', tertiary_link: 'tertiary', unclassified: 'unclassified', road: 'unclassified',
  residential: 'residential', living_street: 'residential', service: 'service', track: 'track', pedestrian: 'pedestrian',
  footway: 'footway', steps: 'steps', path: 'path', cycleway: 'cycleway', bridleway: 'bridleway', via_ferrata: 'via_ferrata',
};
const SURFACE_OF = Object.fromEntries([
  ['paved', 'paved asphalt concrete concrete:plates concrete:lanes paving_stones sett cobblestone unhewn_cobblestone metal wood chipseal bricks'],
  ['compacted', 'compacted fine_gravel'],
  ['gravel', 'gravel pebblestone unpaved shells'],
  ['ground', 'dirt earth ground grass grass_paver mud sand woodchips soil clay'],
  ['rock', 'rock stone bare_rock scree'],
].flatMap(([s, list]) => list.split(' ').map((v) => [v, SURFACES.indexOf(s)])));
const SAC = { hiking: 1, mountain_hiking: 2, demanding_mountain_hiking: 3, alpine_hiking: 4, demanding_alpine_hiking: 5, difficult_alpine_hiking: 6 };
const SKIP_SERVICE = new Set(['parking_aisle', 'drive-through']);

// an access value as one of ACCESS (undefined where the tag does not say)
function access(v) {
  if (v == null) return undefined;
  v = v.split(';')[0].trim();
  if (v === 'designated' || v === 'official') return 'designated';
  if (v === 'no' || v === 'private') return 'no';
  if (v === 'dismount') return 'dismount';
  if (v === 'yes' || v === 'permissive' || v === 'destination' || v === 'customers') return 'yes';
  return 'default';                                          // agricultural, forestry, permit, use_sidepath ...
}

// the kind of a way (KIND fields), or null where it is no road or path for walking or cycling
export function wayKind(t) {
  const cls = CLASS_OF[t.highway];
  if (!cls || t.area === 'yes' || t.indoor === 'yes' || SKIP_SERVICE.has(t.service)) return null;
  const general = t.motorroad === 'yes' ? 'no' : access(t.access);
  const foot = access(t.foot) ?? (general === 'no' ? 'no' : 'default');
  const mtb = access(t.mtb);
  const bike = access(t.bicycle) ?? (mtb && mtb !== 'default' ? mtb : undefined) ?? (access(t.vehicle) === 'no' || general === 'no' ? 'no' : 'default');
  if (foot === 'no' && (bike === 'no' || bike === 'dismount')) return null;
  const ow = t['oneway:bicycle'] ?? (t.junction === 'roundabout' ? 'yes' : t.oneway);
  const sac = SAC[t.sac_scale] ?? (Number(/^T([1-6])/i.exec(t.sac_scale || '')?.[1]) || 0);
  const mtbScale = /^([0-6])/.exec(t['mtb:scale'] || '')?.[1];
  return {
    cls: CLASSES.indexOf(cls),
    surface: SURFACE_OF[t.surface] ?? 0,
    tracktype: Number(/^grade([1-5])$/.exec(t.tracktype || '')?.[1]) || 0,
    sac,
    mtb: mtbScale == null ? 0 : Number(mtbScale) + 1,
    foot: ACCESS.indexOf(foot),
    bike: ACCESS.indexOf(bike),
    oneway: ow === 'yes' || ow === 'true' || ow === '1' ? 1 : ow === '-1' || ow === 'reverse' ? 2 : 0,
    flags: /^(bad|horrible|no)$/.test(t.trail_visibility || '') ? BAD_VISIBILITY : 0,
  };
}

// ---------------------------------------------------------------- nodes in the area
// node ids with their coordinates (1e-7 degrees), kept sorted by id for lookups
export class NodeStore {
  constructor([w, s, e, n]) {
    this.box = [w, s, e, n].map((v) => Math.round(v * 1e7));
    this.count = 0; this.sorted = true;
    this.ids = new Float64Array(1 << 20); this.lon = new Int32Array(1 << 20); this.lat = new Int32Array(1 << 20);
  }
  add(ids, lons, lats, n) {
    const [w, s, e, N] = this.box;
    for (let i = 0; i < n; i++) {
      const x = lons[i], y = lats[i];
      if (x < w || x > e || y < s || y > N) continue;
      if (this.count === this.ids.length) this.resize(this.count * 2);
      if (this.count && ids[i] <= this.ids[this.count - 1]) this.sorted = false;
      this.ids[this.count] = ids[i]; this.lon[this.count] = x; this.lat[this.count] = y;
      this.count++;
    }
  }
  resize(n) {
    for (const k of ['ids', 'lon', 'lat']) { const a = new this[k].constructor(n); a.set(this[k].subarray(0, Math.min(n, this.count))); this[k] = a; }
  }
  finish() {
    this.resize(this.count);
    if (this.sorted) return this;
    const order = new Uint32Array(this.count).map((_, i) => i).sort((a, b) => this.ids[a] - this.ids[b]);
    for (const k of ['ids', 'lon', 'lat']) this[k] = this[k].constructor.from(order, (i) => this[k][i]);
    this.sorted = true;
    return this;
  }
  find(id) {
    let lo = 0, hi = this.count - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1, v = this.ids[mid];
      if (v < id) lo = mid + 1; else if (v > id) hi = mid - 1; else return mid;
    }
    return -1;
  }
}

// ---------------------------------------------------------------- ways to edges
const grow = (a, n) => { if (n <= a.length) return a; const g = new a.constructor(Math.max(n, a.length * 2)); g.set(a); return g; };

// the kept ways as runs of node indexes (a way leaving the area is cut where its nodes are missing), and then the
// edges: runs split at every node that more than one way uses, or one way twice, and at the ends
export class Network {
  constructor(nodes) {
    this.nodes = nodes;
    this.kinds = []; this.kindIndex = new Map();
    this.refs = new Int32Array(1 << 20); this.nrefs = 0;
    this.runs = []; this.ways = 0;
  }
  addWay(refs, tags) {
    const kind = wayKind(tags);
    if (!kind) return;
    // the kind is listed once the way turns out to be in the area
    let start = this.nrefs, k = -1;
    const listed = () => {
      const key = Object.values(kind).join(',');
      if (!this.kindIndex.has(key)) { this.kindIndex.set(key, this.kinds.length); this.kinds.push(kind); }
      return this.kindIndex.get(key);
    };
    const flush = () => {
      if (this.nrefs - start >= 2) { if (k < 0) k = listed(); this.runs.push(start, this.nrefs, k); } else this.nrefs = start;
      start = this.nrefs;
    };
    for (let i = 0; i < refs.length; i++) {
      const n = this.nodes.find(refs[i]);
      if (n < 0) { flush(); continue; }
      if (this.nrefs > start && this.refs[this.nrefs - 1] === n) continue;
      this.refs = grow(this.refs, this.nrefs + 1);
      this.refs[this.nrefs++] = n;
    }
    flush();
    if (k >= 0) this.ways++;
  }
  // edges as [from, to] offsets into refs (inclusive) and a kind
  edges() {
    const use = new Uint8Array(this.nodes.count), R = this.refs, runs = this.runs;
    for (let r = 0; r < runs.length; r += 3) {
      for (let i = runs[r]; i < runs[r + 1]; i++) if (use[R[i]] < 255) use[R[i]]++;
      use[R[runs[r]]] = Math.max(use[R[runs[r]]], 2); use[R[runs[r + 1] - 1]] = Math.max(use[R[runs[r + 1] - 1]], 2);
    }
    let from = new Int32Array(1 << 16), to = new Int32Array(1 << 16), kind = new Int32Array(1 << 16), n = 0;
    for (let r = 0; r < runs.length; r += 3) {
      let s = runs[r];
      for (let i = s + 1; i < runs[r + 1]; i++) {
        if (use[R[i]] < 2) continue;
        if (n === from.length) { from = grow(from, n + 1); to = grow(to, n + 1); kind = grow(kind, n + 1); }
        from[n] = s; to[n] = i; kind[n] = runs[r + 2]; n++;
        s = i;
      }
    }
    return { count: n, from: from.subarray(0, n), to: to.subarray(0, n), kind: kind.subarray(0, n) };
  }
  line(from, to) {
    const out = [];
    for (let i = from; i <= to; i++) { const n = this.refs[i]; out.push([this.nodes.lon[n] / 1e7, this.nodes.lat[n] / 1e7]); }
    return out;
  }
}

// ---------------------------------------------------------------- tiles
// a line ([lon, lat] points) cut where it crosses tile edges at zoom z: [{x, y, pts}], each piece within one tile,
// a piece starting with the very point the one before ends with
export function cutLine(line, z = NET_Z) {
  const s = tileSize(z), M = line.map(([lon, lat]) => [(lonToX(lon) + HALF) / s, (HALF - latToY(lat)) / s]);
  const pieces = [];
  let cur = null;
  for (let i = 0; i + 1 < line.length; i++) {
    const [ax, ay] = M[i], [bx, by] = M[i + 1], ts = [0, 1];
    for (let k = Math.floor(Math.min(ax, bx)) + 1; k <= Math.max(ax, bx); k++) { const t = (k - ax) / (bx - ax); if (t > 0 && t < 1) ts.push(t); }
    for (let k = Math.floor(Math.min(ay, by)) + 1; k <= Math.max(ay, by); k++) { const t = (k - ay) / (by - ay); if (t > 0 && t < 1) ts.push(t); }
    ts.sort((a, b) => a - b);
    const point = (t) => (t === 0 ? line[i] : t === 1 ? line[i + 1] : [xToLon((ax + (bx - ax) * t) * s - HALF), yToLat(HALF - (ay + (by - ay) * t) * s)]);
    for (let j = 0; j + 1 < ts.length; j++) {
      const t0 = ts[j], t1 = ts[j + 1];
      if (t1 - t0 < 1e-12) continue;                           // a tile corner: both edges at once
      const tm = (t0 + t1) / 2, x = Math.floor(ax + (bx - ax) * tm), y = Math.floor(ay + (by - ay) * tm);
      if (!cur || cur.x !== x || cur.y !== y) {
        const start = cur ? cur.pts.at(-1) : line[0];
        if (cur) pieces.push(cur);
        cur = { x, y, pts: [start] };
      }
      cur.pts.push(point(t1));
    }
  }
  if (cur) pieces.push(cur);
  return pieces;
}

// spread the low 12 bits of v to the even bits: Morton order within a tile, so junction ids near each other are
// near each other on the map (small deltas in the tiles)
const spread = (v) => { v &= 0xfff; v = (v | (v << 8)) & 0x00ff00ff; v = (v | (v << 4)) & 0x0f0f0f0f; v = (v | (v << 2)) & 0x33333333; return (v | (v << 1)) & 0x55555555; };
function spaceKey(lon, lat, z) {
  const s = tileSize(z), mx = (lonToX(lon) + HALF) / s, my = (HALF - latToY(lat)) / s, tx = Math.floor(mx), ty = Math.floor(my);
  const qx = Math.min(4095, Math.floor((mx - tx) * 4096)), qy = Math.min(4095, Math.floor((my - ty) * 4096));
  return (ty * 2 ** z + tx) * 2 ** 24 + (spread(qx) | (spread(qy) << 1));
}

// climb and descent along elevations, every rise and fall counted (they add up along a route, edge after edge)
export function upDown(e) {
  let up = 0, down = 0, last = null;
  for (const v of e) {
    if (v == null) continue;
    if (last != null) { if (v > last) up += v - last; else down += last - v; }
    last = v;
  }
  return { up, down };
}

// every tile of the network, handed to `put(tile)` one by one (shared/network.js encodeTile takes it);
// sample(mercator points) gives elevations
export async function buildTiles(net, { z = NET_Z, sample, put, step = 20, tolerance = 1.5, log = () => {} }) {
  const E = net.edges(), nodes = net.nodes;
  log(`${E.count} edges from ${net.ways} ways`);
  // the tiles each edge passes, and where it crosses a tile edge (new junctions)
  const buckets = new Map(), crossBase = new Int32Array(E.count + 1), cross = [];
  for (let e = 0; e < E.count; e++) {
    const pieces = cutLine(net.line(E.from[e], E.to[e]), z);
    crossBase[e] = cross.length / 2;
    const seen = new Set();
    pieces.forEach((p, i) => {
      if (i) cross.push(p.pts[0][0], p.pts[0][1]);
      const k = p.y * 2 ** z + p.x;
      if (!seen.has(k)) { seen.add(k); if (!buckets.has(k)) buckets.set(k, []); buckets.get(k).push(e); }
    });
  }
  const ncross = cross.length / 2;
  crossBase[E.count] = ncross;
  // junction ids in space order: nodes where edges end, then the crossings
  const jnode = [];
  { const mark = new Uint8Array(nodes.count);
    for (let e = 0; e < E.count; e++) for (const n of [net.refs[E.from[e]], net.refs[E.to[e]]]) if (!mark[n]) { mark[n] = 1; jnode.push(n); } }
  const nj = jnode.length + ncross, keys = new Float64Array(nj);
  jnode.forEach((n, i) => { keys[i] = spaceKey(nodes.lon[n] / 1e7, nodes.lat[n] / 1e7, z); });
  for (let c = 0; c < ncross; c++) keys[jnode.length + c] = spaceKey(cross[2 * c], cross[2 * c + 1], z);
  const order = new Uint32Array(nj).map((_, i) => i).sort((a, b) => keys[a] - keys[b]);
  const nodeId = new Int32Array(nodes.count).fill(-1), crossId = new Int32Array(ncross);
  order.forEach((j, id) => { if (j < jnode.length) nodeId[jnode[j]] = id; else crossId[j - jnode.length] = id; });
  log(`${nj} junctions (${ncross} on tile edges), ${buckets.size} tiles`);

  const totals = { tiles: 0, edges: 0, junctions: nj, length: 0, byClass: {} };
  for (const k of [...buckets.keys()].sort((a, b) => a - b)) {
    const tx = k % 2 ** z, ty = Math.floor(k / 2 ** z);
    const pieces = [];
    for (const e of buckets.get(k)) {
      const cut = cutLine(net.line(E.from[e], E.to[e]), z);
      cut.forEach((p, i) => {
        if (p.x !== tx || p.y !== ty) return;
        const a = i === 0 ? nodeId[net.refs[E.from[e]]] : crossId[crossBase[e] + i - 1];
        const b = i === cut.length - 1 ? nodeId[net.refs[E.to[e]]] : crossId[crossBase[e] + i];
        pieces.push({ a, b, kind: E.kind[e], pts: p.pts });
      });
    }
    // elevations every `step` metres along each piece, in one go for the tile
    const dense = pieces.map((p) => densify(p.pts, step)), flat = dense.flat();
    const elev = await sample(flat.map(([lon, lat]) => [lonToX(lon), latToY(lat)]));
    const junctions = [], local = new Map(), kinds = [], kindAt = new Map();
    const jAt = (id, [lon, lat]) => { if (!local.has(id)) { local.set(id, junctions.length); junctions.push({ id, lon, lat }); } return local.get(id); };
    const edges = [];
    let o = 0;
    for (const [i, p] of pieces.entries()) {
      const { up, down } = upDown(elev.slice(o, o + dense[i].length));
      o += dense[i].length;
      if (!kindAt.has(p.kind)) { kindAt.set(p.kind, kinds.length); kinds.push(net.kinds[p.kind]); }
      const length = lineLength(p.pts), cls = CLASSES[net.kinds[p.kind].cls];
      edges.push({ a: jAt(p.a, p.pts[0]), b: jAt(p.b, p.pts.at(-1)), kind: kindAt.get(p.kind), length, up, down, pts: simplify(p.pts, tolerance).slice(1, -1) });
      totals.length += length; totals.byClass[cls] = (totals.byClass[cls] || 0) + length;
    }
    totals.tiles++; totals.edges += edges.length;
    await put({ z, x: tx, y: ty, kinds, junctions, edges });
    if (totals.tiles % 50 === 0) log(`${totals.tiles}/${buckets.size} tiles`);
  }
  return totals;
}
