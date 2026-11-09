// The route being planned, drawn into its own overlay canvas per terrain tile, so it lies on the ground like the
// routes but is redrawn on its own while it is edited (and only in the tiles it crosses). A dark edge, the
// activity's colour, the steep stretches in the colours of their class, and dashed on top the marked stretches (the
// bike pushed or carried, harder than the grade).
import { HALF, tileSize, lonToX, latToY } from './geo.js';

export class PlanLayer {
  constructor() { this.lines = []; this.marks = []; this.colors = null; this.color = '#ff5a2e'; this.box = null; this.version = 0; }

  // lines of [lon, lat]; colors: for a single line, one colour (or null) per point for the stretch ending there;
  // marks: the marked stretches, lines of [lon, lat] along the others
  set(lines, color, colors = null, marks = []) {
    const merc = (l) => l.map(([lon, lat]) => [lonToX(lon), latToY(lat)]);
    this.lines = (lines || []).filter((l) => l.length > 1).map(merc);
    this.marks = marks.filter((l) => l.length > 1).map(merc);
    this.colors = colors && this.lines.length === 1 && colors.length === this.lines[0].length ? colors : null;
    this.color = color;
    const pts = this.lines.flat();
    this.box = pts.length ? pts.reduce((b, [x, y]) => [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)], [Infinity, Infinity, -Infinity, -Infinity]) : null;
    this.version++;
  }
  get empty() { return !this.box; }

  touches(z, x, y) {
    if (!this.box) return false;
    const size = tileSize(z), x0 = -HALF + x * size, y1 = HALF - y * size, m = size * 0.06, b = this.box;
    return b[2] > x0 - m && b[0] < x0 + size + m && b[3] > y1 - size - m && b[1] < y1 + m;
  }

  draw(ctx, z, x, y, px) {
    if (!this.touches(z, x, y)) return false;
    const size = tileSize(z), x0 = -HALF + x * size, y1 = HALF - y * size, k = px / size;
    const P = ([mx, my]) => [(mx - x0) * k, (y1 - my) * k];
    const w = z < 11 ? 2.4 : z < 13 ? 3.4 : z < 15 ? 4.6 : 6;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    const path = (l, from = 0, to = l.length - 1) => {
      ctx.beginPath();
      for (let i = from; i <= to; i++) { const [a, b] = P(l[i]); i > from ? ctx.lineTo(a, b) : ctx.moveTo(a, b); }
    };
    for (const l of this.lines) { path(l); ctx.strokeStyle = 'rgba(14,14,14,0.9)'; ctx.lineWidth = w + 3.5; ctx.stroke(); }
    for (const l of this.lines) { path(l); ctx.strokeStyle = this.color; ctx.lineWidth = w; ctx.stroke(); }
    // steep stretches: runs of points with the same colour drawn as one path
    const c = this.colors, l = this.lines[0];
    if (c) for (let i = 1; i < l.length;) {
      if (!c[i]) { i++; continue; }
      let j = i;
      while (j + 1 < l.length && c[j + 1] === c[i]) j++;
      path(l, i - 1, j); ctx.strokeStyle = c[i]; ctx.lineWidth = w; ctx.stroke();
      i = j + 1;
    }
    ctx.setLineDash([w * 0.9, w * 1.3]); ctx.lineCap = 'butt';
    for (const m of this.marks) { path(m); ctx.strokeStyle = 'rgba(14,14,14,0.92)'; ctx.lineWidth = w * 0.8; ctx.stroke(); }
    ctx.setLineDash([]);
    return true;
  }
}
