// Regions on the server: the presets, then the place list of the Tyrol atlas, otherwise Nominatim (answers kept on
// disk).
import { fetchJSON, readJSON, writeJSON } from '../util.js';
import { slug } from '../../shared/geo.js';
import { presetRegion, geocodeUrl, pickGeocodeHit, regionFromHit } from '../../shared/regions.js';
import { packPlaces, unpackPlaces, findPlace, regionFromPlace } from '../../shared/places.js';

export { PRESETS } from '../../shared/regions.js';

// the place list as the search box gets it (empty until server/crawler/atlas.js has run)
let rows = null;
export async function placeRows() {
  rows ||= readJSON('atlas/places.json').then((d) => (d ? packPlaces(d.places) : []));
  return rows;
}
let places = null;
const placeList = async () => (places ||= placeRows().then(unpackPlaces));

// near: [lon, lat] to choose between places of the same name
export async function resolveRegion(q, near) {
  const name = String(q || 'Zillertal').trim();
  const preset = presetRegion(name);
  if (preset) return preset;
  const place = findPlace(await placeList(), name, near);
  if (place) return regionFromPlace(place);
  const key = `geocode/${slug(name)}.json`;
  let hit = await readJSON(key);
  if (!hit) {
    hit = pickGeocodeHit(await fetchJSON(geocodeUrl(name)));
    if (!hit) return null;
    await writeJSON(key, hit);
  }
  return regionFromHit(hit, name);
}
