// A route planned on the map: waypoints joined by legs. A leg is freehand (`mode: 'free'`), the straight line between
// its two waypoints or the line sketched by hand in between (`via`), or follows the path network (`mode: 'path'`),
// with the routed line as `via`, the stretches to push or carry the bike (or harder than the grade) as `marks`
// ([first, last, why] indexes into the leg's line) and as `key` what it was routed for (routeKey): when the waypoints,
// the activity or the grade change, the key no longer matches and the leg is routed again.
// A bike route can leave the bike at a waypoint (`park`): from there it is walked until it comes back to that point.
// Plans are values: every edit returns a new plan, so undo is a list of the earlier ones.
import { haversine, lineLength, simplify, climb } from './geo.js';

export const ACTIVITIES = ['hike', 'mtb', 'emtb', 'skitour'];
// riding: speed on the flat (km/h), climbing (m/h) and downhill (km/h)
export const RIDE = { mtb: [15, 550, 18], emtb: [18, 900, 20] };
// the grade a route keeps to: hiking by the SAC scale (T1-T6), riding by the MTB scale (S0-S5); harder is marked
export const GRADES = {
  hike: { scale: 'T', min: 1, max: 6, def: 3 }, skitour: { scale: 'T', min: 1, max: 6, def: 6 },
  mtb: { scale: 'S', min: 0, max: 5, def: 2 }, emtb: { scale: 'S', min: 0, max: 5, def: 2 },
};
const WALK = { activity: 'hike', grade: GRADES.hike.def };

export const emptyPlan = (activity = 'hike', name = '') => ({ name, activity, grade: GRADES[activity].def, park: null, points: [], legs: [] });
const leg = (via = [], mode = 'free') => ({ mode, via });
// a leg whose shape no longer fits: a path leg goes straight until it is routed again
const reset = (l) => (l.mode === 'path' ? leg([], 'path') : l);

// ---------------------------------------------------------------- editing
export function addPoint(plan, p, via = [], mode = 'free') {
  if (!plan.points.length) return { ...plan, points: [p], legs: [] };
  return { ...plan, points: [...plan.points, p], legs: [...plan.legs, leg(via, mode)] };
}

export function movePoint(plan, i, p) {
  const points = plan.points.slice(), legs = plan.legs.slice();
  points[i] = p;
  for (const j of [i - 1, i]) if (legs[j]) legs[j] = reset(legs[j]);
  return { ...plan, points, legs };
}

// a new waypoint at p on leg i; the leg's line is split where p is closest to it
export function insertPoint(plan, i, p) {
  const line = legLine(plan, i), { via, mode } = plan.legs[i];
  const s = nearestSegment(line, p).seg;                // line[s]..line[s + 1], and line[k] is via[k - 1]
  const legs = [...plan.legs.slice(0, i), leg(via.slice(0, s), mode), leg(via.slice(s), mode), ...plan.legs.slice(i + 1)];
  return { ...plan, park: plan.park != null && plan.park > i ? plan.park + 1 : plan.park, points: [...plan.points.slice(0, i + 1), p, ...plan.points.slice(i + 1)], legs };
}

// a waypoint at point k of leg i's line (0 < k < its length - 1), the line kept as it is on both sides
export function splitAt(plan, i, k) {
  const line = legLine(plan, i), l = plan.legs[i];
  const marks = l.marks || [], cut = (lo, hi, off) => marks.filter(([a, b]) => b > lo && a < hi).map(([a, b, w]) => [Math.max(a, lo) - off, Math.min(b, hi) - off, w]);
  const first = { ...l, via: line.slice(1, k), marks: cut(0, k, 0) }, second = { ...l, via: line.slice(k + 1, -1), marks: cut(k, line.length - 1, k) };
  const next = { ...plan, park: plan.park != null && plan.park > i ? plan.park + 1 : plan.park,
    points: [...plan.points.slice(0, i + 1), line[k], ...plan.points.slice(i + 1)], legs: [...plan.legs.slice(0, i), first, second, ...plan.legs.slice(i + 1)] };
  // routed legs keep counting as routed for their new ends
  for (const j of [i, i + 1]) if (next.legs[j].mode === 'path' && l.key === routeKey(plan, i)) next.legs[j] = { ...next.legs[j], key: routeKey(next, j) };
  return next;
}

