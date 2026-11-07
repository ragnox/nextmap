import test from 'node:test';
import assert from 'node:assert/strict';
import { gpxText, gpxPoints, gpxName, fileName } from '../src/gpx.js';

test('a track written as GPX reads back, name and all', () => {
  const text = gpxText('Hütte & Gipfel', [[[11.8, 47.1, 1500.5], [11.81, 47.11, null]]], 'https://nextmap.pages.dev/?plan=x');
  assert.match(text, /<name>Hütte &amp; Gipfel<\/name>/);
  assert.deepEqual(gpxPoints(text), [[11.8, 47.1], [11.81, 47.11]]);
  assert.equal(gpxName(text), 'Hütte & Gipfel');
  assert.equal(gpxName('<gpx><trk><name>Gro&#223;venediger &#x2013; Nord</name></trk></gpx>'), 'Großvenediger – Nord');
  assert.equal(fileName('Hütte & Gipfel / Tag 1'), 'Hütte  Gipfel  Tag 1.gpx');
});

test('route points, single quotes and files without a track', () => {
  assert.deepEqual(gpxPoints(`<gpx><rte><rtept lon='11.5' lat='47.2'/><rtept lat="47.3" lon="11.6"></rtept></rte></gpx>`), [[11.5, 47.2], [11.6, 47.3]]);
  assert.deepEqual(gpxPoints('<gpx><wpt lat="47" lon="11"/></gpx>'), []);
});
