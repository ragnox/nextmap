// nextmap's path network: every road, track and path of the atlas area usable on foot or by bike, as edges from
// junction to junction, in zoom-12 tiles (about 6.7 km across in Tyrol). Built by scripts/network.js from
// OpenStreetMap; the route planner will search it in the browser.
//
// A tile is one deflate-raw stream of varints:
//   'NMN' 1, z x y
//   kinds:     n, then per kind the KIND fields (class, surface, grades, access ...)
//   junctions: n, then per junction its id (delta from the last; ids are the same in every tile, so a junction on a
//              tile edge joins the tiles) and lon/lat in 1e-5 degrees (zigzag delta from the last junction)
//   edges:     n, then per edge a (delta from the last edge's a), b (zigzag delta from a), kind, length (m),
//              climb and descent from a to b (m), the number of points between a and b, and those points (zigzag
//              deltas in 1e-5 degrees, starting from a)
// Edges are cut where they cross a tile edge, so every edge lies in one tile and the cut point is a junction of both.

export const NET_Z = 12;
export const NET_VERSION = 1;
const MAGIC = [0x4e, 0x4d, 0x4e];                           // NMN
const Q = 1e5;

// OSM highway values kept, as classes (the order is the format: append only)
export const CLASSES = ['trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'service', 'track',
  'pedestrian', 'footway', 'steps', 'path', 'cycleway', 'bridleway', 'via_ferrata'];
export const SURFACES = ['unknown', 'paved', 'compacted', 'gravel', 'ground', 'rock'];
// foot and bicycle access: as tagged, else what the class implies
export const ACCESS = ['default', 'yes', 'designated', 'no', 'dismount'];
// the fields of a kind, each a small number
export const KIND = ['cls', 'surface', 'tracktype', 'sac', 'mtb', 'foot', 'bike', 'oneway', 'flags'];
// flags
export const BAD_VISIBILITY = 1;

// ---------------------------------------------------------------- varints
class Writer {
  constructor() { this.buf = new Uint8Array(1 << 16); this.n = 0; }
  byte(b) { if (this.n === this.buf.length) { const g = new Uint8Array(this.buf.length * 2); g.set(this.buf); this.buf = g; } this.buf[this.n++] = b; }
  uint(v) {
    if (!(v >= 0) || v > Number.MAX_SAFE_INTEGER || v !== Math.floor(v)) throw new Error(`network: bad varint ${v}`);
    while (v >= 128) { this.byte((v % 128) | 128); v = Math.floor(v / 128); }
    this.byte(v);
  }
  int(v) { this.uint(v < 0 ? -2 * v - 1 : 2 * v); }
  done() { return this.buf.subarray(0, this.n); }
}
class Reader {
  constructor(buf) { this.buf = buf; this.pos = 0; }
  uint() {
    let v = 0, m = 1, b;
    do { b = this.buf[this.pos++]; if (b === undefined) throw new Error('network: tile ends early'); v += (b & 127) * m; m *= 128; } while (b >= 128);
    return v;
  }
  int() { const v = this.uint(); return v % 2 ? -(v + 1) / 2 : v / 2; }
}

const q = (deg) => Math.round(deg * Q);

// tile = { z, x, y, kinds: [{cls, surface, ...}], junctions: [{id, lon, lat}], edges: [{a, b, kind, length, up, down, pts: [[lon, lat], ...]}] }
// with a and b indexes into junctions and pts the points between them; returns the bytes before deflating
export function encodeTile({ z, x, y, kinds, junctions, edges }) {
  const w = new Writer();
  MAGIC.forEach((b) => w.byte(b));
  w.uint(NET_VERSION); w.uint(z); w.uint(x); w.uint(y);
  w.uint(kinds.length);
  for (const k of kinds) for (const f of KIND) w.uint(k[f] || 0);
  // junctions in id order, edges by their first junction
  const order = junctions.map((_, i) => i).sort((i, j) => junctions[i].id - junctions[j].id), at = new Int32Array(junctions.length);
  order.forEach((j, i) => { at[j] = i; });
  w.uint(junctions.length);
  let id = 0, lon = 0, lat = 0;
  for (const j of order) {
    const J = junctions[j], X = q(J.lon), Y = q(J.lat);
    w.uint(J.id - id); w.int(X - lon); w.int(Y - lat);
    id = J.id; lon = X; lat = Y;
  }
  const es = edges.map((e) => ({ ...e, a: at[e.a], b: at[e.b] })).sort((e, f) => e.a - f.a);
  w.uint(es.length);
  let a = 0;
  for (const e of es) {
    w.uint(e.a - a); w.int(e.b - e.a); w.uint(e.kind); w.uint(Math.round(e.length)); w.uint(Math.round(e.up)); w.uint(Math.round(e.down));
    a = e.a;
    const J = junctions[order[e.a]];
    let px = q(J.lon), py = q(J.lat);
    w.uint(e.pts.length);
    for (const [plon, plat] of e.pts) { const X = q(plon), Y = q(plat); w.int(X - px); w.int(Y - py); px = X; py = Y; }
  }
  return w.done();
}

