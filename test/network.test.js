import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import Pbf from 'pbf';
import { readPbf } from '../server/osmpbf.js';
import { wayKind, NodeStore, Network, cutLine, buildTiles, upDown } from '../server/network.js';
import { encodeTile, decodeTile, edgeLine, fetchTile, CLASSES, ACCESS, SURFACES, NET_Z } from '../shared/network.js';
import { lineLength, lonToX } from '../shared/geo.js';

// ---------------------------------------------------------------- a small PBF file
function pbfFile(blocks) {
  const parts = [];
  for (const [type, msg] of blocks) {
    const blob = new Pbf();
    blob.writeVarintField(2, msg.length);
    blob.writeBytesField(3, zlib.deflateSync(msg));
    const body = blob.finish();
    const head = new Pbf();
    head.writeStringField(1, type);
    head.writeVarintField(3, body.length);
    const hb = head.finish(), len = Buffer.alloc(4);
    len.writeUInt32BE(hb.length);
    parts.push(len, hb, body);
  }
  return Buffer.concat(parts);
}
const message = (fn) => { const p = new Pbf(); fn(p); return p.finish(); };
const delta = (a) => a.map((v, i) => (i ? v - a[i - 1] : v));
const block = (strings, groups) => message((p) => {
  p.writeMessage(1, (s, pb) => s.forEach((x) => pb.writeBytesField(1, Buffer.from(x))), strings);
  for (const g of groups) p.writeMessage(2, g);
});

test('the PBF reader: header, dense nodes with large ids, and only the ways with the key asked for', async () => {
  const header = message((p) => {
    p.writeStringField(4, 'OsmSchema-V0.6'); p.writeStringField(4, 'DenseNodes'); p.writeStringField(5, 'Sort.Type_then_ID');
    p.writeVarintField(32, 1767225600); p.writeStringField(34, 'https://example.org/updates');
  });
  const ids = [100, 101, 102, 103, 5000000000], lat = [471000000, 471001000, 471002000, 471003000, 470999999], lon = [118000000, 118001000, 118002000, 118003000, 117999999];
  const nodes = block([''], [(g, pb) => pb.writeMessage(2, (d, q) => { q.writePackedSVarint(1, delta(ids)); q.writeMessage(5, (i, r) => r.writePackedVarint(1, ids.map(() => 1))); q.writePackedSVarint(8, delta(lat)); q.writePackedSVarint(9, delta(lon)); })]);
  const S = ['', 'highway', 'path', 'sac_scale', 'mountain_hiking', 'building', 'yes'];
  const way = (id, k, v, refs) => (w, pb) => { pb.writeVarintField(1, id); pb.writePackedVarint(2, k); pb.writePackedVarint(3, v); pb.writePackedSVarint(8, delta(refs)); };
  const ways = block(S, [(g, pb) => {
    pb.writeMessage(3, way(1, [1, 3], [2, 4], [100, 101, 102]));
    pb.writeMessage(3, way(2, [5], [6], [101, 102, 103]));
    pb.writeMessage(3, way(3, [1], [2], [102, 103, 5000000000]));
  }]);
  const buildings = block(['', 'building', 'yes'], [(g, pb) => pb.writeMessage(3, way(4, [1], [2], [100, 101]))]);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nm-')), 'test.osm.pbf');
  fs.writeFileSync(file, pbfFile([['OSMHeader', header], ['OSMData', nodes], ['OSMData', ways], ['OSMData', buildings]]));
  const seen = { nodes: [], ways: [] };
  const h = await readPbf(file, {
    nodes: (i, x, y, n) => { for (let k = 0; k < n; k++) seen.nodes.push([i[k], x[k], y[k]]); },
    way: (id, refs, tags) => seen.ways.push([id, [...refs], tags]),
    wayKey: 'highway',
  });
  assert.equal(h.timestamp, '2026-01-01T00:00:00.000Z');
  assert.deepEqual(h.optional, ['Sort.Type_then_ID']);
  assert.deepEqual(seen.nodes, ids.map((id, i) => [id, lon[i], lat[i]]));
  assert.deepEqual(seen.ways, [[1, [100, 101, 102], { highway: 'path', sac_scale: 'mountain_hiking' }], [3, [102, 103, 5000000000], { highway: 'path' }]]);
});

// ---------------------------------------------------------------- which ways
test('way kinds: grades, surfaces and access kept; private, motor-only and areas left out', () => {
  const k = (t) => wayKind(t);
  const path = k({ highway: 'path', sac_scale: 'demanding_mountain_hiking', 'mtb:scale': '2+', surface: 'rock', trail_visibility: 'bad' });
  assert.equal(CLASSES[path.cls], 'path'); assert.equal(path.sac, 3); assert.equal(path.mtb, 3); assert.equal(SURFACES[path.surface], 'rock'); assert.equal(path.flags, 1);
  const track = k({ highway: 'track', tracktype: 'grade2', surface: 'gravel', access: 'agricultural;forestry', bicycle: 'designated' });
  assert.equal(track.tracktype, 2); assert.equal(ACCESS[track.foot], 'default'); assert.equal(ACCESS[track.bike], 'designated');
  assert.equal(k({ highway: 'service', access: 'private' }), null);
  assert.equal(ACCESS[k({ highway: 'service', access: 'private', foot: 'yes' }).foot], 'yes');
  assert.equal(k({ highway: 'trunk', motorroad: 'yes' }), null);
  assert.equal(k({ highway: 'motorway' }), null);
  assert.equal(k({ highway: 'pedestrian', area: 'yes' }), null);
  assert.equal(k({ highway: 'service', service: 'parking_aisle' }), null);
  assert.equal(k({ highway: 'primary', junction: 'roundabout' }).oneway, 1);
  assert.equal(k({ highway: 'residential', oneway: 'yes', 'oneway:bicycle': 'no' }).oneway, 0);
  assert.equal(ACCESS[k({ highway: 'footway', bicycle: 'dismount' }).bike], 'dismount');
  assert.equal(k({ highway: 'path', sac_scale: 'T4' }).sac, 4);
});

