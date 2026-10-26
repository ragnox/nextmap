// Hybrid map layer from OpenStreetMap vector tiles (OpenFreeMap, OpenMapTiles schema): roads, forest and farm
// tracks, trails and lifts drawn into a transparent 512 px image per terrain tile (draped like the routes), and
// place and peak names for the screen labels. Runs in the data worker.
import { VectorTile } from '@mapbox/vector-tile';
import Pbf from 'pbf';

const TILEJSON = 'https://tiles.openfreemap.org/planet';
const MAX_VZ = 14;

let template = null;
const tileUrl = async (z, x, y) => {
  template ||= fetch(TILEJSON).then((r) => r.json()).then((j) => j.tiles[0]);
  return (await template).replace('{z}', z).replace('{x}', x).replace('{y}', y);
};

const tiles = new Map();
function vectorTile(z, x, y) {
  const k = `${z}/${x}/${y}`;
  if (!tiles.has(k)) {
    tiles.set(k, tileUrl(z, x, y).then((u) => fetch(u)).then(async (r) => (r.ok ? new VectorTile(new Pbf(new Uint8Array(await r.arrayBuffer()))) : null)).catch(() => null));
    if (tiles.size > 64) tiles.delete(tiles.keys().next().value);
  }
  return tiles.get(k);
}

// line styles: [width (px at 512 for zoom 14), colour, dash, casing colour]; drawn in this order, casings first
const STYLE = [
  ['path', 1.3, '#ff4b3e', [4, 3], 'rgba(255,255,255,0.55)'],
  ['track', 1.8, '#f6c98c', [7, 4], 'rgba(60,40,20,0.55)'],
  ['service', 1.6, 'rgba(255,255,255,0.85)', null, 'rgba(40,40,40,0.5)'],
  ['minor', 2.2, '#ffffff', null, 'rgba(40,40,40,0.55)'],
  ['tertiary', 2.6, '#fff4c2', null, 'rgba(60,50,20,0.6)'],
  ['secondary', 3.2, '#ffe28a', null, 'rgba(70,55,10,0.65)'],
  ['primary', 3.6, '#ffd25a', null, 'rgba(80,60,10,0.7)'],
  ['trunk', 4.2, '#ffb84d', null, 'rgba(80,50,10,0.7)'],
  ['motorway', 4.6, '#ff9d3c', null, 'rgba(80,40,10,0.75)'],
  ['rail', 1.8, '#3a3a3a', null, 'rgba(255,255,255,0.6)'],
  ['aerialway', 1.4, '#1d1d1d', [1, 0], 'rgba(255,255,255,0.75)'],
];
const ORDER = Object.fromEntries(STYLE.map((s, i) => [s[0], i]));
const style = (cls) => STYLE[ORDER[cls === 'transit' ? 'rail' : cls === 'cable_car' ? 'aerialway' : cls] ?? -1];

const canvas = new OffscreenCanvas(512, 512), ctx = canvas.getContext('2d');

// the hybrid image for terrain tile z/x/y, or null where there is nothing to draw
export async function hybridTile(z, x, y) {
  if (z < 9) return null;
  const vz = Math.min(z, MAX_VZ), s = 2 ** (z - vz), vx = Math.floor(x / s), vy = Math.floor(y / s);
  const vt = await vectorTile(vz, vx, vy);
  const layer = vt?.layers.transportation;
  if (!layer) return null;
  const k = (512 * s) / layer.extent, ox = (x - vx * s) * 512, oy = (y - vy * s) * 512;
  const widthScale = Math.max(0.55, Math.min(1.6, 2 ** ((z - 14) * 0.5)));
  const feats = [];
  for (let i = 0; i < layer.length; i++) {
    const f = layer.feature(i), p = f.properties;
    if (f.type !== 2 || p.brunnel === 'tunnel') continue;
    const st = style(p.class);
    if (!st || (z < 12 && ORDER[p.class] < ORDER.tertiary) || (z < 11 && ORDER[p.class] < ORDER.secondary)) continue;
    feats.push({ st, geom: f.loadGeometry() });
  }
  if (!feats.length) return null;
  feats.sort((a, b) => ORDER[a.st[0]] - ORDER[b.st[0]]);
  ctx.clearRect(0, 0, 512, 512);
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  const path = (geom) => {
    ctx.beginPath();
    for (const ring of geom) ring.forEach((pt, j) => { const px = pt.x * k - ox, py = pt.y * k - oy; j ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
  };
  for (const pass of ['casing', 'line']) {
    for (const { st: [cls, w, col, dash, casing], geom } of feats) {
      path(geom);
      const width = w * widthScale;
      if (pass === 'casing') {
        ctx.setLineDash([]); ctx.strokeStyle = casing; ctx.lineWidth = width + (cls === 'path' ? 1.4 : 1.8); ctx.stroke();
      } else {
        ctx.setLineDash(dash ? dash.map((d) => d * widthScale * 1.5) : []); ctx.strokeStyle = col; ctx.lineWidth = width; ctx.stroke();
        if (cls === 'rail') { ctx.setLineDash([5 * widthScale, 5 * widthScale]); ctx.strokeStyle = '#f2f2f2'; ctx.lineWidth = width * 0.5; ctx.stroke(); }
      }
    }
  }
  ctx.setLineDash([]);
  return createImageBitmap(canvas);
}

// names to label: places (with their importance) and peaks (with their height), as lon/lat
export async function labelsTile(z, x, y) {
  const vt = await vectorTile(z, x, y);
  if (!vt) return [];
  const out = [];
  const lonlat = (f, pt) => {
    const e = f.extent, n = Math.PI - (2 * Math.PI * (y + pt.y / e)) / 2 ** z;
    return [((x + pt.x / e) / 2 ** z) * 360 - 180, (180 / Math.PI) * Math.atan(Math.sinh(n))];
  };
  const take = (layer, fn) => { if (!layer) return; for (let i = 0; i < layer.length; i++) { const f = layer.feature(i); if (f.type === 1) fn(f, f.properties); } };
  take(vt.layers.place, (f, p) => {
    if (!p.name || !['city', 'town', 'village', 'hamlet', 'suburb'].includes(p.class)) return;
    out.push({ kind: 'place', cls: p.class, name: p['name:de'] || p.name, rank: p.rank ?? 20, at: lonlat(f, f.loadGeometry()[0][0]) });
  });
  take(vt.layers.mountain_peak, (f, p) => {
    if (!p.name || (p.class && !['peak', 'volcano', 'saddle'].includes(p.class))) return;
    out.push({ kind: p.class === 'saddle' ? 'saddle' : 'peak', name: p['name:de'] || p.name, ele: p.ele ?? null, rank: p.rank ?? 10, at: lonlat(f, f.loadGeometry()[0][0]) });
  });
  return out;
}
