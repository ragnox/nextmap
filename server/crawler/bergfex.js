// bergfex.at tour listings for the region (hiking and ski touring), crawled within robots.txt with a pause between
// requests. Tour pages give the start point, duration, ascent, length, altitude range and difficulty; their GPS
// tracks are behind a login and are not fetched, so these routes show as start markers that link to bergfex.
import { politeGet } from './polite.js';

const BASE = 'https://www.bergfex.at';
const CATEGORIES = [
  { path: 'wandern', kind: 'hike', maxPages: 8 },
  { path: 'skitour', kind: 'skitour', maxPages: 15 },
];

const decode = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
const num = (s) => (s == null ? null : Number(String(s).replace(/\./g, '').replace(',', '.')));
const meta = (html, name) => {
  const m = html.match(new RegExp(`<meta[^>]+(?:name|property)="${name}"[^>]*content="([^"]*)"`, 'i'))
    || html.match(new RegExp(`<meta[^>]+content="([^"]*)"[^>]*(?:name|property)="${name}"`, 'i'));
  return m ? decode(m[1]) : null;
};

const KIND_BY_TYPE = { wanderung: 'hike', bergtour: 'hike', hochtour: 'hike', klettersteig: 'hike', 'alpine-tour': 'hike', skitour: 'skitour', schneeschuh: 'snowshoe', 'schneeschuhwanderung': 'snowshoe', winterwanderung: 'hike' };

function parseTour(html, url, type) {
  const geo = meta(html, 'geoposition');
  if (!geo) return null;
  const [lat, lon] = geo.split(',').map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const title = meta(html, 'og:title') || '';
  const desc = meta(html, 'description') || '';
  const text = decode(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');
  const dur = (desc.match(/Dauer:\s*(\d+):(\d+)\s*h/) || text.match(/Dauer\s+(\d+):(\d+)\s*h/));
  const asc = desc.match(/([\d.]+)\s*m Anstieg/) || text.match(/Aufstieg\s+([\d.]+)\s*hm/);
  const km = desc.match(/über\s*([\d.,]+)\s*km/) || text.match(/Strecke\s+([\d.,]+)\s*km/);
  const diff = desc.match(/Schwierigkeit:\s*([\wäöüÄÖÜ-]+)/) || text.match(/Schwierigkeit\s+([\wäöüÄÖÜ-]+)/);
  const alt = text.match(/Seehöhe\s+([\d.]+)\s*-\s*([\d.]+)\s*m/);
  const id = url.match(/\/(\d+),/)[1];
  return {
    id: `bergfex-${id}`, source: 'bergfex', kind: KIND_BY_TYPE[type] || 'hike', name: title.split(' - ')[0].trim() || 'bergfex tour',
    type, url, start: [lon, lat], lines: null,
    description: desc.split('\n')[0].slice(0, 400) || null,
    difficulty: diff ? diff[1] : null,
    stats: {
      length: km ? Math.round(num(km[1]) * 1000) : null,
      ascent: asc ? num(asc[1]) : null,
      min: alt ? num(alt[1]) : null, max: alt ? num(alt[2]) : null,
      duration: dur ? Number(dur[1]) + Number(dur[2]) / 60 : null,
    },
  };
}

export async function crawlBergfex(region, log, onRoutes) {
  const slug = region.bergfex || region.slug;
  const [w, s, e, n] = region.bbox, pad = 0.05;
  const inside = ([lon, lat]) => lon > w - pad && lon < e + pad && lat > s - pad && lat < n + pad;
  const routes = [], seen = new Set();
  for (const cat of CATEGORIES) {
    const links = [];
    for (let page = 1; page <= cat.maxPages; page++) {
      const url = `${BASE}/sommer/${slug}/touren/${cat.path}/${page > 1 ? `?page=${page}` : ''}`;
      const html = await politeGet(url, { cacheKey: `web/bergfex/list-${slug}-${cat.path}-${page}.html`, maxAgeMs: 3 * 86400e3 });
      if (!html) { if (page === 1) log(`bergfex: no ${cat.path} listing for "${slug}"`); break; }
      const found = [...html.matchAll(/href="(\/sommer\/[a-z0-9-]+\/touren\/([a-z0-9-]+)\/(\d+),[^"]*\/)"/g)].filter((m) => !seen.has(m[3]));
      found.forEach((m) => { seen.add(m[3]); links.push({ url: BASE + m[1], type: m[2] }); });
      log(`bergfex ${cat.path}: page ${page}, ${links.length} tours so far`);
      if (!found.length || !html.includes(`page=${page + 1}`)) break;
    }
    let kept = 0;
    for (const [i, l] of links.entries()) {
      const id = l.url.match(/\/(\d+),/)[1];
      const html = await politeGet(l.url, { cacheKey: `web/bergfex/tour-${id}.html` });
      const r = html && parseTour(html, l.url, l.type);
      if (r && inside(r.start)) { routes.push(r); kept++; }
      if (i % 10 === 9 || i === links.length - 1) {
        log(`bergfex ${cat.path}: read ${i + 1}/${links.length} tours, ${kept} in the region`);
        onRoutes?.(routes);
      }
    }
  }
  return routes;
}
