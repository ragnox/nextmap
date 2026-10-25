// Routes drawn into each terrain tile's overlay canvas, so they lie exactly on the ground at every level of detail.
// Routes with a track draw as lines; routes known only by their start (crawled web pages) draw as dots.
import { HALF, tileSize, lonToX, latToY, xToLon, yToLat } from './geo.js';

export const KIND_COLORS = {
  hike: '#ff5a2e', bikehike: '#19d66b', mtb: '#ff2bd6', emtb: '#00e0ff',
  skitour: '#2a7bff', freeride: '#b04dff', snowshoe: '#8fa8ff',
};

export class RouteLayer {
  constructor() {
    this.routes = []; this.shown = []; this.version = 0; this.visible = true;
    this.selected = null; this.hovered = null;
  }
  setRoutes(routes) {
    this.prepare(routes);
    this.routes = routes;
    this.setShown(routes);
  }
  // a route whose geometry changed (its track arrived)
  refresh(r) { delete r._m; this.prepare([r]); this.bump(); }
  prepare(routes) {
    for (const r of routes) {
      if (r._m) continue;
      r._m = (r.lines || []).map((l) => l.map(([lon, lat]) => [lonToX(lon), latToY(lat)]));
      r._s = r.start ? [lonToX(r.start[0]), latToY(r.start[1])] : null;
      const pts = r._m.flat().concat(r._s ? [r._s] : []);
      r._b = pts.reduce((b, [x, y]) => [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)], [Infinity, Infinity, -Infinity, -Infinity]);
    }
  }
  setShown(list) { this.shown = list; this.bump(); }
  select(r) { if (this.selected !== r) { this.selected = r; this.bump(); } }
  hover(r) { if (this.hovered !== r) { this.hovered = r; this.bump(); } }
  bump() { this.version++; }

  // draw into a tile canvas of `px` pixels; returns whether anything was drawn
  draw(ctx, z, x, y, px) {
    const size = tileSize(z), x0 = -HALF + x * size, y1 = HALF - y * size, k = px / size;
    const margin = size * 0.06;
    const hit = (b) => b[2] > x0 - margin && b[0] < x0 + size + margin && b[3] > y1 - size - margin && b[1] < y1 + margin;
    const P = ([mx, my]) => [(mx - x0) * k, (y1 - my) * k];
    const w = z < 11 ? 1.6 : z < 13 ? 2.4 : z < 15 ? 3.2 : 4.2;
    let any = false;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    const path = (r, lines = r._m) => {
      ctx.beginPath();
      for (const l of lines) l.forEach((p, i) => { const [a, b] = P(p); i ? ctx.lineTo(a, b) : ctx.moveTo(a, b); });
    };
    // Bike & Hike: the ride solid, the walk on from where the bike stays dashed
    const stroke = (r, width, style, halo) => {
      const split = r.kind === 'bikehike' && r._m.length > 1;
      const parts = split ? [[r._m.slice(0, -1), []], [r._m.slice(-1), [width * 1.6, width * 1.4]]] : [[r._m, []]];
      for (const [lines, dash] of parts) {
        path(r, lines);
        ctx.setLineDash(halo ? [] : dash);
        ctx.strokeStyle = style; ctx.lineWidth = width; ctx.stroke();
      }
      ctx.setLineDash([]);
    };
    const dot = (r, rad) => { const [a, b] = P(r._s); ctx.beginPath(); ctx.arc(a, b, rad, 0, Math.PI * 2); };
    const special = new Set([this.selected, this.hovered]);
    for (const r of this.shown) {
      if (special.has(r) || !hit(r._b)) continue;
      any = true;
      const col = KIND_COLORS[r.kind] || '#ff5a2e';
      if (r._m.length) {
        stroke(r, w + 1.6, 'rgba(255,255,255,0.55)', true);
        stroke(r, w, col);
      } else if (r._s) {
        dot(r, w + 2.5);
        ctx.fillStyle = col; ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = '#fff'; ctx.stroke();
      }
    }
    for (const r of [this.hovered, this.selected]) {
      if (!r || !hit(r._b)) continue;
      any = true;
      const sel = r === this.selected;
      if (r._m.length) {
        stroke(r, w * 2 + 3, 'rgba(20,20,20,0.85)', true);
        stroke(r, w * 2, sel ? '#ffd23f' : '#ffffff');
      }
      if (r._s) {
        dot(r, w * 2 + 4);
        ctx.fillStyle = sel ? '#ffd23f' : '#fff'; ctx.fill(); ctx.lineWidth = 2.5; ctx.strokeStyle = '#141414'; ctx.stroke();
      }
    }
    return any;
  }

  // nearest shown route to a point (Mercator metres) within `tol` metres
  pick(mx, my, tol) {
    let best = null, bd = tol;
    const seg = (p, a, b) => {
      const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
      const t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0;
      return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
    };
    for (const r of this.shown) {
      const b = r._b;
      if (mx < b[0] - bd || mx > b[2] + bd || my < b[1] - bd || my > b[3] + bd) continue;
      let d = Infinity;
      for (const l of r._m) for (let i = 1; i < l.length; i++) d = Math.min(d, seg([mx, my], l[i - 1], l[i]));
      if (r._s && !r._m.length) d = Math.min(d, Math.hypot(mx - r._s[0], my - r._s[1]) * 0.7);
      if (d < bd) { bd = d; best = r; }
    }
    return best;
  }
}

export function routeBounds(r) {
  const b = r._b;
  return [xToLon(b[0]), yToLat(b[1]), xToLon(b[2]), yToLat(b[3])];
}