// without waypoint i; the legs on either side become one
export function removePoint(plan, i) {
  const n = plan.points.length;
  if (n <= 1) return { ...plan, park: null, points: [], legs: [] };
  const points = plan.points.filter((_, k) => k !== i), a = plan.legs[i - 1], b = plan.legs[i];
  const legs = i === 0 ? plan.legs.slice(1) : i === n - 1 ? plan.legs.slice(0, -1)
    : [...plan.legs.slice(0, i - 1), leg([...a.via, ...b.via], a.mode === 'path' && b.mode === 'path' ? 'path' : 'free'), ...plan.legs.slice(i + 1)];
  const park = plan.park == null || plan.park === i ? null : plan.park > i ? plan.park - 1 : plan.park;
  return { ...plan, park, points, legs: legs.map((l, j) => (j === i - 1 && i > 0 && i < n - 1 ? reset(l) : l)) };
}

export const reverse = (plan) => ({
  ...plan, park: null, points: plan.points.slice().reverse(),
  legs: plan.legs.slice().reverse().map((l) => ({ mode: l.mode, via: l.via.slice().reverse() })),
});
export const backToStart = (plan, mode = 'free') => (plan.points.length > 1 ? addPoint(plan, plan.points[0], [], mode) : plan);
// the same way back: routed legs stay as they are, their marks mirrored (but not the climbs too steep to ride, which
// are downhill now, nor the one-way streets)
export function outAndBack(plan) {
  if (plan.points.length < 2) return plan;
  const n = plan.legs.length, back = plan.legs.slice().reverse().map((l, j) => {
    if (l.mode !== 'path') return { mode: l.mode, via: l.via.slice().reverse() };
    const L = l.via.length + 1;
    return { ...l, via: l.via.slice().reverse(), marks: (l.marks || []).filter((m) => m[2] !== 'steep' && m[2] !== 'against').map(([a, b, w]) => [L - b, L - a, w]), routed: l.key === routeKey(plan, n - 1 - j) };
  });
  const next = { ...plan, points: [...plan.points, ...plan.points.slice(0, -1).reverse()], legs: [...plan.legs, ...back] };
  next.legs = next.legs.map((l, j) => {
    if (j < n || !('routed' in l)) return l;
    const { routed, ...rest } = l;
    return routed ? { ...rest, key: routeKey(next, j) } : rest;
  });
  return next;
}

// ---------------------------------------------------------------- following the path network
// the legs walked: from the waypoint the bike is left at until the route comes back to it
export function walkedLegs(plan) {
  const out = plan.legs.map(() => false);
  if (plan.park == null || !RIDE[plan.activity] || !plan.points[plan.park]) return out;
  const depot = plan.points[plan.park];
  for (let i = plan.park; i < plan.legs.length; i++) {
    out[i] = true;
    if (haversine(plan.points[i + 1], depot) < 25) break;
  }
  return out;
}
// what leg i is routed for: { activity, grade }
export const legProfile = (plan, i) => (walkedLegs(plan)[i] ? WALK : { activity: plan.activity, grade: plan.grade ?? GRADES[plan.activity].def });
const pt = (p) => `${p[0]},${p[1]}`;
export const routeKeyOf = ({ activity, grade }, a, b) => `${activity}:${grade}:${pt(a)}:${pt(b)}`;
export const routeKey = (plan, i) => routeKeyOf(legProfile(plan, i), plan.points[i], plan.points[i + 1]);
export const needsRoute = (plan, i) => plan.legs[i].mode === 'path' && plan.legs[i].key !== routeKey(plan, i);
// leg i as routed: r = { via, marks } or { error }
export function setRoute(plan, i, r) {
  const legs = plan.legs.slice();
  legs[i] = { mode: 'path', via: r.via || [], marks: r.marks || [], key: routeKey(plan, i), ...(r.error && { failed: r.error }) };
  return { ...plan, legs };
}
// the bike left at waypoint i (null: ridden all the way)
export const parkAt = (plan, i) => ({ ...plan, park: i });

