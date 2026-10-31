// nextmap server: static files from public/ and the API for terrain, imagery, Sentinel-2 scenes, routes and crawling.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from './util.js';
import { demTileGz, MAX_Z } from './dem.js';
import { imageryTile } from './imagery.js';
import { scene, s2Tile, S2_MAX_Z } from './sentinel.js';
import { PRESETS, resolveRegion, placeRows } from './crawler/regions.js';
import { SOURCES, startCrawl, jobStatus, loadRoutes, trackFor, attachGpx, trackStatus, backfillTracks, remeasure, needsRemeasure } from './crawler/index.js';
import { RateLimited } from './crawler/polite.js';
import { profile } from './geo.js';

const PORT = Number(process.env.PORT || 5173);
const PUBLIC = path.join(ROOT, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.map': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

const send = (res, status, body, type = 'application/json', extra = {}) => {
  res.writeHead(status, { 'Content-Type': type, ...extra });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
const json = (res, body, status = 200) => send(res, status, body);
const readText = async (req) => {
  let s = '';
  for await (const c of req) { s += c; if (s.length > 5e6) throw new Error('body too large'); }
  return s;
};
const readBody = async (req) => { const s = await readText(req); return s ? JSON.parse(s) : {}; };
const tileArgs = (m) => {
  const [z, x, y] = m.slice(1, 4).map(Number);
  if (!(z >= 0 && z <= 20 && x >= 0 && y >= 0 && x < 2 ** z && y < 2 ** z)) throw Object.assign(new Error('bad tile'), { status: 400 });
  return [z, x, y];
};

const routes = [
  ['GET', /^\/api\/dem\/(\d+)\/(\d+)\/(\d+)$/, async (req, res, m) => {
    const [z, x, y] = tileArgs(m);
    if (z > MAX_Z) return json(res, { error: 'zoom too high' }, 400);
    send(res, 200, await demTileGz(z, x, y), 'application/octet-stream', { 'Content-Encoding': 'gzip', 'Cache-Control': 'public, max-age=604800' });
  }],
  ['GET', /^\/api\/img\/([a-z]+)\/(\d+)\/(\d+)\/(\d+)$/, async (req, res, m, q) => {
    const [z, x, y] = tileArgs(m.slice(1));
    const r = await imageryTile(m[1], z, x, y, q.get('l'));
    if (!r) return json(res, { error: 'unknown layer' }, 404);
    if (!r.buf) return send(res, 204, '', 'text/plain', { 'Cache-Control': 'public, max-age=86400' });
    send(res, 200, r.buf, r.type, { 'Cache-Control': 'public, max-age=604800' });
  }],
  ['GET', /^\/api\/s2\/(winter|summer)$/, async (req, res, m, q) => {
    const region = await resolveRegion(q.get('region') || 'Zillertal');
    const s = await scene(m[1], region.bbox);
    json(res, { ...s, maxZoom: S2_MAX_Z });
  }],
  ['GET', /^\/api\/s2tile\/([\w.-]+)\/(\d+)\/(\d+)\/(\d+)$/, async (req, res, m) => {
    const [z, x, y] = tileArgs(m.slice(1));
    if (z > S2_MAX_Z) return json(res, { error: 'zoom too high' }, 400);
    send(res, 200, await s2Tile(m[1], z, x, y), 'image/png', { 'Cache-Control': 'public, max-age=604800' });
  }],
  ['GET', /^\/api\/regions$/, async (req, res) => json(res, PRESETS.map(({ name, bbox, view }) => ({ name, bbox, view })))],
  ['GET', /^\/api\/places$/, async (req, res) => json(res, await placeRows())],
  ['GET', /^\/api\/region$/, async (req, res, m, q) => {
    const near = (q.get('near') || '').split(',').map(Number);
    const r = await resolveRegion(q.get('q'), near.length === 2 && near.every(Number.isFinite) ? near : null);
    r ? json(res, r) : json(res, { error: 'not found' }, 404);
  }],
  ['GET', /^\/api\/routes$/, async (req, res, m, q) => {
    const near = (q.get('near') || '').split(',').map(Number);
    const region = await resolveRegion(q.get('region') || 'Zillertal', near.length === 2 && near.every(Number.isFinite) ? near : null);
    if (!region) return json(res, { error: 'region not found' }, 404);
    const data = (await loadRoutes(region.slug)) || { region: region.name, slug: region.slug, bbox: region.bbox, view: region.view, sources: {}, routes: [] };
    const tracks = trackStatus(data);
    // bergfex tracks still missing: keep fetching them within bergfex's download quota
    if (tracks.withTrack < tracks.total && !tracks.running && jobStatus()?.state !== 'running') backfillTracks(region.slug);
    if (needsRemeasure(data) && jobStatus()?.state !== 'running') remeasure(region.slug);
    json(res, { ...data, tracks: trackStatus(data) });
  }],
  ['GET', /^\/api\/track$/, async (req, res, m, q) => {
    try {
      const r = await trackFor(q.get('region') || 'Zillertal', String(q.get('id') || ''));
      r ? json(res, r) : json(res, { error: 'no track for this route' }, 404);
    } catch (e) {
      if (e instanceof RateLimited) return json(res, { error: 'download quota used up', until: e.until }, 429);
      throw e;
    }
  }],
  ['POST', /^\/api\/track$/, async (req, res, m, q) => {
    const r = await attachGpx(q.get('region') || 'Zillertal', String(q.get('id') || ''), await readText(req));
    r ? json(res, r) : json(res, { error: 'no track in that file, or no such route' }, 400);
  }],
  ['GET', /^\/api\/sources$/, async (req, res) => json(res, Object.entries(SOURCES).map(([id, s]) => ({ id, label: s.label })))],
  ['GET', /^\/api\/crawl$/, async (req, res) => json(res, jobStatus() || { state: 'idle' })],
  ['POST', /^\/api\/crawl$/, async (req, res) => {
    const b = await readBody(req);
    json(res, startCrawl(String(b.region || 'Zillertal'), Array.isArray(b.sources) && b.sources.length ? b.sources : undefined));
  }],
  ['POST', /^\/api\/profile$/, async (req, res) => {
    const b = await readBody(req);
    const lines = (b.lines || []).filter((l) => Array.isArray(l) && l.length > 1).slice(0, 200);
    if (!lines.length) return json(res, { error: 'no line' }, 400);
    json(res, await profile(lines, { z: 14, step: 10, maxPts: 3000 }));
  }],
];

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) return send(res, 403, 'forbidden', 'text/plain');
  try {
    const buf = await fs.readFile(file);
    send(res, 200, buf, TYPES[path.extname(file)] || 'application/octet-stream', { 'Cache-Control': 'no-cache' });
  } catch { send(res, 404, 'not found', 'text/plain'); }
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    for (const [method, re, fn] of routes) {
      const m = url.pathname.match(re);
      if (m && req.method === method) return await fn(req, res, m, url.searchParams);
    }
    if (url.pathname.startsWith('/api/')) return json(res, { error: 'not found' }, 404);
    await serveStatic(req, res, url.pathname);
  } catch (e) {
    console.error(req.method, url.pathname, e);
    if (!res.headersSent) json(res, { error: e.message }, e.status || 500);
  }
}).listen(PORT, () => console.log(`nextmap on http://localhost:${PORT}`));
