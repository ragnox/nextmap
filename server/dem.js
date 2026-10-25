// Elevation tiles in Web Mercator: Land Tirol laser-scan DGM (tiris WCS, 5 m and 0.5 m) where it exists, filled
// with the global AWS Terrain Tiles (Terrarium) outside Tyrol and at small zoom levels.
//
// A tile z/x/y is a (N+3) x (N+3) Float32 grid, row-major from the north-west: N cells span the tile edge to edge
// (N+1 samples) plus one border sample on every side, so neighbouring tiles share their edge samples and the client
// can compute normals across tile seams.
import zlib from 'node:zlib';
import { fromArrayBuffer } from 'geotiff';
import { PNG } from 'pngjs';
import { tileBounds, tileSize, xToLon, yToLat, HALF, cached, fetchBuf, limiter, once } from './util.js';

export const N = 256;
export const S = N + 3;
export const MAX_Z = 17;

const WCS = 'https://gis.tirol.gv.at/arcgis/services/Service_Public/terrain/MapServer/WCSServer';
// tiris publishes the DGM in two Gauss-Krüger zones; lon/lat envelopes from DescribeCoverage
const ZONES = {
  M28: { lon: [10.08, 11.797], lat: [46.75, 47.615], c5: 'Gelaendemodell_5m_M28', c05: 'Gelaendemodell_50cm_M28' },
  M31: { lon: [11.733, 12.975], lat: [46.63, 47.758], c5: 'Gelaendemodell_5m_M31', c05: 'Gelaendemodell_50cm_M31' },
};
const TYROL = [10.08, 46.63, 12.975, 47.758];

const wcsLimit = limiter(6);
const terrLimit = limiter(8);
const dedupe = once();

// ---------------------------------------------------------------- tiris WCS
// The WCS answers with uncompressed, tiled float32 GeoTIFFs whose empty blocks (outside the coverage) have no bytes,
// which geotiff.js cannot read, so the blocks are copied out by hand.
async function decodeWcsTiff(buf) {
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const img = await (await fromArrayBuffer(ab)).getImage();
  const d = img.fileDirectory, W = img.getWidth(), H = img.getHeight();
  const out = new Float32Array(W * H).fill(NaN);
  if (d.Compression !== 1 || !d.TileWidth || img.getBitsPerSample() !== 32) {
    const [r] = await img.readRasters(); out.set(r);
  } else {
    const tw = d.TileWidth, th = d.TileLength, across = Math.ceil(W / tw);
    const dv = new DataView(ab), le = img.littleEndian;
    d.TileOffsets.forEach((off, t) => {
      if (!d.TileByteCounts[t]) return;
      const tx = (t % across) * tw, ty = Math.floor(t / across) * th;
      for (let r = 0; r < th && ty + r < H; r++)
        for (let c = 0; c < tw && tx + c < W; c++) out[(ty + r) * W + tx + c] = dv.getFloat32(off + (r * tw + c) * 4, le);
    });
  }
  const [ox, oy] = img.getOrigin(), [rx, ry] = img.getResolution();
  return { W, H, ox, oy, rx, ry, data: out };
}

async function fetchWcs(coverage, lon0, lat0, lon1, lat1, W, H) {
  const url = `${WCS}?service=WCS&version=1.0.0&request=GetCoverage&coverage=${coverage}&crs=EPSG:4326&format=GeoTIFF` +
    `&interpolation=bilinear&bbox=${lon0},${lat0},${lon1},${lat1}&width=${W}&height=${H}`;
  const r = await wcsLimit(() => fetchBuf(url, { timeout: 90000 }));
  if (!r.buf || !r.type.includes('tiff')) return null;
  return decodeWcsTiff(r.buf);
}

const valid = (h) => h > 1 && h < 5000;      // tiris marks no-data as 0, sparse blocks come back as NaN

// fill grid samples that are still missing from one tiris coverage
async function fillFromWcs(grid, z, x, y, coverage) {
  const [x0, , , y1] = tileBounds(z, x, y), cell = tileSize(z) / N;
  const lon0 = xToLon(x0 - 1.5 * cell), lon1 = xToLon(x0 + (N + 1.5) * cell);
  const latT = yToLat(y1 + 1.5 * cell), latB = yToLat(y1 - (N + 1.5) * cell);
  const g = await fetchWcs(coverage, lon0, latB, lon1, latT, S, S);
  if (!g) return;
  // columns line up with the grid (Mercator x is linear in longitude); rows are re-sampled from latitude
  for (let j = 0; j < S; j++) {
    const lat = yToLat(y1 - (j - 1) * cell);
    const r = Math.min(Math.max((g.oy - lat) / -g.ry - 0.5, 0), g.H - 1);
    const r0 = Math.floor(r), r1 = Math.min(r0 + 1, g.H - 1), f = r - r0;
    for (let i = 0; i < S; i++) {
      const k = j * S + i;
      if (valid(grid[k])) continue;
      const a = g.data[r0 * g.W + i], b = g.data[r1 * g.W + i];
      const h = valid(a) && valid(b) ? a + (b - a) * f : valid(a) ? a : b;
      if (valid(h)) grid[k] = h;
    }
  }
}