// ---------------------------------------------------------------- edges and tiles
// tile x 2183 at zoom 12 starts at 11.865234375 E
const EDGE = 11.865234375;
function smallNetwork() {
  const nodes = new NodeStore([11.8, 47.0, 11.9, 47.2]);
  const N = { 1: [11.86, 47.08], 2: [11.863, 47.08], 3: [11.868, 47.08], 4: [11.87, 47.08], 5: [11.863, 47.078], 6: [11.863, 47.082], 9: [12.5, 47.08] };
  const ids = Object.keys(N).map(Number);
  nodes.add(ids, ids.map((i) => Math.round(N[i][0] * 1e7)), ids.map((i) => Math.round(N[i][1] * 1e7)), ids.length);
  nodes.finish();
  const net = new Network(nodes);
  net.addWay([1, 2, 3, 4, 9], { highway: 'track' });           // node 9 is outside: the way ends at 4
  net.addWay([5, 2, 6], { highway: 'path', sac_scale: 'hiking' });
  net.addWay([1, 2], { highway: 'building' });                 // no path
  return { net, N };
}

test('ways split at junctions; nodes outside the area cut the way', () => {
  const { net } = smallNetwork();
  const e = net.edges();
  const lines = [...Array(e.count).keys()].map((i) => net.line(e.from[i], e.to[i]).map(([x]) => x));
  assert.deepEqual(lines, [[11.86, 11.863], [11.863, 11.868, 11.87], [11.863, 11.863], [11.863, 11.863]]);
});

test('cutting at tile edges: pieces join at the crossing point, nothing lost', () => {
  const line = [[11.863, 47.08], [11.868, 47.08], [11.87, 47.08]];
  const pieces = cutLine(line, NET_Z);
  assert.deepEqual(pieces.map((p) => p.x), [2182, 2183]);
  assert.equal(pieces[0].pts.at(-1), pieces[1].pts[0]);
  assert.ok(Math.abs(pieces[0].pts.at(-1)[0] - EDGE) < 1e-9);
  assert.ok(Math.abs(pieces.reduce((s, p) => s + lineLength(p.pts), 0) - lineLength(line)) < 1e-6);
  // a diagonal through a tile corner, and a line along nothing but one tile
  assert.equal(cutLine([[11.85, 47.07], [11.86, 47.08]], NET_Z).length, 1);
  const corner = cutLine([[EDGE - 0.01, 47.0], [EDGE + 0.01, 47.2]], NET_Z);
  assert.ok(corner.length >= 3 && corner.every((p, i) => !i || p.pts[0] === corner[i - 1].pts.at(-1)));
});

test('tiles: the junction on the tile edge has one id in both, climbs follow the ground', async () => {
  const { net } = smallNetwork();
  const tiles = [];
  // the ground rises 1 m every 10 m to the east
  const x0 = lonToX(11.86);
  const totals = await buildTiles(net, { sample: async (pts) => pts.map(([x]) => 1000 + (x - x0) * 0.0682), put: (t) => tiles.push(t) });
  assert.deepEqual(tiles.map((t) => t.x), [2182, 2183]);
  assert.equal(totals.edges, 5);
  const [west, east] = tiles;
  const shared = west.junctions.filter((j) => east.junctions.some((k) => k.id === j.id));
  assert.equal(shared.length, 1);
  assert.ok(Math.abs(shared[0].lon - EDGE) < 1e-9);
  const ids = new Set([...west.junctions, ...east.junctions].map((j) => j.id));
  assert.equal(ids.size, 6);                                   // 1, 2, 4, 5, 6 and the crossing
  const eastEdge = east.edges[0];
  assert.ok(eastEdge.up > 0 && eastEdge.down === 0);
  assert.ok(Math.abs(totals.length - lineLength([[11.86, 47.08], [11.87, 47.08]]) - lineLength([[11.863, 47.078], [11.863, 47.082]])) < 0.01);
  assert.deepEqual(upDown([1, 3, null, 2, 5]), { up: 5, down: 1 });
});

test('the tile format round trip, through deflate as the site serves it', async () => {
  const { net } = smallNetwork();
  const tiles = [];
  await buildTiles(net, { sample: async (pts) => pts.map(() => 1500), put: (t) => tiles.push(t) });
  const t = tiles[0], buf = encodeTile(t), d = decodeTile(buf);
  assert.deepEqual([d.z, d.x, d.y], [t.z, t.x, t.y]);
  assert.deepEqual(d.kinds, t.kinds);
  assert.equal(d.ids.length, t.junctions.length);
  for (let k = 0; k < d.ea.length; k++) {
    const line = edgeLine(d, k), e = t.edges.find((x) => Math.abs(x.length - d.length[k]) < 0.5 && t.junctions[x.a].id === d.ids[d.ea[k]]);
    assert.ok(e, 'edge found');
    assert.equal(line.length, e.pts.length + 2);
    assert.ok(Math.abs(line[0][0] - t.junctions[e.a].lon) < 1e-5 && Math.abs(line.at(-1)[1] - t.junctions[e.b].lat) < 1e-5);
  }
  const url = `data:application/octet-stream;base64,${zlib.deflateRawSync(buf).toString('base64')}`;
  assert.deepEqual((await fetchTile(url)).ids, d.ids);
  assert.throws(() => decodeTile(new Uint8Array([1, 2, 3])), /not a tile/);
});
