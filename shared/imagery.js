// Imagery sources (Web Mercator, 256 px), the same on the server and in the browser:
//   ortho   basemap.at orthophoto (Austria), patched with EOX Sentinel-2 cloudless where basemap.at has no data
//   tiris   Land Tirol orthophoto, current flight (20 cm), same patching outside Tyrol
//   eox     EOX Sentinel-2 cloudless 2023 (Europe-wide fallback)
//   over    Land Tirol overlays from the "Sport" map service as transparent PNG (mountain trails, wildlife zones, lifts)
import { tileBounds } from './geo.js';

export const eoxUrl = (z, x, y) => `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2023_3857/default/GoogleMapsCompatible/${z}/${y}/${x}.jpg`;
export const basemapUrl = (z, x, y) => `https://mapsneu.wien.gv.at/basemap/bmaporthofoto30cm/normal/google3857/${z}/${y}/${x}.jpeg`;
const TIRIS = 'https://gis.tirol.gv.at/arcgis/rest/services/Service_Public';

export const tirisExport = (service, layers, z, x, y, format) => {
  const b = tileBounds(z, x, y);
  return `${TIRIS}/${service}/MapServer/export?bbox=${b.join(',')}&bboxSR=3857&imageSR=3857&size=256,256&dpi=96` +
    `&format=${format}&transparent=${format.startsWith('png')}&layers=show:${layers}&f=image`;
};
export const tirisOrthoUrl = (z, x, y) => tirisExport('orthofoto', 3, z, x, y, 'jpg');

// overlay layers of the tiris "ogd_sport" service the client may ask for
export const OVERLAYS = { bergwege: 17, wildschutz: 10, lifte: 8, skigebiete: 7, rodel: 9 };
export function overlayIds(names) {
  return String(names || '').split(',').map((n) => OVERLAYS[n]).filter((v) => v !== undefined).sort((a, b) => a - b);
}
export const overlayUrl = (ids, z, x, y) => tirisExport('ogd_sport', ids.join(','), z, x, y, 'png32');

// for a source with no tiles beyond maxZ: the ancestor at maxZ and where this tile sits in it
export function ancestorTile(urlOf, maxZ, z, x, y) {
  const k = z > maxZ ? 2 ** (z - maxZ) : 1;
  return { url: urlOf(Math.min(z, maxZ), Math.floor(x / k), Math.floor(y / k)), k, ox: ((x % k) * 256) / k, oy: ((y % k) * 256) / k };
}
export const eoxFallback = (z, x, y) => ancestorTile(eoxUrl, 16, z, x, y);

const isWhite = (d, o) => d[o] >= 250 && d[o + 1] >= 250 && d[o + 2] >= 250;
// does this orthophoto tile (RGBA) have a "no coverage" white area worth patching?
export function needsPatch(rgba) {
  let white = 0;
  for (let o = 0; o < rgba.length; o += 4) if (isWhite(rgba, o)) white++;
  return white >= rgba.length / 4 / 200;
}
// replace the white area with the fallback tile's pixels (RGBA, 256 x 256), in place
export function patchWhite(rgba, fallback, { k, ox, oy }) {
  for (let p = 0; p < 256 * 256; p++) {
    const o = p * 4;
    if (!isWhite(rgba, o)) continue;
    const q = (Math.floor(oy + Math.floor(p / 256) / k) * 256 + Math.floor(ox + (p % 256) / k)) * 4;
    rgba[o] = fallback[q]; rgba[o + 1] = fallback[q + 1]; rgba[o + 2] = fallback[q + 2];
  }
  return rgba;
}
