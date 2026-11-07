// A route planned on the map: waypoints joined by legs. A leg is freehand for now: the straight line between its two
// waypoints, or the line sketched by hand in between (`via`). Legs that follow the path network will have the same
// shape, with the routed line as `via`.
// Plans are values: every edit returns a new plan, so undo is a list of the earlier ones.
import { haversine, lineLength, simplify } from './geo.js';

export const ACTIVITIES = ['hike', 'mtb', 'emtb', 'skitour'];

export const emptyPlan = (activity = 'hike', name = '') => ({ name, activity, points: [], legs: [] });
const leg = (via = []) => ({ mode: 'free', via });

// ---------------------------------------------------------------- editing
export function addPoint(plan, p, via = []) {
  if (!plan.points.length) return { ...plan, points: [p], legs: [] };
  return { ...plan, points: [...plan.points, p], legs: [...plan.legs, leg(via)] };
}

export function movePoint(plan, i, p) {
  const points = plan.points.slice();
  points[i] = p;
  return { ...plan, points };
}

// a new waypoint at p on leg i; a sketched leg is split where p is closest to it
export function insertPoint(plan, i, p) {
  const line = legLine(plan, i), via = plan.legs[i].via;
  const s = nearestSegment(line, p).seg;                // line[s]..line[s + 1], and line[k] is via[k - 1]
  const legs = [...plan.legs.slice(0, i), leg(via.slice(0, s)), leg(via.slice(s)), ...plan.legs.slice(i + 1)];
  return { ...plan, points: [...plan.points.slice(0, i + 1), p, ...plan.points.slice(i + 1)], legs };
}

// without waypoint i; the legs on either side become one
export function removePoint(plan, i) {
  const n = plan.points.length;
  if (n <= 1) return { ...plan, points: [], legs: [] };
  const points = plan.points.filter((_, k) => k !== i);
  const legs = i === 0 ? plan.legs.slice(1) : i === n - 1 ? plan.legs.slice(0, -1)
    : [...plan.legs.slice(0, i - 1), leg([...plan.legs[i - 1].via, ...plan.legs[i].via]), ...plan.legs.slice(i + 1)];
  return { ...plan, points, legs };
}

export const reverse = (plan) => ({
  ...plan, points: plan.points.slice().reverse(), legs: plan.legs.slice().reverse().map((l) => ({ ...l, via: l.via.slice().reverse() })),
});
export const backToStart = (plan) => (plan.points.length > 1 ? addPoint(plan, plan.points[0]) : plan);
export function outAndBack(plan) {
  if (plan.points.length < 2) return plan;
  const back = reverse(plan);
  return { ...plan, points: [...plan.points, ...back.points.slice(1)], legs: [...plan.legs, ...back.legs] };
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
// "1.<activity>.<points>.<waypoints>": the points of the whole line as steps of 1e-5° (about a metre), and which of
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

export function encodePlan(plan) {
  const coords = [], gaps = [];
  let lx = 0, ly = 0, at = 0, last = 0;
  const put = ([lon, lat]) => {
    const x = Math.round(lon * 1e5), y = Math.round(lat * 1e5);
    putInt(coords, x - lx); putInt(coords, y - ly); lx = x; ly = y;
  };
  plan.points.forEach((p, i) => {
    if (i) for (const v of plan.legs[i - 1].via) { put(v); at++; }
    put(p); putInt(gaps, at - last); last = at; at++;
  });
  return `1.${Math.max(0, ACTIVITIES.indexOf(plan.activity))}.${coords.join('')}.${gaps.join('')}`;
}

export function decodePlan(code, name = '') {
  const [v, act, c, g] = String(code).split('.');
  if (v !== '1' || c == null || g == null) throw new Error('not a plan');
  const n = readInts(c), line = [];
  let x = 0, y = 0;
  for (let i = 0; i + 1 < n.length; i += 2) { x += n[i]; y += n[i + 1]; line.push([x / 1e5, y / 1e5]); }
  const idx = [];
  readInts(g).reduce((a, d) => { idx.push(a + d); return a + d; }, 0);
  if (!idx.length || idx[0] !== 0 || idx.at(-1) >= line.length || idx.some((v2, i) => i && v2 <= idx[i - 1])) throw new Error('not a plan');
  let plan = emptyPlan(ACTIVITIES[Number(act)] || 'hike', name);
  idx.forEach((k, i) => { plan = addPoint(plan, line[k], i ? line.slice(idx[i - 1] + 1, k) : []); });
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

// riding: speed on the flat (km/h), climbing (m/h) and downhill (km/h)
const RIDE = { mtb: [15, 550, 18], emtb: [18, 900, 20] };

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
