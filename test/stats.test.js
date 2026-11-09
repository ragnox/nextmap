import test from 'node:test';
import assert from 'node:assert/strict';
import { allowed, tally, encode, decode, MAX_KEYS, MAX_BYTES, EVENTS } from '../shared/stats.js';
import { onRequestPost, onRequestGet } from '../functions/stats.js';
import { kindOf, record } from '../functions/up/[[path]].js';
import { period, problems, render, FREE, THRESHOLDS } from '../scripts/stats.js';

// ------------------------------------------------------------ the whitelist (shared/stats.js)
test('only listed events and values are counted; open events fold the rest into "other"', () => {
  assert.equal(allowed('region', 'Zillertal'), 'Zillertal');
  assert.equal(allowed('region', 'Innsbruck'), 'other');                 // a place, not a preset
  assert.equal(allowed('region', '<script>'), 'other');
  assert.equal(allowed('season', 'spring'), null);                       // a closed list drops the value
  assert.equal(allowed('password', 'x'), null);                          // an unknown event is dropped
  assert.equal(allowed('route', 'bergfex'), 'other');
  for (const [event, e] of Object.entries(EVENTS)) for (const v of e.values) assert.equal(allowed(event, v), v, `${event}:${v}`);
});

test('a tally merges repeats into counts and ignores what is not allowed', () => {
  const c = {};
  assert.equal(tally(c, 'region', 'Zillertal'), true);
  tally(c, 'region', 'Zillertal'); tally(c, 'region', 'Kufstein'); tally(c, 'season', 'winter');
  assert.equal(tally(c, 'camera', '47.1,11.8'), false);
  assert.equal(tally(c, 'season', 'autumn'), false);
  assert.deepEqual(c, { 'region:Zillertal': 2, 'region:other': 1, 'season:winter': 1 });
});

test('the beacon keeps the largest counts within the key and byte caps, and the Function reads it back', () => {
  const c = {};
  for (const [event, e] of Object.entries(EVENTS)) for (const v of e.values) c[`${event}:${v}`] = 1;
  c['region:Zillertal'] = 7; c['visit:phone'] = 3;
  assert.ok(Object.keys(c).length > MAX_KEYS);
  const text = encode(c), back = decode(text);
  assert.ok(text.length <= MAX_BYTES);
  assert.equal(back.length, MAX_KEYS);
  assert.deepEqual(back[0], ['region', 'Zillertal', 7]);
  assert.deepEqual(back[1], ['visit', 'phone', 3]);
});

test('the Function rejects everything that is not exactly a beacon', () => {
  assert.equal(decode(''), null);
  assert.equal(decode('not json'), null);
  assert.equal(decode('{"v":2,"c":{"region:Zillertal":1}}'), null);     // another version
  assert.equal(decode('{"v":1,"c":[]}'), null);
  assert.equal(decode('{"v":1,"c":{}}'), null);
  assert.equal(decode('{"v":1,"c":{"region:Innsbruck":1}}'), null);     // the browser normalises; the Function does not
  assert.equal(decode('{"v":1,"c":{"region:Zillertal":0}}'), null);
  assert.equal(decode('{"v":1,"c":{"region:Zillertal":1.5}}'), null);
  assert.equal(decode('{"v":1,"c":{"region:Zillertal":1e9}}'), null);
  assert.equal(decode('{"v":1,"c":{"region":1}}'), null);
  assert.equal(decode('{"v":1,"c":{"ip:1.2.3.4":1}}'), null);
  assert.equal(decode(`{"v":1,"c":{${Array.from({ length: 26 }, (_, i) => `"region:Zillertal${i}":1`).join(',')}}}`), null);
  assert.equal(decode('x'.repeat(MAX_BYTES + 1)), null);
  assert.deepEqual(decode('{"v":1,"c":{"visit:desktop":1,"planner:open":2}}'), [['visit', 'desktop', 1], ['planner', 'open', 2]]);
});

