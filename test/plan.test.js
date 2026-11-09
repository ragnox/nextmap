import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyPlan, addPoint, movePoint, insertPoint, removePoint, reverse, backToStart, outAndBack, planLine, nearestLeg,
  planFromLine, encodePlan, decodePlan, estimateTime, steepColors,
} from '../shared/plan.js';
import { buildProfile, haversine } from '../shared/geo.js';

const A = [11.8, 47.1], B = [11.81, 47.1], C = [11.82, 47.11], D = [11.83, 47.11];
const sketch = [[11.811, 47.102], [11.814, 47.105], [11.817, 47.108]];
const abc = () => addPoint(addPoint(addPoint(emptyPlan('hike', 'Test'), A), B), C, sketch);

test('waypoints and legs: the line runs through every point and every sketched point', () => {
  const p = abc();
  assert.equal(p.points.length, 3);
  assert.equal(p.legs.length, 2);
  assert.deepEqual(planLine(p), [A, B, ...sketch, C]);
});

test('moving, adding on the line and removing waypoints', () => {
  const p = abc();
  assert.deepEqual(planLine(movePoint(p, 1, D)), [A, D, ...sketch, C]);
  // a point dropped on the sketched leg between its first two vertices splits the sketch there
  const ins = insertPoint(p, 1, [11.8125, 47.1035]);
  assert.equal(ins.points.length, 4);
  assert.deepEqual(ins.legs.map((l) => l.via.length), [0, 1, 2]);
  assert.deepEqual(planLine(ins).length, planLine(p).length + 1);
  // removing a middle point joins its legs, keeping both sketches
  assert.deepEqual(planLine(removePoint(ins, 2)), planLine(p));
  assert.deepEqual(removePoint(p, 0).points, [B, C]);
  assert.deepEqual(removePoint(p, 2).legs.length, 1);
  assert.deepEqual(removePoint(removePoint(removePoint(p, 0), 0), 0).points, []);
});

test('reverse, back to the start, out and back', () => {
  const p = abc();
  assert.deepEqual(planLine(reverse(p)), planLine(p).slice().reverse());
  assert.deepEqual(backToStart(p).points.at(-1), A);
  const ob = outAndBack(p), line = planLine(p);
  assert.deepEqual(planLine(ob), [...line, ...line.slice(0, -1).reverse()]);
});

test('the leg nearest a point, in metres', () => {
  const p = abc();
  const n = nearestLeg(p, [11.805, 47.1001]);
  assert.equal(n.leg, 0);
  assert.ok(n.d > 5 && n.d < 20, `${n.d}`);
  assert.equal(nearestLeg(p, [11.8145, 47.1048]).leg, 1);
});

test('a plan survives the address bar, to the metre', () => {
  const p = abc(), back = decodePlan(encodePlan(p), 'Test');
  assert.equal(back.activity, 'hike');
  assert.equal(back.points.length, 3);
  assert.deepEqual(back.legs.map((l) => l.via.length), [0, 3]);
  planLine(back).forEach((q, i) => assert.ok(haversine(q, planLine(p)[i]) < 1));
  assert.match(encodePlan(p), /^[\w.-]+$/);
  const one = decodePlan(encodePlan(addPoint(emptyPlan('skitour'), A)));
  assert.equal(one.activity, 'skitour');
  assert.deepEqual(one.points, [A]);
  assert.throws(() => decodePlan('2.0.AA.A'));
  assert.throws(() => decodePlan('1.0.!!.A'));
});

test('a track becomes a plan with a waypoint every so often', () => {
  const line = [...Array(101).keys()].map((i) => [11.8 + i * 0.0005, 47.1 + Math.sin(i / 8) * 0.001]);   // about 3.8 km
  const p = planFromLine(line, { activity: 'mtb', every: 1000 });
  assert.ok(p.points.length >= 4 && p.points.length <= 6, `${p.points.length}`);
  assert.ok(haversine(p.points[0], line[0]) < 0.5 && haversine(p.points.at(-1), line.at(-1)) < 0.5);
  assert.ok(planLine(p).length < line.length);
});