// the bytes of a tile (inflated) as flat typed arrays: junction i at (lon[i], lat[i]) with global id ids[i]; edge k
// from ea[k] to eb[k], its points between them at pts[2*p], pts[2*p+1] for p in [first[k], first[k+1])
export function decodeTile(buf) {
  const r = new Reader(buf);
  if (MAGIC.some((b, i) => buf[i] !== b)) throw new Error('network: not a tile');
  r.pos = 3;
  const version = r.uint();
  if (version !== NET_VERSION) throw new Error(`network: tile version ${version}`);
  const z = r.uint(), x = r.uint(), y = r.uint();
  const kinds = [];
  for (let i = 0, n = r.uint(); i < n; i++) kinds.push(Object.fromEntries(KIND.map((f) => [f, r.uint()])));
  const nj = r.uint(), ids = new Float64Array(nj), lon = new Float64Array(nj), lat = new Float64Array(nj);
  for (let i = 0, id = 0, X = 0, Y = 0; i < nj; i++) {
    id += r.uint(); X += r.int(); Y += r.int();
    ids[i] = id; lon[i] = X / Q; lat[i] = Y / Q;
  }
  const ne = r.uint(), ea = new Int32Array(ne), eb = new Int32Array(ne), kind = new Uint16Array(ne);
  const length = new Uint32Array(ne), up = new Uint16Array(ne), down = new Uint16Array(ne), first = new Uint32Array(ne + 1);
  let pts = new Float64Array(1024), np = 0;
  for (let k = 0, a = 0; k < ne; k++) {
    a += r.uint(); ea[k] = a; eb[k] = a + r.int();
    kind[k] = r.uint(); length[k] = r.uint(); up[k] = r.uint(); down[k] = r.uint();
    first[k] = np;
    let X = Math.round(lon[a] * Q), Y = Math.round(lat[a] * Q);
    for (let i = 0, n = r.uint(); i < n; i++) {
      X += r.int(); Y += r.int();
      if (2 * np + 2 > pts.length) { const g = new Float64Array(pts.length * 2); g.set(pts); pts = g; }
      pts[2 * np] = X / Q; pts[2 * np + 1] = Y / Q; np++;
    }
  }
  first[ne] = np;
  return { z, x, y, kinds, ids, lon, lat, ea, eb, kind, length, up, down, first, pts: pts.slice(0, 2 * np) };
}

// an edge's whole line, a to b, as [lon, lat] points
export function edgeLine(t, k) {
  const line = [[t.lon[t.ea[k]], t.lat[t.ea[k]]]];
  for (let p = t.first[k]; p < t.first[k + 1]; p++) line.push([t.pts[2 * p], t.pts[2 * p + 1]]);
  line.push([t.lon[t.eb[k]], t.lat[t.eb[k]]]);
  return line;
}

// the tile x/y of the network with this index (data/net.json, or api/net locally), null where it has none; the
// path is relative to the page
export const tileUrl = (index, x, y) => (index?.tiles[`${x}/${y}`] ? `${index.path}/${index.z}/${x}/${y}.bin` : null);

// a tile fetched and inflated (browser or Node 18+), or null where the network has no tile
export async function fetchTile(url) {
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`network: ${res.status} ${url}`);
  const raw = res.body.pipeThrough(new DecompressionStream('deflate-raw'));
  return decodeTile(new Uint8Array(await new Response(raw).arrayBuffer()));
}
