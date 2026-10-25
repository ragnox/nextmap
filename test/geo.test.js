import test from 'node:test';
import assert from 'node:assert/strict';
import { haversine, lineLength, densify, simplify, climb } from '../server/geo.js';
import { tileBounds, tileAt, tileLonLat, lonToX, latToY, xToLon, yToLat, slug } from '../server/util.js';
import { Frame } from '../src/geo.js';

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ''} ${a} vs ${b}`);

test('distances on the sphere', () => {
  near(haversine([11, 47], [11, 48]), 111195, 50, 'one degree of latitude');
  near(haversine([11, 47], [12, 47]), 75834, 100, 'one degree of longitude at 47° N');
  near(lineLength([[11, 47], [11, 47.5], [11, 48]]), 111195, 50);
});

test('densify keeps the vertices and adds points at the step', () => {
  const d = densify([[11, 47], [11, 47.001]], 20);           // about 111 m
  assert.deepEqual(d[0], [11, 47]);
  assert.deepEqual(d.at(-1), [11, 47.001]);
  assert.equal(d.length, 7);
});

test('simplify drops points within the tolerance, keeps corners', () => {
  const line = [[11, 47], [11.0005, 47.000001], [11.001, 47], [11.001, 47.001]];
  assert.deepEqual(simplify(line, 1), [[11, 47], [11.001, 47], [11.001, 47.001]]);
});

test('climb ignores small bumps and counts real climbs', () => {
  const d = [...Array(201).keys()].map((i) => i * 10);                 // 2 km every 10 m
  const wobble = d.map((x, i) => 1000 + (i % 2 ? 3 : -3));              // ±3 m noise on the flat
  assert.deepEqual(climb(d, wobble), { up: 0, down: 0 });
  const hill = d.map((x) => 1000 + Math.min(x, 1000) * 0.3 - Math.max(x - 1000, 0) * 0.3);   // 300 m up, 300 m down
  const c = climb(d, hill);
  assert.ok(Math.abs(c.up - 300) < 20 && Math.abs(c.down - 300) < 20, JSON.stringify(c));
  assert.deepEqual(climb([0, 10], [null, null]), { up: 0, down: 0 });
});

test('Web Mercator tiles: projection round trip and tile lookup', () => {
  near(xToLon(lonToX(11.865)), 11.865, 1e-9);
  near(yToLat(latToY(47.17)), 47.17, 1e-9);
  const [x, y] = tileAt(14, lonToX(11.865), latToY(47.165));
  assert.deepEqual([x, y], [8731, 5751]);
  const [w, s, e, n] = tileLonLat(14, x, y);
  assert.ok(w <= 11.865 && e > 11.865 && s <= 47.165 && n > 47.165);
  const [x0, y0, x1, y1] = tileBounds(14, x, y);
  near(x1 - x0, y1 - y0, 1e-6, 'tiles are square in Mercator');
});

test('client frame: true metres around the origin, north is -z', () => {
  const f = new Frame(11.865, 47.17);
  const [x, z] = f.fromLonLat(11.865, 47.18);
  near(x, 0, 1e-6);
  near(-z, 1112, 3, '0.01° north is about 1.1 km');
  const [lon, lat] = f.toLonLat(5000, -3000);
  const [x2, z2] = f.fromLonLat(lon, lat);
  near(x2, 5000, 1e-6); near(z2, -3000, 1e-6);
  const [tx, tz, size] = f.tileRect(14, 8731, 5751);
  const [cx, cz] = f.tileAt(14, tx + size / 2, tz + size / 2);
  assert.deepEqual([cx, cz], [8731, 5751]);
});

test('slugs for region names', () => {
  assert.equal(slug('Ötztal'), 'otztal');
  assert.equal(slug('Kitzbüheler Alpen'), 'kitzbuheler-alpen');
});
