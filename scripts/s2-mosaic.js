// nextmap's own Sentinel-2 mosaics for the public site, in place of EOX's cloudless map (not for commercial use) and
// of every visitor asking the Planetary Computer: summer and winter at zoom 11-13 over the Tyrol atlas area and at
// zoom 8-10 over the wider Alps (the far views from the summits), each pixel from the least cloudy scene of the
// season (Copernicus Sentinel-2 L2A, rendered by the Planetary Computer).
// Tiles are PNG with the snow fraction in alpha (composed as in shared/sentinel.js); the summer mosaic also comes as
// JPEG, to patch the orthophoto where it has no data.
//   node scripts/s2-mosaic.js render summer|winter   tiles into cache/s2mosaic/<name>/, and <name>/meta.json
//   node scripts/s2-mosaic.js upload <name> <site>    to the site's R2 bucket through functions/up (UPLOAD_KEY in .env)
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';
import { CACHE, fetchBuf, fetchJSON, limiter, tileAt, lonToX, latToY } from '../server/util.js';
import { PC, visualUrl, ndsiUrl, composeSnow } from '../shared/sentinel.js';
import { ATLAS_BBOX } from '../server/crawler/atlas.js';

// [first zoom, last zoom, area]
export const WIDE_BBOX = [8.0, 45.5, 15.0, 48.6];
export const MOSAIC_LEVELS = [[8, 10, WIDE_BBOX], [11, 13, ATLAS_BBOX]];
// late summer has the least snow, March the most snow with the sun high enough to light north faces
const SEASONS = {
  summer: { name: 'summer-2026', window: ['2026-07-01', '2026-09-15'], cloud: 20 },
  winter: { name: 'winter-2026', window: ['2026-03-01', '2026-03-31'], cloud: 20 },
};
const log = (...a) => console.log('[s2]', ...a);

async function register({ window: [t0, t1], cloud }) {
  const [w, s, e, n] = WIDE_BBOX;
  const poly = { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] };
  const reg = await fetchJSON(`${PC}/data/v1/mosaic/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      collections: ['sentinel-2-l2a'], 'filter-lang': 'cql2-json',
      filter: { op: 'and', args: [
        { op: 's_intersects', args: [{ property: 'geometry' }, poly] },
        { op: 'anyinteracts', args: [{ property: 'datetime' }, { interval: [`${t0}T00:00:00Z`, `${t1}T23:59:59Z`] }] },
        { op: '<', args: [{ property: 'eo:cloud_cover' }, cloud] },
      ] },
      sortby: [{ field: 'eo:cloud_cover', direction: 'asc' }],
    }),
  });
  return reg.searchid || reg.id;
}

export function mosaicTiles(levels = MOSAIC_LEVELS) {
  const out = [];
  for (const [z0, z1, bbox] of levels) for (let z = z0; z <= z1; z++) {
    const [x0, y0] = tileAt(z, lonToX(bbox[0]), latToY(bbox[3])), [x1, y1] = tileAt(z, lonToX(bbox[2]), latToY(bbox[1]));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push([z, x, y]);
  }
  return out;
}

async function render(season) {
  const S = SEASONS[season];
  if (!S) throw new Error('summer or winter');
  const dir = path.join(CACHE, 's2mosaic', S.name);
  let sid = await register(S);
  log(`${S.name}: mosaic ${sid}`);
  const tiles = mosaicTiles(), pc = limiter(6);
  let done = 0, empty = 0, made = 0;
  const get = async (u) => {
    for (let i = 0; ; i++) {
      const r = await pc(() => fetchBuf(u(sid), { timeout: 90000, okStatus: [200, 204, 404] }));
      // the tiler forgets a mosaic after a day: register it again
      if (r.status === 404 && i < 2) { sid = await register(S); continue; }
      return r.status === 200 && r.buf?.length ? PNG.sync.read(r.buf).data : null;
    }
  };
  await Promise.all(tiles.map(async ([z, x, y]) => {
    const file = path.join(dir, `${z}/${x}/${y}.png`);
    if (fs.existsSync(file) || fs.existsSync(file + '.none')) { done++; return; }
    try {
      const [v, n] = await Promise.all([get((id) => visualUrl(id, z, x, y)), get((id) => ndsiUrl(id, z, x, y))]);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (!v) { fs.writeFileSync(file + '.none', ''); empty++; return; }
      const rgba = composeSnow(v, n), png = new PNG({ width: 256, height: 256 });
      png.data = Buffer.from(rgba);
      fs.writeFileSync(file, PNG.sync.write(png, { colorType: 6 }));
      if (season === 'summer') {
        const rgb = Buffer.from(rgba);
        for (let o = 3; o < rgb.length; o += 4) rgb[o] = 255;
        fs.writeFileSync(file.replace(/\.png$/, '.jpg'), jpeg.encode({ data: rgb, width: 256, height: 256 }, 82).data);
      }
      made++;
    } catch (e) { log(`${z}/${x}/${y}: ${e.message}`); }
    if (++done % 200 === 0) log(`${done}/${tiles.length} (${made} new, ${empty} empty)`);
  }));
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
    name: S.name, season, window: S.window, maxCloud: S.cloud, levels: MOSAIC_LEVELS, bbox: ATLAS_BBOX, minZoom: 8, maxZoom: 13, wideMaxZoom: 10,
    rendered: new Date().toISOString(), source: 'Copernicus Sentinel-2 L2A, rendered by the Microsoft Planetary Computer',
  }));
  log(`${S.name}: ${made} tiles made, ${empty} without data, ${tiles.length} in all`);
}

// every tile file under cache/s2mosaic/<name>/ to <site>/up/s2/<name>/…, a few at a time
async function upload(name, site) {
  const key = process.env.UPLOAD_KEY;
  if (!key || !site) throw new Error('needs UPLOAD_KEY in .env and the site, e.g. https://nextmap.pages.dev');
  const dir = path.join(CACHE, 's2mosaic', name), files = [];
  const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) f.isDirectory() ? walk(path.join(d, f.name)) : /\.(png|jpg)$/.test(f.name) && files.push(path.join(d, f.name)); };
  walk(dir);
  const put = limiter(8);
  let done = 0, failed = 0;
  await Promise.all(files.map((f) => put(async () => {
    const rel = path.relative(dir, f).split(path.sep).join('/');
    for (let i = 0; i < 3; i++) {
      const r = await fetch(`${site}/up/s2/${name}/${rel}`, { method: 'PUT', headers: { 'X-Upload-Key': key }, body: fs.readFileSync(f) }).catch(() => null);
      if (r?.ok) break;
      if (i === 2) { failed++; log(`${rel}: ${r?.status ?? 'no answer'}`); }
    }
    if (++done % 500 === 0) log(`${done}/${files.length} uploaded`);
  })));
  log(`${name}: ${files.length - failed} of ${files.length} files uploaded`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, a, b] = process.argv.slice(2);
  (cmd === 'render' ? render(a) : cmd === 'upload' ? upload(a, b) : Promise.reject(new Error('render summer|winter, or upload <name> <site>')))
    .catch((e) => { console.error(e.message); process.exit(1); });
}
