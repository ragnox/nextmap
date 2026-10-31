// Current Sentinel-2 imagery for a region, one scene date per season, rendered by the Microsoft Planetary Computer
// tiler; the same on the server and in the browser. A finished tile is RGBA: true colour in RGB, and in alpha 0 for
// no data or 1..255 for the snow fraction from the normalised difference snow index (green vs. short-wave infrared),
// which also finds snow in shadow.
export const PC = 'https://planetarycomputer.microsoft.com/api';
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

// postJSON(url, body) -> parsed JSON
async function searchItems(postJSON, bbox, [t0, t1]) {
  const items = [];
  let body = {
    collections: ['sentinel-2-l2a'], bbox, limit: 250,
    datetime: `${t0.toISOString()}/${t1.toISOString()}`,
    query: { 'eo:cloud_cover': { lt: 25 } },
  };
  for (let page = 0; page < 6 && body; page++) {
    const r = await postJSON(`${PC}/stac/v1/search`, body);
    items.push(...r.features);
    const next = (r.links || []).find((l) => l.rel === 'next');
    body = next?.body ? next.body : null;
  }
  return items;
}

// the best date for a season: whole region covered, few clouds, preferred month; then a mosaic of that day.
// Returns { season, bbox, window, date, cloud, cover, searchid, candidates } or { none: true }.
export async function findScene(postJSON, season, bbox) {
  const win = seasonWindow(season);
  const items = await searchItems(postJSON, bbox, win);
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
  const window = win.map((d) => d.toISOString().slice(0, 10)), best = scored[0];
  if (!best) return { season, none: true, window };
  const poly = { type: 'Polygon', coordinates: [[[bbox[0], bbox[1]], [bbox[2], bbox[1]], [bbox[2], bbox[3]], [bbox[0], bbox[3]], [bbox[0], bbox[1]]]] };
  const reg = await postJSON(`${PC}/data/v1/mosaic/register`, {
    collections: ['sentinel-2-l2a'], 'filter-lang': 'cql2-json',
    filter: { op: 'and', args: [
      { op: 's_intersects', args: [{ property: 'geometry' }, poly] },
      { op: 'anyinteracts', args: [{ property: 'datetime' }, { interval: [`${best.date}T00:00:00Z`, `${best.date}T23:59:59Z`] }] },
    ] },
    sortby: [{ field: 'eo:cloud_cover', direction: 'asc' }],
  });
  // the tiler now answers with an id that expires after a day (it used to be a lasting `searchid`)
  return { season, bbox, window, date: best.date, cloud: best.cloud, cover: best.cover, searchid: reg.searchid || reg.id, candidates: scored.slice(0, 6) };
}

// true colour by nearest neighbour (bilinear blends the black no-data border of a granule into a dark seam), the snow
// index bilinear, so the 20 m short-wave band does not show as blocks in the snow edge
const tileUrl = (sid, z, x, y, q) => `${PC}/data/v1/mosaic/${sid}/tiles/WebMercatorQuad/${z}/${x}/${y}@1x.png?collection=sentinel-2-l2a&nodata=0&${q}`;
export const visualUrl = (sid, z, x, y) => tileUrl(sid, z, x, y, 'resampling=nearest&assets=visual&asset_bidx=visual%7C1%2C2%2C3');
export const ndsiUrl = (sid, z, x, y) => tileUrl(sid, z, x, y, 'resampling=bilinear&assets=B03&assets=B11&asset_as_band=true&expression=(B03-B11)/(B03%2BB11)&rescale=-1,1');

// true colour (RGBA) + NDSI (grey in red, RGBA) -> RGB with the snow fraction in alpha
export function composeSnow(vis, nd) {
  const out = new Uint8Array(256 * 256 * 4);
  for (let p = 0; p < 256 * 256; p++) {
    const o = p * 4, r = vis[o], g = vis[o + 1], b = vis[o + 2];
    out[o] = r; out[o + 1] = g; out[o + 2] = b;
    if (!vis[o + 3] || (r | g | b) === 0) { out[o + 3] = 0; continue; }
    let snow = 0;
    if (nd && nd[o + 3]) {
      const ndsi = nd[o] / 127.5 - 1;
      const lum = (0.3 * r + 0.59 * g + 0.11 * b) / 255;          // open water also has a high NDSI but is dark
      snow = Math.min(Math.max((ndsi - 0.2) / 0.25, 0), 1) * Math.min(Math.max((lum - 0.07) / 0.08, 0), 1);
    }
    out[o + 3] = 1 + Math.round(snow * 254);
  }
  return out;
}
