import test from 'node:test';
import assert from 'node:assert/strict';
import { parseState, stateQuery } from '../src/urlstate.js';

test('a view survives the round trip through the address bar', () => {
  const st = {
    region: 'Kitzbüheler Alpen', camera: { lat: 47.4123456, lon: 12.3456789, alt: 2350.4, heading: -20, pitch: -32.25 },
    season: 'winter', imagery: 'tiris', hybrid: true, layers: ['slope', 'bergwege'], routes: false, kind: 'skitour', route: 'osm-r123', sun: 60,
  };
  const q = stateQuery(st);
  assert.match(q, /camera=47\.41235,12\.34568,2350,340\.0,-32\.3/);
  const back = parseState(`?${q}`);
  assert.equal(back.region, 'Kitzbüheler Alpen');
  assert.deepEqual(back.camera, { lat: 47.41235, lon: 12.34568, alt: 2350, heading: 340, pitch: -32.3 });
  assert.deepEqual([back.season, back.imagery, back.hybrid, back.routes, back.kind, back.route, back.sun], ['winter', 'tiris', true, false, 'skitour', 'osm-r123', 60]);
  assert.deepEqual(back.layers, ['slope', 'bergwege']);
});

test('defaults stay out of the link, nonsense falls back to them', () => {
  assert.equal(stateQuery({ region: 'Zillertal', season: 'summer', imagery: 'ortho', hybrid: false, layers: [], routes: true, kind: 'all', sun: 45 }), 'region=Zillertal');
  const st = parseState('?camera=1,2,x&season=autumn&imagery=bing&layers=slope,evil&sun=abc');
  assert.equal(st.camera, null); assert.equal(st.season, 'summer'); assert.equal(st.imagery, 'ortho');
  assert.deepEqual(st.layers, ['slope']); assert.equal(st.sun, 45);
});
