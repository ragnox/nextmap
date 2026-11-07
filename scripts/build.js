// Builds the browser code.
//   node scripts/build.js            public/app.js and public/worker.js, for the local server (npm start)
//   node scripts/build.js --watch    the same, rebuilt on every change
//   node scripts/build.js --static   dist/: the whole site for a static host (Cloudflare Pages), with the
//                                    OpenStreetMap routes of the Tyrol atlas (cache/atlas/, in zoom-10 chunks) or
//                                    else the region snapshots from cache/routes/ (bergfex stays local), and the
//                                    place list for the search box
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { tileAt, lonToX, latToY } from '../shared/geo.js';
import { packPlaces } from '../shared/places.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const at = (...p) => path.join(ROOT, ...p);
const common = { bundle: true, format: 'esm', target: 'es2022', logLevel: 'warning' };
const arg = process.argv[2];
const CF_BEACON = 'f19449d62d184f05b822eeb5d27f4c2f';

if (arg !== '--static') {
  const opts = { ...common, entryPoints: { app: at('src/main.js'), worker: at('src/worker.js') }, outdir: at('public'), sourcemap: true, minify: arg !== '--watch' };
  if (arg === '--watch') { await (await esbuild.context(opts)).watch(); console.log('watching src/ and shared/'); }
  else { await esbuild.build(opts); console.log('built public/app.js and public/worker.js'); }
} else {
  const DIST = at('dist');
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(path.join(DIST, 'data'), { recursive: true });
  const hash = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 10);
  const emit = (name, ext, text) => { const f = `${name}.${hash(text)}.${ext}`; fs.writeFileSync(path.join(DIST, f), text); return f; };
  const bundle = async (entry, define = {}) => (await esbuild.build({ ...common, entryPoints: [at(entry)], write: false, minify: true, define })).outputFiles[0].text;

  const worker = emit('worker', 'js', await bundle('src/worker.js', { 'globalThis.NEXTMAP_PROXY': 'true' }));
  const app = emit('app', 'js', await bundle('src/main.js', { 'globalThis.NEXTMAP_WORKER': JSON.stringify(worker) }));
  const css = emit('style', 'css', fs.readFileSync(at('public/style.css'), 'utf8'));
  const html = fs.readFileSync(at('public/index.html'), 'utf8')
    .replace('href="style.css"', `href="${css}"`)
    .replace('src="app.js"', `src="${app}"`)
    .replace('<meta charset="utf-8">', '<meta charset="utf-8">\n<meta name="nextmap-mode" content="static">')
    // Cloudflare Web Analytics for the public site (see the privacy note). Pages' own injection of this script left
    // out some deployments, so the build adds it.
    .replace('</body>', `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token": "${CF_BEACON}"}'></script>\n</body>`);
  fs.writeFileSync(path.join(DIST, 'index.html'), html);
  // the home-screen app: manifest and icons
  fs.copyFileSync(at('public/manifest.webmanifest'), path.join(DIST, 'manifest.webmanifest'));
  fs.cpSync(at('public/icons'), path.join(DIST, 'icons'), { recursive: true });

  // route snapshots: OpenStreetMap only (ODbL, attributed in the page); bergfex's tours are for local use
  const KEEP = ['id', 'source', 'kind', 'name', 'ref', 'network', 'operator', 'difficulty', 'from', 'to', 'description', 'url', 'website', 'start', 'lines', 'stats', 'top', 'parts', 'goal'];
  // OSM routes, and Bike & Hike tours combined from OSM routes only
  const open = (r) => r.source === 'osm' || (r.source === 'combined' && (r.parts || []).every((p) => p.source === 'osm'));
  const r5 = (v) => Math.round(v * 1e5) / 1e5, pt = (p) => [r5(p[0]), r5(p[1]), ...p.slice(2).map((v) => Math.round(v))];
  const slim = (r) => {
    const o = Object.fromEntries(KEEP.filter((k) => r[k] != null).map((k) => [k, r[k]]));
    o.lines = r.lines.map((l) => l.map(pt)); o.start = pt(r.start);
    if (r.top) o.top = pt(r.top);
    if (r.goal) o.goal = { ...r.goal, at: pt(r.goal.at) };
    return o;
  };
  const write = (rel, data) => { const f = path.join(DIST, 'data', rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(data)); };
  const regions = [];
  const atlas = fs.existsSync(at('cache/atlas/routes.json')) ? JSON.parse(fs.readFileSync(at('cache/atlas/routes.json'), 'utf8')) : null;
  if (atlas) {
    // every route in the chunk where it starts
    const chunks = new Map();
    for (const r of atlas.routes) {
      if (!open(r) || !r.start || !r.lines?.length) continue;
      const k = tileAt(atlas.chunkZ, lonToX(r.start[0]), latToY(r.start[1])).join('/');
      if (!chunks.has(k)) chunks.set(k, []);
      chunks.get(k).push(slim(r));
    }
    for (const [k, list] of chunks) write(`atlas/${atlas.chunkZ}/${k}.json`, { routes: list });
    const count = (src) => atlas.routes.filter((r) => open(r) && r.source === src).length;
    write('atlas/index.json', { bbox: atlas.bbox, chunkZ: atlas.chunkZ, crawled: atlas.crawled, counts: { osm: count('osm'), combined: count('combined') },
      chunks: Object.fromEntries([...chunks].map(([k, l]) => [k, l.length])) });
    regions.push(`the Tyrol atlas (${[...chunks.values()].reduce((s, l) => s + l.length, 0)} routes in ${chunks.size} chunks)`);
  }
  // nextmap's own Sentinel-2 mosaics (scripts/s2-mosaic.js; the tiles themselves are in R2)
  const mosaics = {};
  for (const name of fs.existsSync(at('cache/s2mosaic')) ? fs.readdirSync(at('cache/s2mosaic')) : []) {
    const meta = at('cache/s2mosaic', name, 'meta.json');
    if (fs.existsSync(meta)) { const m = JSON.parse(fs.readFileSync(meta, 'utf8')); if (!mosaics[m.season] || m.rendered > mosaics[m.season].rendered) mosaics[m.season] = m; }
  }
  if (Object.keys(mosaics).length) write('s2.json', mosaics);
  // the path network for the route planner (scripts/network.js), its tiles under their version so they never change
  const netIndex = at('cache/net/index.json');
  const net = fs.existsSync(netIndex) ? JSON.parse(fs.readFileSync(netIndex, 'utf8')) : null;
  if (net) {
    fs.cpSync(at('cache/net', String(net.z)), path.join(DIST, 'net', net.version, String(net.z)), { recursive: true });
    write('net.json', { ...net, path: `net/${net.version}` });
    regions.push(`the path network (${net.counts.km} km in ${net.counts.tiles} tiles, ${(net.bytes / 1e6).toFixed(1)} MB)`);
  }
  if (fs.existsSync(at('cache/atlas/places.json'))) write('places.json', packPlaces(JSON.parse(fs.readFileSync(at('cache/atlas/places.json'), 'utf8')).places));
  for (const f of !atlas && fs.existsSync(at('cache/routes')) ? fs.readdirSync(at('cache/routes')).filter((n) => n.endsWith('.json')) : []) {
    const d = JSON.parse(fs.readFileSync(at('cache/routes', f), 'utf8'));
    const routes = d.routes.filter((r) => open(r) && r.start && r.lines?.length).map(slim);
    if (!routes.length) continue;
    const osm = d.sources.osm;
    const sources = { osm: { ...osm, count: routes.filter((r) => r.source === 'osm').length } };
    if (routes.some((r) => r.source === 'combined')) sources.combined = { ...d.sources.combined, count: routes.filter((r) => r.source === 'combined').length };
    write(`routes/${f}`, { region: d.region, slug: d.slug, bbox: d.bbox, view: d.view, updated: osm?.crawled, sources, routes });
    regions.push(`${d.region} (${routes.length})`);
  }
  fs.writeFileSync(path.join(DIST, 'data', 'LICENSE.txt'),
    'Route data and the path network (net/) © OpenStreetMap contributors, available under the Open Database License (ODbL) 1.0: https://opendatacommons.org/licenses/odbl/\n' +
    'Elevations measured on the Land Tirol DGM (tiris, CC BY 4.0) and the AWS Terrain Tiles.\n');

  // the page itself and the route data are checked on every visit; the hashed files never change
  fs.writeFileSync(path.join(DIST, '_headers'), [
    '/*', '  X-Content-Type-Options: nosniff', '  Referrer-Policy: strict-origin-when-cross-origin',
    '/', '  Cache-Control: no-cache', '/index.html', '  Cache-Control: no-cache',
    '/data/*', '  Cache-Control: public, max-age=600',
    '/manifest.webmanifest', '  Content-Type: application/manifest+json',
    '/net/*', '  Cache-Control: public, max-age=31536000, immutable',
    ...[worker, app, css].flatMap((f) => [`/${f}`, '  Cache-Control: public, max-age=31536000, immutable']),
  ].join('\n') + '\n');

  const kb = (f) => Math.round(fs.statSync(path.join(DIST, f)).size / 1024);
  console.log(`dist/: ${app} ${kb(app)} kB, ${worker} ${kb(worker)} kB, ${css}; data: ${regions.join(', ') || 'no region'}`);
}
