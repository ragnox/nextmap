// The public site's usage counts (src/stats.js): one small POST per visit with tallies of events from the
// whitelist in shared/stats.js, written to Workers Analytics Engine (binding STATS). Nothing about the visitor is
// read or written — not the IP, not the user agent, not the time beyond what the dataset stamps. The answer is
// always 204: a bad body is dropped, not reported, so there is nothing to probe.
import { decode, MAX_BYTES } from '../shared/stats.js';

const done = () => new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });

export async function onRequestPost({ request, env }) {
  const url = new URL(request.url), origin = request.headers.get('Origin'), site = request.headers.get('Sec-Fetch-Site');
  if ((origin && origin !== url.origin) || (site && site !== 'same-origin')) return done();
  if (Number(request.headers.get('Content-Length') || 0) > MAX_BYTES) return done();
  const text = await request.text().catch(() => '');
  const points = decode(text);
  if (!points || !env.STATS) return done();
  try {
    for (const [event, value, n] of points) env.STATS.writeDataPoint({ indexes: [event], blobs: [value], doubles: [n] });
  } catch { /* counting never breaks the site */ }
  return done();
}

export const onRequestGet = () => new Response('not here', { status: 405, headers: { Allow: 'POST' } });
