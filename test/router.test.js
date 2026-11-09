import test from 'node:test';
import assert from 'node:assert/strict';
import { NodeStore, Network, buildTiles } from '../server/network.js';
import { encodeTile, decodeTile } from '../shared/network.js';
import { Graph, route, snap, profileFor } from '../shared/router.js';
import { haversine, yToLat } from '../shared/geo.js';

// a small network, built and read back the way the site does it; sample(lat) gives the ground's height
async function graphOf(nodes, ways, sample = () => 1000) {
  const store = new NodeStore([11.8, 47.0, 11.9, 47.2]), ids = Object.keys(nodes).map(Number);
  store.add(ids, ids.map((i) => Math.round(nodes[i][0] * 1e7)), ids.map((i) => Math.round(nodes[i][1] * 1e7)), ids.length);
  store.finish();
  const net = new Network(store);
  for (const [refs, tags] of ways) net.addWay(refs, tags);
  const tiles = new Map();
  await buildTiles(net, { sample: async (pts) => pts.map(([, y]) => sample(yToLat(y))), put: (t) => tiles.set(`${t.x}/${t.y}`, decodeTile(encodeTile(t))) });
  const index = { z: 12, bbox: [11.8, 47.0, 11.9, 47.2], tiles: Object.fromEntries([...tiles.keys()].map((k) => [k, 1])) };
  return new Graph(index, async (x, y) => tiles.get(`${x}/${y}`) ?? null);
}

// west and east joined by a short alpine path (T4) and a forest track round the south; the tile edge (11.8652 E)
// runs between them
const NODES = { 1: [11.86, 47.08], 2: [11.864, 47.08], 3: [11.87, 47.08], 4: [11.86, 47.076], 5: [11.87, 47.076] };
const WAYS = [[[1, 2, 3], { highway: 'path', sac_scale: 'alpine_hiking' }], [[1, 4, 5, 3], { highway: 'track', oneway: 'yes' }]];
const W = [11.8601, 47.0802], E = [11.8699, 47.0802];
const south = (r) => r.via.some(([, lat]) => lat < 47.077);

test('snapping: onto the nearest way within 150 m, a point on it stays put, nothing far off', async () => {
  const g = await graphOf(NODES, WAYS);
  const s = await snap(g, [11.862, 47.0795]);
  assert.deepEqual(s.point, [11.862, 47.08]);
  assert.ok(Math.abs(s.d - 55.7) < 1);
  assert.deepEqual((await snap(g, [11.86234, 47.08])).point, [11.86234, 47.08]);
  assert.equal(await snap(g, [11.862, 47.078]), null);
});

test('hiking keeps to the grade where it can, and marks where it cannot', async () => {
  const g = await graphOf(NODES, WAYS);
  const easy = await route(g, W, E, profileFor({ activity: 'hike', grade: 3 }));
  assert.ok(south(easy), 'round by the track');
  assert.deepEqual(easy.marks, []);
  assert.deepEqual([easy.from, easy.to], [[11.8601, 47.08], [11.8699, 47.08]]);
  const line = [easy.from, ...easy.via, easy.to];
  assert.ok(line.every((p, i) => !i || haversine(line[i - 1], p) < 500), 'a line without gaps, across the tile edge');
  assert.ok(Math.abs(easy.length - 1650) < 20);
  const alpine = await route(g, W, E, profileFor({ activity: 'hike', grade: 4 }));
  assert.ok(!south(alpine) && alpine.length < 800, 'the path itself');
  // from the middle of the path the way on is the path: marked as harder than T3
  const mid = await route(g, [11.8645, 47.0801], E, profileFor({ activity: 'hike', grade: 3 }));
  assert.ok(!south(mid));
  assert.deepEqual(mid.marks.map((m) => m[2]), ['hard']);
  assert.deepEqual(mid.marks[0].slice(0, 2), [0, mid.via.length + 1]);
});

test('riding: an alpine path is carried, a one-way track is pushed against its direction', async () => {
  const g = await graphOf(NODES, WAYS), mtb = profileFor({ activity: 'mtb', grade: 2 });
  const there = await route(g, W, E, mtb);
  assert.ok(south(there));
  assert.deepEqual(there.marks, []);
  const back = await route(g, E, W, mtb);
  assert.ok(back.marks.length && back.marks.every((m) => m[2] === 'carry' || m[2] === 'against'), JSON.stringify(back.marks));
});

test('riding uphill too steep to ride is marked, downhill it is not', async () => {
  const nodes = { 10: [11.85, 47.07], 11: [11.85, 47.0718] }, ways = [[[10, 11], { highway: 'track' }]];
  const g = await graphOf(nodes, ways, (lat) => 1000 + Math.max(0, lat - 47.07) * 111320 * 0.25);
  const mtb = profileFor({ activity: 'mtb', grade: 2 });
  const up = await route(g, [11.85, 47.0701], [11.85, 47.0717], mtb);
  assert.deepEqual(up.marks.map((m) => m[2]), ['steep']);
  assert.deepEqual((await route(g, [11.85, 47.0717], [11.85, 47.0701], mtb)).marks, []);
  assert.deepEqual((await route(g, [11.85, 47.0701], [11.85, 47.0717], profileFor({ activity: 'emtb', grade: 2 }))).marks, [], 'an eMTB rides 25 %');
});

test('along one edge, outside the network, and no way near', async () => {
  const g = await graphOf(NODES, WAYS), hike = profileFor({ activity: 'hike' });
  const r = await route(g, [11.861, 47.0761], [11.865, 47.0761], hike);         // west of the tile edge
  assert.deepEqual(r.via, []);
  assert.ok(Math.abs(r.length - 303) < 3);
  assert.deepEqual(await route(g, W, [12.5, 47.1], hike), { error: 'outside' });
  assert.deepEqual(await route(g, W, [11.862, 47.078], hike), { error: 'to' });
});