// a profile of a straight line that climbs `up` metres over `len` metres
const ramp = (len, up) => {
  const d = [...Array(Math.round(len / 10) + 1).keys()].map((i) => i * 10);
  return { d, e: d.map((x) => 1000 + (up * x) / len), length: len, ascent: Math.max(up, 0), descent: Math.max(-up, 0) };
};

test('walking and riding times', () => {
  // DIN 33466: 8 km and 600 m up are 2 h either way, so 2 h + 1 h
  assert.equal(estimateTime('hike', ramp(8000, 600)), 3);
  assert.equal(estimateTime('hike', ramp(4000, 0)), 1);
  // Munter on skis: 4 km and 1000 m up are 14 units at 4 an hour
  assert.ok(Math.abs(estimateTime('skitour', ramp(4000, 1000)) - 3.5) < 0.05);
  // a 1000 m climb on 10 km: the climbing rate decides, faster with a motor
  const mtb = estimateTime('mtb', ramp(10000, 1000)), emtb = estimateTime('emtb', ramp(10000, 1000));
  assert.ok(mtb > 1.7 && mtb < 1.9, `${mtb}`);
  assert.ok(emtb < mtb);
  assert.equal(estimateTime('hike', null), null);
});

test('steep stretches get the colour of their class', () => {
  const flat = steepColors(ramp(1000, 20), false), steep = steepColors(ramp(1000, 250), false);
  assert.ok(flat.every((c) => c === null));
  assert.ok(steep.slice(5, -5).every((c) => c === '#ff850d'));           // 25 %
  const winter = steepColors({ ...ramp(100, 0), slope: [null, 10, 28, 31, 36, 41, 50, 0, 0, 0, 0] }, true);
  assert.deepEqual(winter.slice(0, 7), [null, null, '#bfe65a', '#ffdb1a', '#ff850d', '#e61f1a', '#8c33bf']);
});

test('profiles can carry the angle of the ground', async () => {
  // a plane rising 1 m per metre to the east: 45° (a Mercator metre is cos(latitude) metres on the ground)
  const sample = async (pts) => pts.map(([x]) => x * Math.cos(47.1 * Math.PI / 180));
  const p = await buildProfile([[[11.8, 47.1], [11.8, 47.101]]], sample, { step: 20, slope: true });
  assert.equal(p.slope.length, p.d.length);
  assert.ok(p.slope.every((s) => Math.abs(s - 45) < 0.2), p.slope.join());
  assert.equal((await buildProfile([[[11.8, 47.1], [11.8, 47.101]]], sample)).slope, undefined);
});

// ---------------------------------------------------------------- following paths
import { setRoute, needsRoute, routeKey, splitAt, parkAt, walkedLegs, legProfile, planMarks, planTime } from '../shared/plan.js';

// A to B ridden along a routed leg with a stretch to push, then on to C and D by path legs
function routed() {
  let p = { ...emptyPlan('mtb', 'Ride'), grade: 1 };
  p = addPoint(addPoint(addPoint(addPoint(p, A), B, [], 'path'), C, [], 'path'), D, [], 'path');
  p = setRoute(p, 0, { via: [[11.803, 47.1], [11.806, 47.1]], marks: [[1, 3, 'steep']] });
  p = setRoute(p, 1, { via: [[11.814, 47.105]], marks: [[0, 2, 'push']] });
  return p;
}

