// Elevation tiles in Web Mercator, built the same way on the server and in the browser: Land Tirol laser-scan DGM
// (tiris WCS, 5 m and 0.5 m) where it exists, filled with the global AWS Terrain Tiles (Terrarium) outside Tyrol and
// at small zoom levels.
//
// A tile z/x/y is a (N+3) x (N+3) Float32 grid, row-major from the north-west: N cells span the tile edge to edge
// (N+1 samples) plus one border sample on every side, so neighbouring tiles share their edge samples and normals can
// be computed across tile seams.
import { tileBounds, tileSize, xToLon, yToLat, HALF } from './geo.js';

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

export const terrariumUrl = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
const wcsUrl = (coverage, lon0, lat0, lon1, lat1, W, H) =>
  `${WCS}?service=WCS&version=1.0.0&request=GetCoverage&coverage=${coverage}&crs=EPSG:4326&format=GeoTIFF` +
  `&interpolation=bilinear&bbox=${lon0},${lat0},${lon1},${lat1}&width=${W}&height=${H}`;

// ---------------------------------------------------------------- the WCS GeoTIFFs
// The WCS answers with uncompressed float32 GeoTIFFs, tiled, whose empty blocks (outside the coverage) have no
// bytes. This reads exactly that (tiles or strips) and the georeferencing; anything else gives null.
export function parseTiff(buf) {
  const dv = new DataView(buf instanceof ArrayBuffer ? buf : buf.buffer, buf.byteOffset || 0, buf.byteLength);
  const le = dv.getUint16(0) === 0x4949;
  if (dv.getUint16(2, le) !== 42) return null;
  const size = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];
  const tags = {};
  const ifd = dv.getUint32(4, le), count = dv.getUint16(ifd, le);
  for (let i = 0; i < count; i++) {
    const o = ifd + 2 + i * 12, tag = dv.getUint16(o, le), type = dv.getUint16(o + 2, le), n = dv.getUint32(o + 4, le);
    const bytes = (size[type] || 1) * n, at = bytes <= 4 ? o + 8 : dv.getUint32(o + 8, le);
    const read = (k) => type === 3 ? dv.getUint16(at + k * 2, le) : type === 4 ? dv.getUint32(at + k * 4, le)
      : type === 12 ? dv.getFloat64(at + k * 8, le) : type === 11 ? dv.getFloat32(at + k * 4, le) : dv.getUint8(at + k);
    tags[tag] = n === 1 ? read(0) : Array.from({ length: n }, (_, k) => read(k));
  }
  const arr = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
  const W = tags[256], H = tags[257], bps = arr(tags[258])[0], fmt = arr(tags[339])[0] ?? 1;
  if (tags[259] !== 1 || bps !== 32 || fmt !== 3 || (tags[277] ?? 1) !== 1) return null;
  const [rx, ry] = arr(tags[33550]), tp = arr(tags[33922]);
  if (!rx || tp.length < 6) return null;
  const out = new Float32Array(W * H).fill(NaN);
  const tiled = tags[322] != null;
  const tw = tiled ? tags[322] : W, th = tiled ? tags[323] : (tags[278] ?? H);
  const offs = arr(tiled ? tags[324] : tags[273]), counts = arr(tiled ? tags[325] : tags[279]), across = Math.ceil(W / tw);
  offs.forEach((off, t) => {
    if (!counts[t]) return;                                      // an empty block: no data there
    const tx = (t % across) * tw, ty = Math.floor(t / across) * th;
    for (let r = 0; r < th && ty + r < H; r++)
      for (let c = 0; c < tw && tx + c < W; c++) out[(ty + r) * W + tx + c] = dv.getFloat32(off + (r * tw + c) * 4, le);
  });
  return { W, H, ox: tp[3] - tp[0] * rx, oy: tp[4] + tp[1] * ry, rx, ry: -ry, data: out };
}

// Terrarium PNG pixels (RGBA, 256 x 256) to metres
export function decodeTerrarium(rgba) {
  const h = new Float32Array(256 * 256);
  for (let p = 0; p < h.length; p++) h[p] = rgba[p * 4] * 256 + rgba[p * 4 + 1] + rgba[p * 4 + 2] / 256 - 32768;
  return h;
}

const valid = (h) => h > 1 && h < 5000;      // tiris marks no-data as 0, empty blocks come back as NaN

// fill grid samples that are still missing from one tiris coverage
async function fillFromWcs(grid, z, x, y, coverage, fetchBuffer) {
  const [x0, , , y1] = tileBounds(z, x, y), cell = tileSize(z) / N;
  const lon0 = xToLon(x0 - 1.5 * cell), lon1 = xToLon(x0 + (N + 1.5) * cell);
  const latT = yToLat(y1 + 1.5 * cell), latB = yToLat(y1 - (N + 1.5) * cell);
  const buf = await fetchBuffer(wcsUrl(coverage, lon0, latB, lon1, latT, S, S));
  const g = buf && parseTiff(buf);
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

async function fillFromTerrarium(grid, z, x, y, zt, terrarium) {
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
    tiles.set(`${tx},${ty}`, (tx < 0 || ty < 0 || tx >= n || ty >= n) ? null : await terrarium(zt, tx, ty).catch(() => null));
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

const overlaps = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];

// io.fetchBuffer(url) -> ArrayBuffer | Uint8Array | null (only GeoTIFF answers);
// io.terrarium(z, x, y) -> Float32Array(65536) | null (decoded with decodeTerrarium)
export async function buildDemTile(z, x, y, io) {
  const grid = new Float32Array(S * S).fill(NaN);
  const [x0, y0, x1, y1] = tileBounds(z, x, y);
  const ll = [xToLon(x0), yToLat(y0), xToLon(x1), yToLat(y1)];
  if (z >= 11 && overlaps(ll, TYROL)) {
    const cLon = (ll[0] + ll[2]) / 2;
    for (const zone of cLon < 11.765 ? ['M28', 'M31'] : ['M31', 'M28']) {
      const Z = ZONES[zone];
      if (!overlaps(ll, [Z.lon[0], Z.lat[0], Z.lon[1], Z.lat[1]])) continue;
      if (grid.every(valid)) break;
      try { await fillFromWcs(grid, z, x, y, z >= 14 ? Z.c05 : Z.c5, io.fetchBuffer); } catch (e) { io.warn?.(`wcs ${zone} ${z}/${x}/${y}: ${e.message}`); }
    }
  }
  await fillFromTerrarium(grid, z, x, y, Math.min(z, 12), io.terrarium);
  return grid;
}

// bilinear elevation at Mercator metres from one tile's grid
export function sampleTile(grid, z, mx, my) {
  const size = tileSize(z), cell = size / N;
  const tx = Math.floor((mx + HALF) / size), ty = Math.floor((HALF - my) / size);
  const [x0, , , y1] = tileBounds(z, tx, ty);
  const gx = (mx - x0) / cell + 1, gy = (y1 - my) / cell + 1;
  const i = Math.min(Math.floor(gx), S - 2), j = Math.min(Math.floor(gy), S - 2), fx = gx - i, fy = gy - j;
  const a = grid[j * S + i], b = grid[j * S + i + 1], c = grid[(j + 1) * S + i], d = grid[(j + 1) * S + i + 1];
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}
