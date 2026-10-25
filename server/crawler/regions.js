// Regions on the server: the presets, otherwise Nominatim (answers kept on disk).
import { fetchJSON, readJSON, writeJSON } from '../util.js';
import { slug } from '../../shared/geo.js';
import { presetRegion, geocodeUrl, pickGeocodeHit, regionFromHit } from '../../shared/regions.js';

export { PRESETS } from '../../shared/regions.js';

export async function resolveRegion(q) {
  const name = String(q || 'Zillertal').trim();
  const preset = presetRegion(name);
  if (preset) return preset;
  const key = `geocode/${slug(name)}.json`;
  let hit = await readJSON(key);
  if (!hit) {
    hit = pickGeocodeHit(await fetchJSON(geocodeUrl(name)));
    if (!hit) return null;
    await writeJSON(key, hit);
  }
  return regionFromHit(hit, name);
}
