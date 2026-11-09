// The public site's own data, as a Cloudflare Pages Function in front of the R2 bucket (binding TILES):
//   up/wcs?…                    the Land Tirol elevation (tiris WCS GetCoverage), from R2 where already kept, else
//                               fetched and kept at the edge
//   up/tiris/<service>/MapServer/export?…   tiris map exports (orthophoto, overlays), the same
//   up/s2/<mosaic>/<z>/<x>/<y>.png|jpg      nextmap's own Sentinel-2 mosaics, put there by scripts/s2-mosaic.js
//                                            (PUT with the UPLOAD_KEY from .env; the site knows only its SHA-256)
// Visitors' browsers then do not all ask the Land's servers for the same tiles. Only these few upstream requests
// are allowed, so this is no open proxy.
// Cost guard: visitors never write to R2 (tiris answers stay in the free edge cache only), so storage and writes
// stay where the uploads put them, and reads (at most one per Function request, 100k a day) stay in the free tier.
// Health: every request that gets past the edge cache writes one point to Analytics Engine (binding STATS, see
// scripts/stats.js): what was asked (wcs, tiris, s2), where it came from (r2, upstream, upstream-error, missing,
// forbidden) and how long it took — nothing about who asked — and logs the same line for `wrangler pages deployment tail`.
const TIRIS = 'https://gis.tirol.gv.at/arcgis';
const UA = 'nextmap/0.1 (3D map of Tyrol; +https://nextmap.pages.dev)';
const KEEP = 'public, max-age=2592000';                      // 30 days in browsers and at the edge

// the upstream URL for a request, or null where it is not one of ours
function upstream(url, path) {
  const q = url.searchParams, has = (k, v) => [...q].some(([key, val]) => key.toLowerCase() === k && val.toLowerCase() === v);
  if (path === 'wcs' && has('service', 'wcs') && has('request', 'getcoverage'))
    return `${TIRIS}/services/Service_Public/terrain/MapServer/WCSServer${url.search}`;
  const m = path.match(/^tiris\/([a-z0-9_]+)\/MapServer\/export$/i);
  if (m && has('f', 'image')) return `${TIRIS}/rest/services/Service_Public/${m[1]}/MapServer/export${url.search}`;
  return null;
}

const S2 = /^s2\/[a-z0-9-]+\/\d{1,2}\/\d+\/\d+\.(png|jpg)$/;

async function sha(s) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const answer = (body, type, from) => new Response(body, { headers: { 'Content-Type': type, 'Cache-Control': KEEP, 'X-Nextmap-Cache': from } });

// what a path asks for, for the health counts
export const kindOf = (path) => (S2.test(path) ? 's2' : path === 'wcs' ? 'wcs' : /^tiris\//i.test(path) ? 'tiris' : 'none');

// one health point per answer that was not an edge hit; never throws, so counting cannot break serving
export function record(env, kind, outcome, ms, status) {
  try { env.STATS?.writeDataPoint({ indexes: ['up'], blobs: [kind, outcome], doubles: [ms, status] }); } catch { /* no dataset bound */ }
  console.log(`up ${kind} ${outcome} ${status} ${ms}ms`);
}

export async function onRequestGet({ request, env, params, waitUntil }) {
  const url = new URL(request.url), path = [].concat(params.path || []).join('/');
  const edge = caches.default, hit = await edge.match(request);
  if (hit) return hit;
  const t0 = Date.now(), kind = kindOf(path);
  const fail = (res, outcome) => { record(env, kind, outcome, Date.now() - t0, res.status); return res; };
  let res;

  if (kind === 's2') {
    const obj = env.TILES && (await env.TILES.get(path));
    if (!obj) return fail(new Response('no tile', { status: 404, headers: { 'Cache-Control': 'public, max-age=86400' } }), 'missing');
    res = answer(obj.body, path.endsWith('.png') ? 'image/png' : 'image/jpeg', 'r2');
  } else {
    const target = upstream(url, path);
    if (!target) return fail(new Response('not allowed', { status: 403 }), 'forbidden');
    const key = `up/v1/${await sha(target)}`;
    const obj = env.TILES && (await env.TILES.get(key));
    if (obj) res = answer(obj.body, obj.httpMetadata?.contentType || 'application/octet-stream', 'r2');
    else {
      const up = await fetch(target, { headers: { 'User-Agent': UA } }).catch(() => null);
      if (!up) return fail(new Response('upstream unreachable', { status: 502 }), 'upstream-error');
      const type = up.headers.get('content-type') || '';
      // the ArcGIS server reports errors as XML or JSON with status 200: only images and coverages are kept
      if (!up.ok || !/tiff|^image\//.test(type)) return fail(new Response(up.body, { status: up.ok ? 502 : up.status, headers: { 'Content-Type': type } }), 'upstream-error');
      const buf = await up.arrayBuffer();
      res = answer(buf, type, 'upstream');
    }
  }
  record(env, kind, res.headers.get('X-Nextmap-Cache'), Date.now() - t0, res.status);
  waitUntil(edge.put(request, res.clone()));
  return res;
}

// mosaic tiles from scripts/s2-mosaic.js, sent with the key whose SHA-256 is UPLOAD_KEY_SHA256 (wrangler.toml)
export async function onRequestPut({ request, env, params }) {
  const path = [].concat(params.path || []).join('/'), key = request.headers.get('X-Upload-Key');
  if (!env.UPLOAD_KEY_SHA256 || !key || (await sha(key)) !== env.UPLOAD_KEY_SHA256) return new Response('no', { status: 403 });
  if (!S2.test(path) || !env.TILES) return new Response('not here', { status: 400 });
  await env.TILES.put(path, await request.arrayBuffer(), { httpMetadata: { contentType: path.endsWith('.png') ? 'image/png' : 'image/jpeg' } });
  return new Response('ok');
}