// the marked stretches of the whole route: [first, last, why] as indexes into planLine, neighbours of one kind joined
export function planMarks(plan) {
  const out = [];
  let at = 0;
  plan.legs.forEach((l) => {
    for (const [a, b, w] of l.marks || []) {
      const m = out[out.length - 1];
      if (m && m[2] === w && m[1] >= at + a) m[1] = Math.max(m[1], at + b); else out.push([at + a, at + b, w]);
    }
    at += l.via.length + 1;
  });
  return out;
}

// ---------------------------------------------------------------- geometry
export const legLine = (plan, i) => [plan.points[i], ...plan.legs[i].via, plan.points[i + 1]];

// the whole route as one line of [lon, lat]
export function planLine(plan) {
  const out = plan.points.slice(0, 1);
  plan.legs.forEach((l, i) => out.push(...l.via, plan.points[i + 1]));
  return out;
}

// metres from p to the segment a-b, in a plane around p, and where along it (0..1)
function segDist(p, a, b) {
  const k = Math.cos(p[1] * Math.PI / 180) * 111320, m = 111320;
  const ax = (a[0] - p[0]) * k, ay = (a[1] - p[1]) * m, bx = (b[0] - p[0]) * k, by = (b[1] - p[1]) * m;
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L)) : 0;
  return { d: Math.hypot(ax + t * dx, ay + t * dy), t };
}
function nearestSegment(line, p) {
  let best = { seg: 0, d: Infinity };
  for (let s = 0; s < line.length - 1; s++) {
    const { d } = segDist(p, line[s], line[s + 1]);
    if (d < best.d) best = { seg: s, d };
  }
  return best;
}

// the leg passing closest to p, and how far it is (metres)
export function nearestLeg(plan, p) {
  let best = { leg: -1, d: Infinity };
  plan.legs.forEach((_, i) => {
    const { d } = nearestSegment(legLine(plan, i), p);
    if (d < best.d) best = { leg: i, d };
  });
  return best;
}

// a line (a GPX track, a route of the atlas) as a plan: a waypoint every `every` metres to move it by, the
// line's own shape in between
export function planFromLine(line, { activity = 'hike', name = '', every = 1500 } = {}) {
  const pts = simplify(line.filter((p) => p && Number.isFinite(p[0]) && Number.isFinite(p[1])), 3);
  let plan = emptyPlan(activity, name);
  if (!pts.length) return plan;
  plan = addPoint(plan, pts[0]);
  let via = [], run = 0;
  for (let i = 1; i < pts.length; i++) {
    run += haversine(pts[i - 1], pts[i]);
    if (run >= every || i === pts.length - 1) { plan = addPoint(plan, pts[i], via); via = []; run = 0; }
    else via.push(pts[i]);
  }
  return plan;
}

// ---------------------------------------------------------------- in the address bar
// "2.<activity>.<points>.<waypoints>.<options>.<marks>": the points of the whole line as steps of 1e-5° (about a metre), and which of
// them are waypoints as gaps between their positions, all as variable-length numbers in base64url
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
function putInt(out, v) {
  let u = v < 0 ? -2 * v - 1 : 2 * v;                  // zigzag: small steps either way stay short
  do { const c = u % 32; u = Math.floor(u / 32); out.push(B64[c | (u ? 32 : 0)]); } while (u);
}
function readInts(s) {
  const out = [];
  let u = 0, k = 1;
  for (const ch of s) {
    const c = B64.indexOf(ch);
    if (c < 0) throw new Error('not a plan');
    u += (c & 31) * k;
    if (c & 32) k *= 32; else { out.push(u % 2 ? -(u + 1) / 2 : u / 2); u = 0; k = 1; }
  }
  return out;
}

