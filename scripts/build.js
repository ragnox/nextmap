// Builds the browser code.
//   node scripts/build.js            public/app.js and public/worker.js, for the local server (npm start)
//   node scripts/build.js --watch    the same, rebuilt on every change
//   node scripts/build.js --static   dist/: the whole site for a static host (Cloudflare Pages), with the
//                                    OpenStreetMap route snapshots from cache/routes/ (bergfex stays local)
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const at = (...p) => path.join(ROOT, ...p);
const common = { bundle: true, format: 'esm', target: 'es2022', logLevel: 'warning' };
const arg = process.argv[2];

if (arg !== '--static') {
  const opts = { ...common, entryPoints: { app: at('src/main.js'), worker: at('src/worker.js') }, outdir: at('public'), sourcemap: true, minify: arg !== '--watch' };
  if (arg === '--watch') { await (await esbuild.context(opts)).watch(); console.log('watching src/ and shared/'); }
  else { await esbuild.build(opts); console.log('built public/app.js and public/worker.js'); }
} else {
  const DIST = at('dist');
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(path.join(DIST, 'data', 'routes'), { recursive: true });
  const hash = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 10);
  const emit = (name, ext, text) => { const f = `${name}.${hash(text)}.${ext}`; fs.writeFileSync(path.join(DIST, f), text); return f; };
  const bundle = async (entry, define = {}) => (await esbuild.build({ ...common, entryPoints: [at(entry)], write: false, minify: true, define })).outputFiles[0].text;

  const worker = emit('worker', 'js', await bundle('src/worker.js'));
  const app = emit('app', 'js', await bundle('src/main.js', { 'globalThis.NEXTMAP_WORKER': JSON.stringify(worker) }));
  const css = emit('style', 'css', fs.readFileSync(at('public/style.css'), 'utf8'));
  const html = fs.readFileSync(at('public/index.html'), 'utf8')
    .replace('href="style.css"', `href="${css}"`)
    .replace('src="app.js"', `src="${app}"`)
    .replace('<meta charset="utf-8">', '<meta charset="utf-8">\n<meta name="nextmap-mode" content="static">');
  fs.writeFileSync(path.join(DIST, 'index.html'), html);
  // the home-screen app: manifest and icons
  fs.copyFileSync(at('public/manifest.webmanifest'), path.join(DIST, 'manifest.webmanifest'));
  fs.cpSync(at('public/icons'), path.join(DIST, 'icons'), { recursive: true });

  // route snapshots: OpenStreetMap only (ODbL, attributed in the page); bergfex's tours are for local use
  const KEEP = ['id', 'source', 'kind', 'name', 'ref', 'network', 'operator', 'difficulty', 'from', 'to', 'description', 'url', 'website', 'start', 'lines', 'stats', 'top', 'parts', 'goal'];
  // OSM routes, and Bike & Hike tours combined from OSM routes only
  const open = (r) => r.source === 'osm' || (r.source === 'combined' && (r.parts || []).every((p) => p.source === 'osm'));
  const regions = [];
  for (const f of fs.existsSync(at('cache/routes')) ? fs.readdirSync(at('cache/routes')).filter((n) => n.endsWith('.json')) : []) {
    const d = JSON.parse(fs.readFileSync(at('cache/routes', f), 'utf8'));
    const routes = d.routes.filter(open).map((r) => Object.fromEntries(KEEP.filter((k) => r[k] != null).map((k) => [k, r[k]])));
    if (!routes.length) continue;
    const osm = d.sources.osm;
    const sources = { osm: { ...osm, count: routes.filter((r) => r.source === 'osm').length } };
    if (routes.some((r) => r.source === 'combined')) sources.combined = { ...d.sources.combined, count: routes.filter((r) => r.source === 'combined').length };
    fs.writeFileSync(path.join(DIST, 'data', 'routes', f), JSON.stringify({ region: d.region, slug: d.slug, bbox: d.bbox, view: d.view, updated: osm?.crawled, sources, routes }));
    regions.push(`${d.region} (${routes.length})`);
  }
  fs.writeFileSync(path.join(DIST, 'data', 'LICENSE.txt'),
    'Route data © OpenStreetMap contributors, available under the Open Database License (ODbL) 1.0: https://opendatacommons.org/licenses/odbl/\n' +
    'Elevations measured on the Land Tirol DGM (tiris, CC BY 4.0) and the AWS Terrain Tiles.\n');

  // the page itself and the route data are checked on every visit; the hashed files never change
  fs.writeFileSync(path.join(DIST, '_headers'), [
    '/*', '  X-Content-Type-Options: nosniff', '  Referrer-Policy: strict-origin-when-cross-origin',
    '/', '  Cache-Control: no-cache', '/index.html', '  Cache-Control: no-cache',
    '/data/*', '  Cache-Control: public, max-age=600',
    '/manifest.webmanifest', '  Content-Type: application/manifest+json',
    ...[worker, app, css].flatMap((f) => [`/${f}`, '  Cache-Control: public, max-age=31536000, immutable']),
  ].join('\n') + '\n');

  const kb = (f) => Math.round(fs.statSync(path.join(DIST, f)).size / 1024);
  console.log(`dist/: ${app} ${kb(app)} kB, ${worker} ${kb(worker)} kB, ${css}; routes for ${regions.join(', ') || 'no region'}`);
}
