// Regions: hand-made extents for the well-known Tyrolean valleys and mountain groups (valley names geocode to the
// valley floor only), otherwise OpenStreetMap Nominatim, widened to at least ~25 km.
import { slug } from './geo.js';

// bbox [west, south, east, north], view [lon, lat] where the camera starts, looking at the main peaks;
// bergfex: bergfex's name(s) for the area (bergfex's regions are often smaller than these)
export const PRESETS = [
  { name: 'Zillertal', bbox: [11.62, 46.98, 12.25, 47.42], view: [11.865, 47.17], bergfex: 'zillertal' },
  { name: 'Stubaital', bbox: [11.05, 46.93, 11.42, 47.22], view: [11.25, 47.10], bergfex: 'stubaital' },
  { name: 'Ötztal', bbox: [10.70, 46.74, 11.17, 47.25], view: [10.97, 46.95], bergfex: 'oetztal' },
  { name: 'Pitztal', bbox: [10.70, 46.85, 10.95, 47.20], view: [10.85, 47.00], bergfex: 'pitztal' },
  { name: 'Kaunertal', bbox: [10.60, 46.82, 10.85, 47.12], view: [10.73, 46.95], bergfex: 'kaunertal' },
  { name: 'Sellrain', bbox: [11.00, 47.10, 11.30, 47.27], view: [11.15, 47.19], bergfex: ['sellrain-innsbruck', 'kuehtai'] },
  { name: 'Wipptal', bbox: [11.30, 46.98, 11.62, 47.25], view: [11.45, 47.10], bergfex: 'wipptal' },
  { name: 'Karwendel', bbox: [11.20, 47.28, 11.80, 47.55], view: [11.45, 47.38], bergfex: ['achensee', 'silberregion-karwendel', 'seefeld-tirol', 'innsbruck'] },
  { name: 'Kitzbüheler Alpen', bbox: [11.95, 47.25, 12.65, 47.52], view: [12.30, 47.40], bergfex: ['kitzbueheler-alpen-brixental', 'kitzbuehel', 'st-johann-tirol', 'wilder-kaiser'] },
  { name: 'Paznaun', bbox: [10.05, 46.88, 10.45, 47.12], view: [10.25, 47.00], bergfex: 'paznaun-ischgl' },
  { name: 'Arlberg', bbox: [10.05, 47.07, 10.40, 47.25], view: [10.22, 47.15], bergfex: 'arlberg' },
  { name: 'Osttirol', bbox: [12.15, 46.65, 12.95, 47.15], view: [12.55, 46.95], bergfex: 'osttirol' },
];

export function presetRegion(q) {
  const p = PRESETS.find((r) => slug(r.name) === slug(String(q || '').trim()));
  return p ? { ...p, slug: slug(p.name) } : null;
}

// prefer places in and around Tyrol
export const geocodeUrl = (q) => `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&accept-language=de&viewbox=9.5,48.0,13.5,46.4&bounded=0&q=${encodeURIComponent(q)}`;
export function pickGeocodeHit(results) {
  const inAlps = results.filter((r) => r.lat > 45.5 && r.lat < 48.5 && r.lon > 8 && r.lon < 16);
  return (inAlps[0] || results[0]) ?? null;
}

const KM = 1 / 111.32;
function widen([w, s, e, n], minKm) {
  const cx = (w + e) / 2, cy = (s + n) / 2, k = Math.cos(cy * Math.PI / 180);
  const hw = Math.max((e - w) / 2, (minKm / 2) * KM / k), hh = Math.max((n - s) / 2, (minKm / 2) * KM);
  return [cx - hw, cy - hh, cx + hw, cy + hh].map((v) => Math.round(v * 1e4) / 1e4);
}

// a Nominatim hit as a region of at least ~25 km
export function regionFromHit(hit, q) {
  const [s, n, w, e] = hit.boundingbox.map(Number);
  const name = hit.name || q;
  return { name, display: hit.display_name, bbox: widen([w, s, e, n], 25), view: [Number(hit.lon), Number(hit.lat)], bergfex: slug(name), slug: slug(q) };
}