// version 2 adds ".<grade><f or p per leg>[b<waypoint the bike is left at>].<marks>", the marks as leg (gap from the
// last), first point, length and kind (MARK_CODES) of each
const MARK_CODES = ['push', 'carry', 'hard', 'closed', 'steep', 'against'];
export function encodePlan(plan) {
  const coords = [], gaps = [], marks = [];
  let lx = 0, ly = 0, at = 0, last = 0, lastLeg = 0;
  const put = ([lon, lat]) => {
    const x = Math.round(lon * 1e5), y = Math.round(lat * 1e5);
    putInt(coords, x - lx); putInt(coords, y - ly); lx = x; ly = y;
  };
  plan.points.forEach((p, i) => {
    if (i) for (const v of plan.legs[i - 1].via) { put(v); at++; }
    put(p); putInt(gaps, at - last); last = at; at++;
  });
  plan.legs.forEach((l, i) => {
    for (const [a, b, w] of l.marks || []) { putInt(marks, i - lastLeg); putInt(marks, a); putInt(marks, b - a); putInt(marks, MARK_CODES.indexOf(w)); lastLeg = i; }
  });
  const opts = `${plan.grade ?? GRADES[plan.activity].def}${plan.legs.map((l) => (l.mode === 'path' ? 'p' : 'f')).join('')}${plan.park != null ? `b${plan.park}` : ''}`;
  return `2.${Math.max(0, ACTIVITIES.indexOf(plan.activity))}.${coords.join('')}.${gaps.join('')}.${opts}.${marks.join('')}`;
}

export function decodePlan(code, name = '') {
  const [v, act, c, g, opts = '', mk = ''] = String(code).split('.');
  if ((v !== '1' && v !== '2') || c == null || g == null) throw new Error('not a plan');
  const n = readInts(c), line = [];
  let x = 0, y = 0;
  for (let i = 0; i + 1 < n.length; i += 2) { x += n[i]; y += n[i + 1]; line.push([x / 1e5, y / 1e5]); }
  const idx = [];
  readInts(g).reduce((a, d) => { idx.push(a + d); return a + d; }, 0);
  if (!idx.length || idx[0] !== 0 || idx.at(-1) >= line.length || idx.some((v2, i) => i && v2 <= idx[i - 1])) throw new Error('not a plan');
  const activity = ACTIVITIES[Number(act)] || 'hike', o = v === '2' ? /^(\d)([fp]*)(?:b(\d+))?$/.exec(opts) : null;
  if (v === '2' && !o) throw new Error('not a plan');
  let plan = emptyPlan(activity, name);
  if (o) plan = { ...plan, grade: Math.min(GRADES[activity].max, Math.max(GRADES[activity].min, Number(o[1]))), park: o[3] != null && Number(o[3]) < idx.length ? Number(o[3]) : null };
  idx.forEach((k, i) => { plan = addPoint(plan, line[k], i ? line.slice(idx[i - 1] + 1, k) : [], o?.[2][i - 1] === 'p' ? 'path' : 'free'); });
  const m = readInts(mk);
  for (let i = 0, leg = 0; i + 3 < m.length; i += 4) {
    leg += m[i];
    const l = plan.legs[leg], w = MARK_CODES[m[i + 3]];
    if (l && w && m[i + 2] > 0 && m[i + 1] + m[i + 2] <= l.via.length + 1) (l.marks ||= []).push([m[i + 1], m[i + 1] + m[i + 2], w]);
  }
  // the routed legs count as routed; one without a line (not found, or not yet routed when kept) is tried again
  plan.legs = plan.legs.map((l, i) => (l.mode === 'path' && l.via.length ? { ...l, key: routeKey(plan, i) } : l));
  return plan;
}

// ---------------------------------------------------------------- time and steepness
// elevations averaged over `win` metres, so the noise of the ground does not count as climbing
function smooth(d, e, win = 100) {
  const out = new Array(e.length).fill(null);
  for (let i = 0, a = 0, b = 0, sum = 0, n = 0; i < e.length; i++) {
    while (b < e.length && d[b] - d[i] <= win / 2) { if (e[b] != null) { sum += e[b]; n++; } b++; }
    while (d[i] - d[a] > win / 2) { if (e[a] != null) { sum -= e[a]; n--; } a++; }
    out[i] = n ? sum / n : null;
  }
  return out;
}

// the profile in stretches of about 100 m: [metres along, metres up (or down when negative)]
function stretches(p, len = 100) {
  const es = smooth(p.d, p.e), out = [];
  let from = 0;
  for (let i = 1; i < p.d.length; i++) {
    if (p.d[i] - p.d[from] < len && i < p.d.length - 1) continue;
    if (es[i] != null && es[from] != null) out.push([p.d[i] - p.d[from], es[i] - es[from]]);
    from = i;
  }
  return out;
}

