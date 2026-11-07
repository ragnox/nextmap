// Geometry used by both the server and the browser: Web Mercator tiles, lines on the sphere, climbs and profiles.

// ---------------------------------------------------------------- Web Mercator (EPSG:3857)
const R = 6378137;
export const HALF = Math.PI * R;
export const tileSize = (z) => (2 * HALF) / 2 ** z;
export const lonToX = (lon) => (lon * Math.PI / 180) * R;
export const latToY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI / 180) / 2)) * R;
export const xToLon = (x) => (x / R) * 180 / Math.PI;
export const yToLat = (y) => (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180 / Math.PI;

// tile bounds in mercator metres: [x0, y0 (south), x1, y1 (north)]
export function tileBounds(z, x, y) {
  const s = tileSize(z);
  return [-HALF + x * s, HALF - (y + 1) * s, -HALF + (x + 1) * s, HALF - y * s];
}
export function tileLonLat(z, x, y) {
  const [x0, y0, x1, y1] = tileBounds(z, x, y);
  return [xToLon(x0), yToLat(y0), xToLon(x1), yToLat(y1)];
}
export function tileAt(z, mx, my) {
  const s = tileSize(z);
  return [Math.floor((mx + HALF) / s), Math.floor((HALF - my) / s)];
}

// ---------------------------------------------------------------- lines on the sphere
const RAD = Math.PI / 180;
export function haversine(a, b) {
  const dLat = (b[1] - a[1]) * RAD, dLon = (b[0] - a[0]) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371008 * Math.asin(Math.sqrt(h));
}
export const lineLength = (line) => line.reduce((s, p, i) => (i ? s + haversine(line[i - 1], p) : 0), 0);

// points every `step` metres along a line, keeping the vertices
export function densify(line, step) {
  const out = [line[0]];
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], b = line[i], n = Math.floor(haversine(a, b) / step);
    for (let k = 1; k <= n; k++) out.push([a[0] + (b[0] - a[0]) * k / (n + 1), a[1] + (b[1] - a[1]) * k / (n + 1)]);
    out.push(b);
  }
  return out;
}

// Douglas-Peucker in local metres
export function simplify(line, tol) {
  if (line.length < 3) return line;
  const k = Math.cos(line[0][1] * RAD) * 111320, m = 111320;
  const P = line.map(([x, y]) => [x * k, y * m]);
  const keep = new Uint8Array(line.length); keep[0] = keep[line.length - 1] = 1;
  const stack = [[0, line.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    const [x1, y1] = P[s], [x2, y2] = P[e], dx = x2 - x1, dy = y2 - y1, L = Math.hypot(dx, dy) || 1;
    let best = -1, bd = tol;
    for (let i = s + 1; i < e; i++) {
      const d = Math.abs(dy * P[i][0] - dx * P[i][1] + x2 * y1 - y2 * x1) / L;
      if (d > bd) { bd = d; best = i; }
    }
    if (best > 0) { keep[best] = 1; stack.push([s, best], [best, e]); }
  }
  return line.filter((_, i) => keep[i]).map(([x, y]) => [Math.round(x * 1e6) / 1e6, Math.round(y * 1e6) / 1e6]);
}

// total climb and descent: elevations averaged over 100 m first, then only changes beyond 5 m count, so a track that
// wobbles across a slope does not add up its bumps (matches the climbs bergfex states to within a few percent)
export function climb(d, e, win = 100, thr = 5) {
  let up = 0, down = 0, ref = null;
  for (let i = 0, a = 0, b = 0, sum = 0, n = 0; i < e.length; i++) {
    while (b < e.length && d[b] - d[i] <= win / 2) { if (e[b] != null) { sum += e[b]; n++; } b++; }
    while (d[i] - d[a] > win / 2) { if (e[a] != null) { sum -= e[a]; n--; } a++; }
    if (!n) continue;
    const v = sum / n;
    if (ref === null) ref = v;
    else if (v - ref > thr) { up += v - ref; ref = v; }
    else if (ref - v > thr) { down += ref - v; ref = v; }
  }
  return { up, down };
}

// elevation profile of a multi-line: distance (m) and elevation (m) per sample, plus totals.
// `sample(points)` returns the elevations of Mercator points (null where unknown).
// With `slope`, also the angle of the ground at each sample (degrees), from the elevations 10 m east and north of it.
export async function buildProfile(lines, sample, { step = 15, maxPts = 4000, slope = false } = {}) {
  const total = lines.reduce((s, l) => s + lineLength(l), 0);
  step = Math.max(step, total / maxPts);
  const parts = lines.map((l) => densify(l, step));
  const flat = parts.flat(), pts = flat.map(([lon, lat]) => [lonToX(lon), latToY(lat)]);
  const k = flat.map(([, lat]) => 10 / Math.cos(lat * RAD));            // 10 m on the ground in Mercator metres
  const all = await sample(slope ? [...pts, ...pts.map(([x, y], i) => [x + k[i], y]), ...pts.map(([x, y], i) => [x, y + k[i]])] : pts);
  const h = all.slice(0, pts.length), n = pts.length;
  const slopes = slope ? h.map((v, i) => {
    const ex = all[n + i], ny = all[2 * n + i];
    return v == null || ex == null || ny == null ? null : Math.round(Math.atan(Math.hypot(ex - v, ny - v) / 10) * 1800 / Math.PI) / 10;
  }) : null;
  const d = [], e = [], coords = [];
  let dist = 0, i = 0, up = 0, down = 0;
  for (const part of parts) {
    const from = d.length;
    part.forEach((p, k) => {
      if (k) dist += haversine(part[k - 1], p);
      const v = h[i++];
      d.push(Math.round(dist)); e.push(v == null ? null : Math.round(v * 10) / 10); coords.push(p);
    });
    const c = climb(d.slice(from), e.slice(from));             // the step between separate pieces is no climb
    up += c.up; down += c.down;
  }
  const valid = e.filter((v) => v != null);
  return {
    length: Math.round(total), ascent: Math.round(up), descent: Math.round(down),
    min: Math.round(Math.min(...valid)), max: Math.round(Math.max(...valid)), d, e, coords, ...(slopes && { slope: slopes }),
  };
}

// ---------------------------------------------------------------- small async helpers
// run async jobs with a concurrency limit
export function limiter(n) {
  let active = 0; const queue = [];
  const next = () => {
    if (active >= n || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => { active--; next(); });
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}

// de-duplicate concurrent requests for the same key
export function once() {
  const pending = new Map();
  return (key, fn) => {
    if (pending.has(key)) return pending.get(key);
    const p = fn().finally(() => pending.delete(key));
    pending.set(key, p);
    return p;
  };
}

export const slug = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