// ---------------------------------------------------------------- AWS Terrain Tiles (Terrarium encoding)
const terrMem = new Map();
async function terrariumTile(z, x, y) {
  const key = `${z}/${x}/${y}`;
  if (terrMem.has(key)) { const v = terrMem.get(key); terrMem.delete(key); terrMem.set(key, v); return v; }
  const png = await cached(`terrarium/${key}.png`, 0, async () =>
    (await terrLimit(() => fetchBuf(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${key}.png`))).buf);
  let h = null;
  if (png) {
    const { data } = PNG.sync.read(png);
    h = new Float32Array(256 * 256);
    for (let p = 0; p < h.length; p++) h[p] = data[p * 4] * 256 + data[p * 4 + 1] + data[p * 4 + 2] / 256 - 32768;
  }
  terrMem.set(key, h);
  if (terrMem.size > 96) terrMem.delete(terrMem.keys().next().value);
  return h;
}

async function fillFromTerrarium(grid, z, x, y, zt) {
  const [x0, , , y1] = tileBounds(z, x, y), cell = tileSize(z) / N;
  const scale = (256 * 2 ** zt) / (2 * HALF), n = 2 ** zt;
  const need = [];
  for (let k = 0; k < S * S; k++) if (!valid(grid[k])) need.push(k);
  if (!need.length) return;
  const px = (k) => (x0 + ((k % S) - 1) * cell + HALF) * scale - 0.5;
  const py = (k) => (HALF - (y1 - (Math.floor(k / S) - 1) * cell)) * scale - 0.5;
  const tiles = new Map();
  for (const k of need) {
    const gx = px(k), gy = py(k);
    for (const tx of [Math.floor(gx / 256), Math.floor((gx + 1) / 256)])
      for (const ty of [Math.floor(gy / 256), Math.floor((gy + 1) / 256)]) tiles.set(`${tx},${ty}`, [tx, ty]);
  }
  await Promise.all([...tiles.values()].map(async ([tx, ty]) => {
    tiles.set(`${tx},${ty}`, (tx < 0 || ty < 0 || tx >= n || ty >= n) ? null : await terrariumTile(zt, tx, ty));
  }));
  const at = (gx, gy) => {
    gx = Math.max(gx, 0); gy = Math.max(gy, 0);
    const t = tiles.get(`${Math.floor(gx / 256)},${Math.floor(gy / 256)}`);
    return t ? t[(gy % 256) * 256 + (gx % 256)] : 0;
  };
  for (const k of need) {
    const gx = px(k), gy = py(k), ix = Math.floor(gx), iy = Math.floor(gy), fx = gx - ix, fy = gy - iy;
    const a = at(ix, iy), b = at(ix + 1, iy), c = at(ix, iy + 1), d = at(ix + 1, iy + 1);
    grid[k] = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  }
}

// ---------------------------------------------------------------- tiles
function overlaps(a, b) { return a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]; }

async function buildTile(z, x, y) {
  const grid = new Float32Array(S * S).fill(NaN);
  const [x0, y0, x1, y1] = tileBounds(z, x, y);
  const ll = [xToLon(x0), yToLat(y0), xToLon(x1), yToLat(y1)];
  if (z >= 11 && overlaps(ll, TYROL)) {
    const cLon = (ll[0] + ll[2]) / 2;
    const order = cLon < 11.765 ? ['M28', 'M31'] : ['M31', 'M28'];
    for (const zone of order) {
      const Z = ZONES[zone];
      if (!overlaps(ll, [Z.lon[0], Z.lat[0], Z.lon[1], Z.lat[1]])) continue;
      if (grid.every(valid)) break;
      try { await fillFromWcs(grid, z, x, y, z >= 14 ? Z.c05 : Z.c5); } catch (e) { console.warn('wcs', zone, z, x, y, e.message); }
    }
  }
  await fillFromTerrarium(grid, z, x, y, Math.min(z, 12));
  return grid;
}

// the raw grid (cached on disk, the most recent ones in memory); used by the tile endpoint and by route profiles
const mem = new Map();
export async function demTile(z, x, y) {
  const key = `${z}/${x}/${y}`;
  if (mem.has(key)) { const g = mem.get(key); mem.delete(key); mem.set(key, g); return g; }
  const buf = await dedupe(key, () => cached(`dem/v1/${key}.f32`, 0, async () => {
    const g = await buildTile(z, x, y);
    return Buffer.from(g.buffer);
  }));
  const g = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  mem.set(key, g);
  if (mem.size > 160) mem.delete(mem.keys().next().value);
  return g;
}

export async function demTileGz(z, x, y) {
  const g = await demTile(z, x, y);
  return zlib.gzipSync(Buffer.from(g.buffer, g.byteOffset, g.byteLength), { level: 4 });
}

// bilinear elevations for many points (Mercator metres) at one zoom level: loads the tiles in parallel, then samples
export async function sampleElevations(z, pts, onProgress) {
  const size = tileSize(z), cell = size / N;
  const key = ([mx, my]) => `${Math.floor((mx + HALF) / size)},${Math.floor((HALF - my) / size)}`;
  const tiles = new Map();
  for (const p of pts) tiles.set(key(p), null);
  let done = 0;
  const load = limiter(6);
  await Promise.all([...tiles.keys()].map((k) => load(async () => {
    const [tx, ty] = k.split(',').map(Number);
    try { tiles.set(k, await demTile(z, tx, ty)); } catch (e) { console.warn('dem', z, k, e.message); }
    onProgress?.(++done, tiles.size);
  })));
  return pts.map((p) => {
    const g = tiles.get(key(p));
    if (!g) return null;
    const tx = Math.floor((p[0] + HALF) / size), ty = Math.floor((HALF - p[1]) / size);
    const [x0, , , y1] = tileBounds(z, tx, ty);
    const gx = (p[0] - x0) / cell + 1, gy = (y1 - p[1]) / cell + 1;
    const i = Math.min(Math.floor(gx), S - 2), j = Math.min(Math.floor(gy), S - 2), fx = gx - i, fy = gy - j;
    const a = g[j * S + i], b = g[j * S + i + 1], c = g[(j + 1) * S + i], d = g[(j + 1) * S + i + 1];
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  });
}
