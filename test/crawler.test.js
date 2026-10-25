import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRobots, robotsAllows } from '../server/crawler/polite.js';
import { parseTour } from '../server/crawler/bergfex.js';
import { pieces, chain, kindOf, NUMBERED } from '../server/crawler/osm.js';
import { nameRoutes, mergePieces } from '../server/crawler/index.js';

test('robots.txt: our own group beats *, longest rule wins, wildcards', () => {
  const groups = parseRobots(`
User-agent: *
Disallow: /suchen/
Disallow: /*provider=*
Allow: /touren/

User-agent: GPTBot
User-agent: nextmap
Disallow: /private/
Allow: /private/ok$
`);
  assert.equal(robotsAllows(groups, '/suchen/x'), true, 'the * group does not apply when ours exists');
  assert.equal(robotsAllows(groups, '/private/a'), false);
  assert.equal(robotsAllows(groups, '/private/ok'), true);
  assert.equal(robotsAllows(groups, '/private/ok/more'), false, '$ anchors the end');

  const star = parseRobots('User-agent: *\nDisallow: /suchen/\nDisallow: /*provider=*\nUser-agent:\nDisallow: /');
  assert.equal(robotsAllows(star, '/suchen/q'), false);
  assert.equal(robotsAllows(star, '/login?provider=Google'), false);
  assert.equal(robotsAllows(star, '/sommer/zillertal/touren/'), true, 'an empty User-agent line is nobody');
  assert.equal(robotsAllows([], '/anything'), true, 'no robots.txt: everything allowed');
});

test('bergfex tour page: start point, stats, difficulty', () => {
  const html = `<html><head>
<meta property="og:title" content="Torhelm 2452m - Skitour Tirol - bergfex">
<meta name="description" content="Von der K&uuml;hlen Rast zum Torhelm.\nDauer: 3:23 h mit 1.191 m Anstieg über 12,58 km, Schwierigkeit: mittel">
<meta name="geoposition" content="47.182359,11.962769,13,o">
</head><body><div>Dauer 03:23 h</div><div>Aufstieg 1.191 hm</div><div>Seehöhe 1.196 - 2.438 m</div></body></html>`;
  const r = parseTour(html, 'https://www.bergfex.at/sommer/tirol/touren/skitour/2110561,torhelm-2452m/', 'skitour');
  assert.equal(r.id, 'bergfex-2110561');
  assert.equal(r.name, 'Torhelm 2452m');
  assert.equal(r.kind, 'skitour');
  assert.deepEqual(r.start, [11.962769, 47.182359]);
  assert.equal(r.difficulty, 'mittel');
  assert.deepEqual(r.stats, { length: 12580, ascent: 1191, min: 1196, max: 2438, duration: 3 + 23 / 60 });
  assert.equal(parseTour('<html></html>', 'https://www.bergfex.at/x/1,y/', 'wanderung'), null, 'no start point, no route');
});

test('OSM: clipped geometry splits at nulls, ways chain end to end', () => {
  const P = (lon, lat) => ({ lon, lat });
  assert.deepEqual(pieces([P(0, 0), P(1, 0), null, P(5, 5), null, P(6, 6), P(7, 7)]).map((p) => p.length), [2, 2]);
  // three ways, the middle one reversed, given out of order
  const lines = chain([[P(2, 0), P(3, 0)], [P(0, 0), P(1, 0)], [P(2, 0), P(1, 0)]]);
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0], [[0, 0], [1, 0], [2, 0], [3, 0]]);
  assert.equal(chain([[P(0, 0), P(1, 0)], [P(5, 5), P(6, 6)]]).length, 2, 'gaps stay separate lines');
});

test('OSM: what counts as a hiking route, a ski tour, a bare trail number', () => {
  assert.equal(kindOf({ route: 'hiking' }), 'hike');
  assert.equal(kindOf({ route: 'ski' }), 'skitour');
  assert.equal(kindOf({ route: 'ski', 'piste:type': 'nordic' }), null);
  assert.equal(kindOf({ 'piste:type': 'skitour' }), 'skitour');
  assert.equal(kindOf({ 'piste:type': 'downhill' }), null);
  for (const n of ['5', '26a', 'Wanderweg 21', 'Weg 11', 'AW 05']) assert.ok(NUMBERED.test(n), n);
  for (const n of ['Zillerpromenade 1', 'Adlerweg', 'Berliner Höhenweg Etappe 3']) assert.ok(!NUMBERED.test(n), n);
});

test('unnamed routes take the summit at their top, split ski tours merge', () => {
  const pois = [
    { type: 'peak', name: 'Rastkogel', at: [11.8, 47.25] },
    { type: 'hut', name: 'Rastkogelhütte', at: [11.81, 47.252] },
    { type: 'place', name: 'Vorderlanersbach', at: [11.75, 47.2] },
  ];
  const tour = (id, top) => ({ id, kind: 'skitour', name: 'Skitour', generic: true, start: [11.76, 47.21], top,
    url: `https://www.openstreetmap.org/way/${id}`, lines: [[[11.76, 47.21], top.slice(0, 2)]],
    stats: { length: 3000, ascent: 900, descent: 0, min: 1300, max: top[2], duration: null } });
  const routes = [tour(1, [11.8001, 47.2501, 2762]), tour(2, [11.8003, 47.2502, 2700]), tour(3, [11.70, 47.10, 2000])];
  nameRoutes(routes, pois);
  assert.equal(routes[0].name, 'Skitour → Rastkogel');
  assert.equal(routes[2].name, 'Skitour · Vorderlanersbach', 'nothing on top: named after the nearest village');
  const merged = mergePieces(routes);
  assert.equal(merged.length, 2);
  const rk = merged.find((r) => r.name === 'Skitour → Rastkogel');
  assert.equal(rk.lines.length, 2);
  assert.equal(rk.stats.max, 2762);
  assert.equal(rk.stats.length, 6000);
});
