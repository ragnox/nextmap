// Imagery tiles on the server, proxied and cached on disk; sources and the white-area patching are shared with the
// browser (shared/imagery.js). JPEGs are decoded and encoded with jpeg-js.
import jpeg from 'jpeg-js';
import { cached, fetchBuf, limiter } from './util.js';
import { eoxUrl, basemapUrl, tirisOrthoUrl, overlayIds, overlayUrl, eoxFallback, needsPatch, patchWhite } from '../shared/imagery.js';

export { OVERLAYS } from '../shared/imagery.js';

const lim = limiter(10);
const tirisLim = limiter(6);

async function get(url, limit = lim) {
  const r = await limit(() => fetchBuf(url));
  return r.buf && /image/.test(r.type) ? r.buf : null;
}

// replace the pure white "no coverage" area of an orthophoto tile by EOX Sentinel-2 cloudless
async function patch(buf, z, x, y) {
  let img;
  try { img = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true }); } catch { return buf; }
  if (!needsPatch(img.data)) return buf;
  const fb = eoxFallback(z, x, y), fbuf = await get(fb.url);
  if (!fbuf) return buf;
  patchWhite(img.data, jpeg.decode(fbuf, { useTArray: true, formatAsRGBA: true }).data, fb);
  return Buffer.from(jpeg.encode({ data: img.data, width: 256, height: 256 }, 88).data);
}

export async function imageryTile(layer, z, x, y, extra) {
  if (layer === 'eox') return { type: 'image/jpeg', buf: await cached(`img/eox/${z}/${x}/${y}.jpg`, 0, () => get(eoxUrl(z, x, y))) };
  if (layer === 'ortho' || layer === 'tiris') {
    const buf = await cached(`img/${layer}/${z}/${x}/${y}.jpg`, 0, async () => {
      const src = layer === 'ortho' ? await get(basemapUrl(z, x, y)) : await get(tirisOrthoUrl(z, x, y), tirisLim);
      if (!src) return z <= 16 ? get(eoxUrl(z, x, y)) : null;
      return patch(src, z, x, y);
    });
    return { type: 'image/jpeg', buf };
  }
  if (layer === 'over') {
    const ids = overlayIds(extra);
    if (!ids.length) return { type: 'image/png', buf: null };
    const buf = await cached(`img/over-${ids.join('-')}/${z}/${x}/${y}.png`, 30 * 86400e3, () => get(overlayUrl(ids, z, x, y), tirisLim));
    return { type: 'image/png', buf };
  }
  return null;
}