test('legs that follow paths: routed for their ends and profile, routed again when either changes', () => {
  const p = routed();
  assert.deepEqual(p.legs.map((l, i) => needsRoute(p, i)), [false, false, true]);
  const moved = movePoint(p, 1, [11.811, 47.101]);
  assert.deepEqual(moved.legs.map((l, i) => needsRoute(moved, i)), [true, true, true]);
  assert.deepEqual(moved.legs[0].via, [], 'straight until routed');
  assert.ok(needsRoute({ ...p, grade: 2 }, 0) && needsRoute({ ...p, activity: 'emtb' }, 1));
  const sketched = movePoint(addPoint(addPoint(emptyPlan(), A), B, sketch), 1, C);
  assert.deepEqual(sketched.legs[0].via, sketch, 'a freehand sketch stays');
  assert.deepEqual(planMarks(p), [[1, 3, 'steep'], [3, 5, 'push']]);
  assert.equal(removePoint(p, 1).legs[0].mode, 'path');
  assert.equal(removePoint(addPoint(p, [11.84, 47.12]), 4).legs.length, 3);
});

test('modes, grade, marks and the parked bike survive the link; links of version 1 still open', () => {
  const p = parkAt(routed(), 2), back = decodePlan(encodePlan(p), 'Ride');
  assert.deepEqual(back.legs.map((l) => l.mode), ['path', 'path', 'path']);
  assert.deepEqual([back.grade, back.park, back.activity], [1, 2, 'mtb']);
  assert.deepEqual(back.legs.map((l) => l.marks || []), p.legs.map((l) => l.marks || []));
  assert.deepEqual(back.legs.map((l, i) => needsRoute(back, i)), [false, false, true], 'routed legs stay routed; the unrouted one is tried again');
  const v1 = decodePlan('1.0.mmuoCom1_IlrBuShwBjlB.ACC');
  assert.deepEqual([v1.legs.map((l) => l.mode), v1.grade, v1.park], [['free', 'free'], 3, null]);
});

test('Bike & Hike: walked from where the bike is left until the route comes back to it', () => {
  const p = parkAt(routed(), 2);
  assert.deepEqual(walkedLegs(p), [false, false, true]);
  assert.deepEqual(legProfile(p, 2), { activity: 'hike', grade: 3 });
  const there = outAndBack(p);
  assert.deepEqual(walkedLegs(there), [false, false, true, true, false, false]);
  assert.equal(there.legs[5].marks.length, 0, 'too steep uphill is no mark on the way down');
  assert.deepEqual(there.legs[4].marks, [[0, 2, 'push']]);
  assert.deepEqual(walkedLegs({ ...p, activity: 'hike' }), [false, false, false]);
  // the time: ridden on the flat at 15 km/h, walked at 4 km/h
  const prof = { d: [0, 1000, 2000, 3000, 4000], e: [500, 500, 500, 500, 500], length: 4000, ascent: 0, descent: 0 };
  const half = { ...emptyPlan('mtb'), points: [[11.8, 47.1], [11.82652, 47.1], [11.85304, 47.1]], legs: [{ mode: 'free', via: [] }, { mode: 'free', via: [] }], park: 1 };
  assert.ok(Math.abs(planTime(half, prof) - (2 / 15 + 2 / 4)) < 0.02, String(planTime(half, prof)));
});

test('leaving the bike in the middle of a leg: a waypoint there, the line and marks kept on both sides', () => {
  const p = routed(), s = splitAt(p, 0, 2);
  assert.deepEqual(s.points[1], [11.806, 47.1]);
  assert.deepEqual([s.legs[0].via, s.legs[1].via], [[[11.803, 47.1]], []]);
  assert.deepEqual([s.legs[0].marks, s.legs[1].marks], [[[1, 2, 'steep']], [[0, 1, 'steep']]]);
  assert.deepEqual([needsRoute(s, 0), needsRoute(s, 1)], [false, false]);
  assert.equal(insertPoint(parkAt(p, 2), 0, [11.802, 47.1]).park, 3);
  assert.equal(removePoint(parkAt(p, 2), 1).park, 1);
  assert.equal(removePoint(parkAt(p, 2), 2).park, null);
  assert.equal(reverse(parkAt(p, 2)).park, null);
});
