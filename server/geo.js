// Line geometry on the sphere: lengths, densifying, simplifying, and elevation profiles from the DEM.
import { lonToX, latToY } from './util.js';
import { sampleElevations } from './dem.js';

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

// elevation profile of a multi-line: distance (m) and elevation (m) per sample, plus totals
export async function profile(lines, { z = 14, step = 15, maxPts = 4000 } = {}) {
  const total = lines.reduce((s, l) => s + lineLength(l), 0);
  step = Math.max(step, total / maxPts);
  const parts = lines.map((l) => densify(l, step));
  const flat = parts.flat();
  const h = await sampleElevations(z, flat.map(([lon, lat]) => [lonToX(lon), latToY(lat)]));
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
    min: Math.round(Math.min(...valid)), max: Math.round(Math.max(...valid)), d, e, coords,
  };
}
