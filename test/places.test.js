import test from 'node:test';
import assert from 'node:assert/strict';
import { packPlaces, unpackPlaces, searchPlaces, findPlace, regionFromPlace, fold } from '../shared/places.js';

const raw = [
  { type: 'place', cls: 'town', name: 'Mayrhofen', at: [11.8634567, 47.1671234], ele: 633 },
  { type: 'place', cls: 'hamlet', name: 'Mayrhofer Berg', at: [11.85, 47.17] },
  { type: 'valley', name: 'Zillertal', at: [11.86, 47.28], bbox: [11.82, 47.16, 11.9, 47.4] },
  { type: 'peak', name: 'Kreuzjoch', at: [11.93, 47.24], ele: 2558 },
  { type: 'peak', name: 'Kreuzjoch', at: [11.38, 47.06], ele: 2104 },
  { type: 'hut', name: 'Ötztaler Hütte', name_de: 'Ötztaler Hütte', at: [10.9, 46.9] },
  { type: 'place', cls: 'locality', name: 'Somewhere', at: [11, 47] },
];
const places = unpackPlaces(JSON.parse(JSON.stringify(packPlaces(raw))));

test('places survive packing, without the kinds the search does not know', () => {
  assert.equal(places.length, 6);
  assert.deepEqual(places[0], { name: 'Mayrhofen', type: 'town', at: [11.86346, 47.16712], ele: 633, bbox: null, near: null, key: 'mayrhofen' });
  assert.deepEqual(places[2].bbox, [11.82, 47.16, 11.9, 47.4]);
});

test('each place knows the town next to it, and a valley in pieces is one', () => {
  assert.equal(places[1].near, 'Mayrhofen');
  assert.equal(places[3].near, 'Mayrhofen');                        // the Kreuzjoch above Mayrhofen
  assert.equal(places[4].near, null);                               // the other one is far from any town here
  const valley = unpackPlaces(packPlaces([
    { type: 'valley', name: 'Kaisertal', at: [12.2, 47.6], bbox: [12.18, 47.58, 12.22, 47.6] },
    { type: 'valley', name: 'Kaisertal', at: [12.25, 47.6], bbox: [12.22, 47.59, 12.28, 47.61] },
    { type: 'valley', name: 'Kaisertal', at: [10.0, 47.0], bbox: [9.99, 46.99, 10.01, 47.01] },
  ]));
  assert.deepEqual(valley.map((v) => v.bbox), [[12.18, 47.58, 12.28, 47.61], [9.99, 46.99, 10.01, 47.01]]);
});

test('the search finds names by their start, ignoring case and accents', () => {
  assert.equal(fold('Ötztaler Hütte'), 'otztaler hutte');
  assert.deepEqual(searchPlaces(places, 'mayr').map((p) => p.name), ['Mayrhofen', 'Mayrhofer Berg']);
  assert.deepEqual(searchPlaces(places, 'otztal').map((p) => p.name), ['Ötztaler Hütte']);
  assert.deepEqual(searchPlaces(places, 'berg').map((p) => p.name), ['Mayrhofer Berg']);
  assert.deepEqual(searchPlaces(places, 'z'), []);
  // the higher of two peaks of the same name comes first, and both are listed
  assert.deepEqual(searchPlaces(places, 'kreuzjoch').map((p) => p.ele), [2558, 2104]);
});

test('a name shared by several places means the one nearest the camera', () => {
  assert.equal(findPlace(places, 'Kreuzjoch').ele, 2558);
  assert.equal(findPlace(places, 'kreuzjoch', [11.4, 47.1]).ele, 2104);
  assert.equal(findPlace(places, 'Nowhere'), null);
});

test('a place becomes a region around it, a valley one over its whole length', () => {
  const town = regionFromPlace(places[0]);
  assert.equal(town.slug, 'mayrhofen');
  const [w, s, e, n] = town.bbox;
  assert.ok(Math.abs((n - s) * 111.32 - 20) < 0.1 && e - w > n - s);
  const valley = regionFromPlace(places[2]).bbox;
  assert.ok(valley[1] < 47.16 && valley[3] > 47.4 && valley[1] > 47.13);
});