// ------------------------------------------------------------ functions/stats.js
const req = (body, headers = {}) => new Request('https://nextmap.pages.dev/stats', { method: 'POST', body, headers: { Origin: 'https://nextmap.pages.dev', 'Sec-Fetch-Site': 'same-origin', ...headers } });
const dataset = () => { const points = []; return { points, writeDataPoint: (p) => points.push(p) }; };

test('a good beacon becomes one data point per key, and the answer is always 204', async () => {
  const STATS = dataset();
  const res = await onRequestPost({ request: req('{"v":1,"c":{"visit:phone":1,"region:Zillertal":2}}'), env: { STATS } });
  assert.equal(res.status, 204);
  assert.deepEqual(STATS.points, [{ indexes: ['visit'], blobs: ['phone'], doubles: [1] }, { indexes: ['region'], blobs: ['Zillertal'], doubles: [2] }]);
});

test('a bad body, a cross-site post or an oversized one writes nothing and still answers 204', async () => {
  for (const r of [req('garbage'), req('{"v":1,"c":{"region:Zillertal":1}}', { Origin: 'https://evil.example' }),
    req('{"v":1,"c":{"region:Zillertal":1}}', { 'Sec-Fetch-Site': 'cross-site' }), req('{"v":1,"c":{"region:Zillertal":1}}', { 'Content-Length': '99999' }),
    req(`{"v":1,"c":{"region:Zillertal":1},"pad":"${'x'.repeat(MAX_BYTES)}"}`)]) {
    const STATS = dataset();
    assert.equal((await onRequestPost({ request: r, env: { STATS } })).status, 204);
    assert.equal(STATS.points.length, 0);
  }
  assert.equal((await onRequestPost({ request: req('{"v":1,"c":{"region:Zillertal":1}}'), env: {} })).status, 204);   // no dataset bound
  assert.equal(onRequestGet().status, 405);
});

// ------------------------------------------------------------ functions/up/: health points
test('the up/ Function classifies what was asked and records the outcome without throwing', () => {
  assert.equal(kindOf('wcs'), 'wcs');
  assert.equal(kindOf('tiris/Image_Schummerung/MapServer/export'), 'tiris');
  assert.equal(kindOf('s2/summer-2026/12/2200/1420.jpg'), 's2');
  assert.equal(kindOf('etc/passwd'), 'none');
  const STATS = dataset(), logs = [], log = console.log;
  console.log = (l) => logs.push(l);
  try {
    record({ STATS }, 'wcs', 'upstream', 321, 200);
    record({}, 'wcs', 'r2', 12, 200);                                   // no dataset bound: only the log line
    record({ STATS: { writeDataPoint: () => { throw new Error('quota'); } } }, 's2', 'missing', 5, 404);
  } finally { console.log = log; }
  assert.deepEqual(STATS.points, [{ indexes: ['up'], blobs: ['wcs', 'upstream'], doubles: [321, 200] }]);
  assert.deepEqual(logs, ['up wcs upstream 200 321ms', 'up wcs r2 200 12ms', 'up s2 missing 404 5ms']);
});

// ------------------------------------------------------------ scripts/stats.js: periods, thresholds, the report
const noon = new Date('2026-11-07T12:00:00Z'), evening = new Date('2026-11-07T20:00:00Z');
const fixture = (over = {}) => ({
  period: { name: 'week', from: '2026-10-31T12:00:00Z', to: '2026-11-07T12:00:00Z' },
  audience: { visits: 120, pageViews: 210, prevVisits: 100, days: [['2026-11-06', 60, 100], ['2026-11-07', 60, 110]], countries: [['Austria', 90], ['Germany', 20]], referrers: [['(none)', 100], ['bergfex.at', 20]], devices: [['desktop', 80], ['mobile', 40]], browsers: [['Safari', 70]] },
  performance: { lcpP50: 1800, lcpP75: 3100, fcpP50: 900, fcpP75: 1500 },
  functions: { days: [['2026-11-07', 4000, 3]], today: 4000, todayErrors: 3 },
  r2: { ops: [['GetObject', 50000], ['PutObject', 20]], reads: 50000, writes: 20 },
  usage: { visits: 100, events: [['visit', 'desktop', 70], ['visit', 'phone', 30], ['region', 'Zillertal', 80], ['error', 'js', 1]] },
  health: { rows: [['wcs', 'r2', 900, 40], ['wcs', 'upstream', 95, 400], ['wcs', 'upstream-error', 5, 1200]], pointsToday: 1500 },
  ...over,
});

