// Current Sentinel-2 imagery for a region, one scene date per season, rendered by the Microsoft Planetary Computer
// tiler. Each tile is RGBA: true colour in RGB, and in alpha 0 for no data or 1..255 for the snow fraction from the
// normalised difference snow index (green vs. short-wave infrared), which also finds snow in shadow.
import { PNG } from 'pngjs';
import { cached, fetchBuf, fetchJSON, readJSON, writeJSON, limiter, once } from './util.js';

const PC = 'https://planetarycomputer.microsoft.com/api';
const pcLimit = limiter(6);
const dedupe = once();
export const S2_MAX_Z = 14;

// the most recent finished (or running) window for each season
export function seasonWindow(season, now = new Date()) {
  const y = now.getUTCFullYear(), m = now.getUTCMonth() + 1;
  if (season === 'winter') {
    const startYear = m >= 12 ? y : y - 1;
    const end = new Date(Math.min(Date.UTC(startYear + 1, 3, 10), now.getTime()));
    return [new Date(Date.UTC(startYear, 11, 1)), end];
  }
  const year = m >= 7 ? y : y - 1;
  return [new Date(Date.UTC(year, 5, 20)), new Date(Math.min(Date.UTC(year, 8, 30), now.getTime()))];
}

// preferred months: March for winter (snow everywhere above the valleys, higher sun), August for summer
const MONTH_PENALTY = {
  winter: { 12: 18, 1: 12, 2: 5, 3: 0, 4: 10 },
  summer: { 6: 10, 7: 3, 8: 0, 9: 2 },
};

function inPolygon(pt, rings) {
  let inside = false;
  for (const ring of rings)
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
    }
  return inside;
}
const polys = (g) => (g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []);

async function searchItems(bbox, [t0, t1]) {
  const items = [];
  let body = {
    collections: ['sentinel-2-l2a'], bbox, limit: 250,
    datetime: `${t0.toISOString()}/${t1.toISOString()}`,
    query: { 'eo:cloud_cover': { lt: 25 } },
  };
  for (let page = 0; page < 6 && body; page++) {
    const r = await fetchJSON(`${PC}/stac/v1/search`, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
    items.push(...r.features);
    const next = (r.links || []).find((l) => l.rel === 'next');
    body = next?.body ? next.body : null;
  }
  return items;
}

// choose the best date: whole region covered, few clouds, preferred month
async function chooseScene(season, bbox) {
  const win = seasonWindow(season);
  const items = await searchItems(bbox, win);
  const byDate = new Map();
  for (const f of items) {
    const d = f.properties.datetime.slice(0, 10);
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d).push(f);
  }
  const grid = [];
  for (let i = 0; i <= 8; i++) for (let j = 0; j <= 8; j++) grid.push([bbox[0] + (bbox[2] - bbox[0]) * i / 8, bbox[1] + (bbox[3] - bbox[1]) * j / 8]);
  const scored = [];
  for (const [date, fs] of byDate) {
    const cover = grid.filter((p) => fs.some((f) => inPolygon(p, polys(f.geometry).flat()))).length / grid.length;
    const cloud = fs.reduce((a, f) => a + f.properties['eo:cloud_cover'], 0) / fs.length;
    const snow = fs.reduce((a, f) => a + (f.properties['s2:snow_ice_percentage'] || 0), 0) / fs.length;
    const month = Number(date.slice(5, 7));
    const score = cloud * 2 + (1 - cover) * 400 + (MONTH_PENALTY[season][month] ?? 20) + (season === 'summer' ? snow * 0.6 : 0);
    scored.push({ date, cover, cloud, snow, score, granules: fs.map((f) => f.id) });
  }
  scored.sort((a, b) => a.score - b.score);
  return { window: win.map((d) => d.toISOString().slice(0, 10)), candidates: scored.slice(0, 6) };
}

