// The public site's own data, as a Cloudflare Pages Function in front of the R2 bucket (binding TILES):
//   up/wcs?…                    the Land Tirol elevation (tiris WCS GetCoverage), fetched once and kept in R2
//   up/tiris/<service>/MapServer/export?…   tiris map exports (orthophoto, overlays), the same
//   up/s2/<mosaic>/<z>/<x>/<y>.png|jpg      nextmap's own Sentinel-2 mosaics, put there by scripts/s2-mosaic.js
//                                            (PUT with the UPLOAD_KEY secret)
// Visitors' browsers then do not all ask the Land's servers for the same tiles. Only these few upstream requests
// are allowed, so this is no open proxy.
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

export async function onRequestGet({ request, env, params, waitUntil }) {
  const url = new URL(request.url), path = [].concat(params.path || []).join('/');
  const edge = caches.default, hit = await edge.match(request);
  if (hit) return hit;
  let res;

  if (S2.test(path)) {
    const obj = env.TILES && (await env.TILES.get(path));
    if (!obj) return new Response('no tile', { status: 404, headers: { 'Cache-Control': 'public, max-age=86400' } });
    res = answer(obj.body, path.endsWith('.png') ? 'image/png' : 'image/jpeg', 'r2');
  } else {
    const target = upstream(url, path);
    if (!target) return new Response('not allowed', { status: 403 });
    const key = `up/v1/${await sha(target)}`;
    const obj = env.TILES && (await env.TILES.get(key));
    if (obj) res = answer(obj.body, obj.httpMetadata?.contentType || 'application/octet-stream', 'r2');
    else {
      const up = await fetch(target, { headers: { 'User-Agent': UA } });
      const type = up.headers.get('content-type') || '';
      // the ArcGIS server reports errors as XML or JSON with status 200: only images and coverages are kept
      if (!up.ok || !/tiff|^image\//.test(type)) return new Response(up.body, { status: up.ok ? 502 : up.status, headers: { 'Content-Type': type } });
      const buf = await up.arrayBuffer();
      if (env.TILES) waitUntil(env.TILES.put(key, buf, { httpMetadata: { contentType: type }, customMetadata: { url: target } }));
      res = answer(buf, type, 'upstream');
    }
  }
  waitUntil(edge.put(request, res.clone()));
  return res;
}

// mosaic tiles from scripts/s2-mosaic.js
export async function onRequestPut({ request, env, params }) {
  const path = [].concat(params.path || []).join('/');
  if (!env.UPLOAD_KEY || request.headers.get('X-Upload-Key') !== env.UPLOAD_KEY) return new Response('no', { status: 403 });
  if (!S2.test(path) || !env.TILES) return new Response('not here', { status: 400 });
  await env.TILES.put(path, await request.arrayBuffer(), { httpMetadata: { contentType: path.endsWith('.png') ? 'image/png' : 'image/jpeg' } });
  return new Response('ok');
}