test('a period runs to now, with the period before it for the trend', () => {
  const w = period('week', noon);
  assert.equal(w.to, noon);
  assert.equal(w.from.toISOString(), '2026-10-31T12:00:00.000Z');
  assert.equal(w.prevFrom.toISOString(), '2026-10-24T12:00:00.000Z');
  assert.equal(period('today', evening).from.toISOString(), '2026-11-07T00:00:00.000Z');
  assert.equal(period('month', noon).from.toISOString(), '2026-10-08T12:00:00.000Z');
});

test('the thresholds: quiet below them, the early warning only before 18:00 UTC, the alarm always', () => {
  assert.deepEqual(problems(fixture(), noon), []);
  const early = fixture({ functions: { days: [], today: FREE.requests * THRESHOLDS.quotaEarly, todayErrors: 0 } });
  assert.equal(problems(early, noon).length, 1);
  assert.match(problems(early, noon)[0], /70\.0% of today's free quota/);
  assert.deepEqual(problems(early, evening), []);
  const alarm = fixture({ functions: { days: [], today: FREE.requests * 0.91, todayErrors: 0 } });
  assert.match(problems(alarm, evening)[0], /91\.0% of the free/);
  assert.match(problems(fixture({ r2: { ops: [], reads: 7_500_000, writes: 0 } }), noon)[0], /R2 reads this month at 75\.0%/);
  assert.match(problems(fixture({ health: { rows: [], pointsToday: 80000 } }), noon)[0], /Analytics Engine points today at 80\.0%/);
  const tiris = fixture({ health: { rows: [['wcs', 'upstream', 80, 300], ['wcs', 'upstream-error', 20, 900]], pointsToday: 0 } });
  assert.match(problems(tiris, noon)[0], /tiris failures: 20 of 100/);
  const errors = fixture({ usage: { visits: 100, events: [['visit', 'desktop', 100], ['error', 'js', 5]] } });
  assert.match(problems(errors, noon)[0], /browser errors in 5\.0% of 100 visits/);
  // too few to judge: no alarm from 1 failure in 2 fetches or 1 error in 3 visits
  assert.deepEqual(problems(fixture({ health: { rows: [['wcs', 'upstream', 1, 1], ['wcs', 'upstream-error', 1, 1]], pointsToday: 0 }, usage: { visits: 3, events: [['error', 'js', 1]] } }), noon), []);
});

test('the report renders as text and as markdown, with a failed dataset left out rather than failing the rest', () => {
  const text = render(fixture(), 'text', noon), md = render(fixture(), 'markdown', noon);
  assert.match(text, /120 visits, 210 page loads \(\+20% vs the period before\)/);
  assert.match(text, /Austria\s+90/);
  assert.match(text, /LCP 1800 ms median, 3100 ms p75/);
  assert.match(text, /region:Zillertal\s+80\s+80\.0%/);
  assert.match(text, /today 4,000 of 100,000 free \(4\.0%\), 3 errors/);
  assert.match(text, /wcs upstream-error\s+5\s+1200 ms/);
  assert.doesNotMatch(text, /!!/);
  assert.match(md, /^# nextmap stats, week/);
  assert.match(md, /\| Day \| Visits \| Page loads \|\n\| --- \| --- \| --- \|\n\| 2026-11-06 \| 60 \| 100 \|/);
  const broken = render(fixture({ usage: { error: '403 forbidden' }, functions: { days: [], today: 95000, todayErrors: 0 } }), 'markdown', noon);
  assert.match(broken, /unavailable: 403 forbidden/);
  assert.match(broken, /\*\*Attention:\*\* Function requests today at 95\.0%/);
  assert.match(broken, /\| Austria \| 90 \|/);
});