async function registerMosaic(bbox, date) {
  const poly = { type: 'Polygon', coordinates: [[[bbox[0], bbox[1]], [bbox[2], bbox[1]], [bbox[2], bbox[3]], [bbox[0], bbox[3]], [bbox[0], bbox[1]]]] };
  const body = {
    collections: ['sentinel-2-l2a'], 'filter-lang': 'cql2-json',
    filter: { op: 'and', args: [
      { op: 's_intersects', args: [{ property: 'geometry' }, poly] },
      { op: 'anyinteracts', args: [{ property: 'datetime' }, { interval: [`${date}T00:00:00Z`, `${date}T23:59:59Z`] }] },
    ] },
    sortby: [{ field: 'eo:cloud_cover', direction: 'asc' }],
  };
  const r = await fetchJSON(`${PC}/data/v1/mosaic/register`, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
  return r.searchid;
}

// scene per season and region, refreshed daily
export async function scene(season, bbox) {
  const key = `s2/scene-${season}-${bbox.map((v) => v.toFixed(2)).join('_')}.json`;
  return dedupe(key, async () => {
    const old = await readJSON(key);
    if (old && Date.now() - old.checked < 86400e3) return old;
    try {
      const pick = await chooseScene(season, bbox);
      const best = pick.candidates[0];
      if (!best) return old || { season, none: true, window: pick.window };
      const searchid = await registerMosaic(bbox, best.date);   // the same query always gets the same id
      const s = { season, bbox, window: pick.window, date: best.date, cloud: best.cloud, cover: best.cover, searchid, candidates: pick.candidates, checked: Date.now() };
      await writeJSON(key, s);
      return s;
    } catch (e) {
      if (old) return old;
      throw e;
    }
  });
}

// bilinear, so the 20 m short-wave band does not show as blocks in the snow edge
const tileUrl = (sid, z, x, y, q) => `${PC}/data/v1/mosaic/${sid}/tiles/WebMercatorQuad/${z}/${x}/${y}@1x.png?collection=sentinel-2-l2a&nodata=0&resampling=bilinear&${q}`;
const VISUAL = 'assets=visual&asset_bidx=visual%7C1%2C2%2C3';
const NDSI = 'assets=B03&assets=B11&asset_as_band=true&expression=(B03-B11)/(B03%2BB11)&rescale=-1,1';

async function renderTile(sid, z, x, y) {
  const [v, n] = await Promise.all([VISUAL, NDSI].map((q) => pcLimit(() => fetchBuf(tileUrl(sid, z, x, y, q), { timeout: 60000 }))));
  if (!v.buf?.length) return emptyPng();                      // 204: no scene covers this tile
  const vis = PNG.sync.read(v.buf);
  const nd = n.buf?.length ? PNG.sync.read(n.buf) : null;
  const out = new PNG({ width: 256, height: 256 });
  for (let p = 0; p < 256 * 256; p++) {
    const o = p * 4, r = vis.data[o], g = vis.data[o + 1], b = vis.data[o + 2];
    out.data[o] = r; out.data[o + 1] = g; out.data[o + 2] = b;
    if (!vis.data[o + 3] || (r | g | b) === 0) { out.data[o + 3] = 0; continue; }
    let snow = 0;
    if (nd && nd.data[o + 3]) {
      const ndsi = nd.data[o] / 127.5 - 1;
      const lum = (0.3 * r + 0.59 * g + 0.11 * b) / 255;          // open water also has a high NDSI but is dark
      snow = Math.min(Math.max((ndsi - 0.2) / 0.25, 0), 1) * Math.min(Math.max((lum - 0.07) / 0.08, 0), 1);
    }
    out.data[o + 3] = 1 + Math.round(snow * 254);
  }
  return PNG.sync.write(out, { colorType: 6 });
}

let EMPTY;
function emptyPng() {
  if (!EMPTY) EMPTY = PNG.sync.write(new PNG({ width: 1, height: 1 }));
  return EMPTY;
}

export function s2Tile(sid, z, x, y) {
  if (!/^[0-9a-f]{16,64}$/.test(sid)) throw new Error('bad scene id');
  return cached(`s2/tiles/v2/${sid}/${z}/${x}/${y}.png`, 0, () => renderTile(sid, z, x, y));
}
