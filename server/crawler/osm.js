// OpenStreetMap routes in the region via the Overpass API; parsing, naming and merging are shared with the public
// site's crawler (shared/routes.js).
import { fetchBuf } from '../util.js';
import { OVERPASS, overpassQuery, parseOverpass } from '../../shared/routes.js';

export { pieces, chain, kindOf, NUMBERED } from '../../shared/routes.js';

export async function crawlOsm(region, log) {
  let json = null, lastErr;
  for (const url of OVERPASS) {
    try {
      log(`Overpass: asking ${new URL(url).host}`);
      const r = await fetchBuf(url, { method: 'POST', body: new URLSearchParams({ data: overpassQuery(region.bbox) }), timeout: 200000, retries: 1 });
      if (r.buf) { json = JSON.parse(r.buf.toString('utf8')); break; }
    } catch (e) { lastErr = e; log(`Overpass: ${new URL(url).host} failed (${e.message})`); }
  }
  if (!json) throw lastErr || new Error('Overpass did not answer');
  const { routes, pois } = parseOverpass(json);
  routes.pois = pois;
  const n = (k) => routes.filter((r) => r.kind === k).length;
  log(`Overpass: ${routes.length} routes (${n('hike')} hiking, ${n('mtb') + n('emtb')} bike, ${n('skitour')} ski touring, ${n('freeride')} freeride)`);
  return routes;
}
