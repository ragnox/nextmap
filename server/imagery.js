// Imagery tiles (Web Mercator, 256 px), proxied and cached on disk:
//   ortho   basemap.at orthophoto (Austria), patched with EOX Sentinel-2 cloudless where basemap.at has no data
//   tiris   Land Tirol orthophoto, current flight (20 cm), same patching outside Tyrol
//   eox     EOX Sentinel-2 cloudless 2023 (Europe-wide fallback)
//   over    Land Tirol overlays from the "Sport" map service as transparent PNG (mountain trails, wildlife zones, lifts)
import jpeg from 'jpeg-js';
import { tileBounds, cached, fetchBuf, limiter } from './util.js';

const lim = limiter(10);
const tirisLim = limiter(6);
const EOX = (z, x, y) => `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2023_3857/default/GoogleMapsCompatible/${z}/${y}/${x}.jpg`;
const BASEMAP = (z, x, y) => `https://mapsneu.wien.gv.at/basemap/bmaporthofoto30cm/normal/google3857/${z}/${y}/${x}.jpeg`;
const TIRIS = 'https://gis.tirol.gv.at/arcgis/rest/services/Service_Public';

const tirisExport = (service, layers, z, x, y, format) => {
  const b = tileBounds(z, x, y);
  return `${TIRIS}/${service}/MapServer/export?bbox=${b.join(',')}&bboxSR=3857&imageSR=3857&size=256,256&dpi=96` +
    `&format=${format}&transparent=${format.startsWith('png')}&layers=show:${layers}&f=image`;
};

// overlay layers of the tiris "ogd_sport" service the client may ask for
export const OVERLAYS = { bergwege: 17, wildschutz: 10, lifte: 8, skigebiete: 7, rodel: 9 };

async function get(url, limit = lim) {
  const r = await limit(() => fetchBuf(url));
  return r.buf && /image/.test(r.type) ? r.buf : null;
}

// replace the pure white "no coverage" area of an orthophoto tile by EOX Sentinel-2 cloudless
async function patchWhite(buf, z, x, y) {
  let img;
  try { img = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true }); } catch { return buf; }
  const d = img.data;
  let white = 0;
  for (let o = 0; o < d.length; o += 4) if (d[o] >= 250 && d[o + 1] >= 250 && d[o + 2] >= 250) white++;
  if (white < d.length / 4 / 200) return buf;
  const fb = await get(EOX(Math.min(z, 16), x >> Math.max(0, z - 16), y >> Math.max(0, z - 16)));
  if (!fb) return buf;
  const f = jpeg.decode(fb, { useTArray: true, formatAsRGBA: true }).data;
  const k = z > 16 ? 2 ** (z - 16) : 1, ox = (x % k) * 256 / k, oy = (y % k) * 256 / k;
  for (let p = 0; p < 256 * 256; p++) {
    const o = p * 4;
    if (!(d[o] >= 250 && d[o + 1] >= 250 && d[o + 2] >= 250)) continue;
    const fx = Math.floor(ox + (p % 256) / k), fy = Math.floor(oy + Math.floor(p / 256) / k), q = (fy * 256 + fx) * 4;
    d[o] = f[q]; d[o + 1] = f[q + 1]; d[o + 2] = f[q + 2];
  }
  return Buffer.from(jpeg.encode({ data: d, width: 256, height: 256 }, 88).data);
}

export async function imageryTile(layer, z, x, y, extra) {
  if (layer === 'eox') return { type: 'image/jpeg', buf: await cached(`img/eox/${z}/${x}/${y}.jpg`, 0, () => get(EOX(z, x, y))) };
  if (layer === 'ortho' || layer === 'tiris') {
    const buf = await cached(`img/${layer}/${z}/${x}/${y}.jpg`, 0, async () => {
      const src = layer === 'ortho' ? await get(BASEMAP(z, x, y)) : await get(tirisExport('orthofoto', 3, z, x, y, 'jpg'), tirisLim);
      if (!src) return z <= 16 ? get(EOX(z, x, y)) : null;
      return patchWhite(src, z, x, y);
    });
    return { type: 'image/jpeg', buf };
  }
  if (layer === 'over') {
    const ids = String(extra || '').split(',').map((n) => OVERLAYS[n]).filter((v) => v !== undefined).sort((a, b) => a - b);
    if (!ids.length) return { type: 'image/png', buf: null };
    const buf = await cached(`img/over-${ids.join('-')}/${z}/${x}/${y}.png`, 30 * 86400e3, () =>
      get(tirisExport('ogd_sport', ids.join(','), z, x, y, 'png32'), tirisLim));
    return { type: 'image/png', buf };
  }
  return null;
}