// hours on the way, from the elevation profile ({ d, e, length, ascent, descent }):
//   hiking: DIN 33466 (4 km/h, 300 m/h up, 500 m/h down; the longer of distance and climbing plus half the other)
//   ski touring: Munter (up: km + 100 m climbed count 1 unit, 4 units/h; down: km + 200 m count 1, 10 units/h)
//   mountain bike and eMTB: per 100 m the slower of riding on the flat and climbing, downhill at a steady pace
export function estimateTime(activity, p) {
  if (!p || !p.length) return null;
  if (activity !== 'skitour' && !RIDE[activity]) {
    const h = p.length / 4000, v = p.ascent / 300 + p.descent / 500;
    return Math.max(h, v) + Math.min(h, v) / 2;
  }
  let t = 0;
  for (const [len, dh] of stretches(p)) {
    if (activity === 'skitour') t += dh > 0 ? (len / 1000 + dh / 100) / 4 : (len / 1000 - dh / 200) / 10;
    else {
      const [flat, climb, down] = RIDE[activity];
      t += dh > 0 ? Math.max(len / 1000 / flat, dh / climb) : len / 1000 / (-dh / len > 0.04 ? down : flat);
    }
  }
  return t;
}

// hours for the whole plan, the ridden and walked parts of a Bike & Hike each at their own pace
export function planTime(plan, p) {
  if (!p || !p.length) return null;
  const walked = walkedLegs(plan);
  if (!walked.some(Boolean)) return estimateTime(plan.activity, p);
  const ends = [];                                       // metres along the line where each leg ends
  let d = 0, last = plan.points[0];
  plan.legs.forEach((l, i) => { for (const q of [...l.via, plan.points[i + 1]]) { d += haversine(last, q); last = q; } ends.push(d); });
  let t = 0;
  for (let i = 0; i < plan.legs.length;) {
    let j = i;
    while (j + 1 < plan.legs.length && walked[j + 1] === walked[i]) j++;
    t += estimateTime(walked[i] ? 'hike' : plan.activity, part(p, i ? ends[i - 1] : 0, ends[j])) ?? 0;
    i = j + 1;
  }
  return t;
}
// the profile between d0 and d1 metres, from the sample nearest the one to the sample nearest the other (so the parts
// of a route meet at a sample)
function part(p, d0, d1) {
  const near = (d) => { let i = 0; while (i + 1 < p.d.length && Math.abs(p.d[i + 1] - d) <= Math.abs(p.d[i] - d)) i++; return i; };
  const i0 = near(d0), i1 = near(d1);
  if (i1 <= i0) return null;
  const d = p.d.slice(i0, i1 + 1).map((v) => v - p.d[i0]), e = p.e.slice(i0, i1 + 1), { up, down } = climb(d, e);
  return { d, e, length: d.at(-1), ascent: up, descent: down };
}

// steep stretches, for colouring the line and the profile: in summer by the gradient of the route itself (percent,
// up or down), in winter by the angle of the slope it crosses (degrees, the classes of the slope layer)
export const GRADE_CLASSES = [[10, '#ffdb1a'], [20, '#ff850d'], [30, '#e61f1a']];
export const SLOPE_CLASSES = [[27, '#bfe65a'], [30, '#ffdb1a'], [35, '#ff850d'], [40, '#e61f1a'], [45, '#8c33bf']];
const classOf = (v, classes) => { let c = null; for (const [min, col] of classes) if (v >= min) c = col; return c; };

// one colour (or null where it is not steep) per profile point, for the stretch that ends there
export function steepColors(p, winter) {
  if (winter) return p.slope ? p.slope.map((s) => (s == null ? null : classOf(s, SLOPE_CLASSES))) : p.d.map(() => null);
  const es = smooth(p.d, p.e, 50), out = [];
  for (let i = 0, a = 0, b = 0; i < p.d.length; i++) {
    while (p.d[i] - p.d[a] > 25) a++;
    while (b < p.d.length - 1 && p.d[b] - p.d[i] < 25) b++;
    const run = p.d[b] - p.d[a];
    out.push(run > 0 && es[a] != null && es[b] != null ? classOf((Math.abs(es[b] - es[a]) / run) * 100, GRADE_CLASSES) : null);
  }
  return out;
}

export const planLength = (plan) => lineLength(planLine(plan));
