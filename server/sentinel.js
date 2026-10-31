// Sentinel-2 on the server: the shared scene choice and snow composite (shared/sentinel.js), with scenes and finished
// tiles kept on disk.
import { PNG } from 'pngjs';
import { cached, fetchBuf, fetchJSON, readJSON, writeJSON, limiter, once } from './util.js';
import { findScene, visualUrl, ndsiUrl, composeSnow } from '../shared/sentinel.js';

export { S2_MAX_Z, seasonWindow } from '../shared/sentinel.js';

const pcLimit = limiter(6);
const dedupe = once();
const postJSON = (url, body) => fetchJSON(url, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });

// scene per season and region, refreshed twice a day (the tiler's mosaic ids expire after a day)
export async function scene(season, bbox) {
  const key = `s2/scene-${season}-${bbox.map((v) => v.toFixed(2)).join('_')}.json`;
  return dedupe(key, async () => {
    const old = await readJSON(key);
    if (old && Date.now() - old.checked < 43200e3) return old;
    try {
      const s = { ...(await findScene(postJSON, season, bbox)), checked: Date.now() };
      if (s.none && old) return old;
      await writeJSON(key, s);
      return s;
    } catch (e) {
      if (old) return old;
      throw e;
    }
  });
}

let EMPTY;
const emptyPng = () => (EMPTY ||= PNG.sync.write(new PNG({ width: 1, height: 1 })));

async function renderTile(sid, z, x, y) {
  const [v, n] = await Promise.all([visualUrl, ndsiUrl].map((u) => pcLimit(() => fetchBuf(u(sid, z, x, y), { timeout: 60000 }))));
  if (!v.buf?.length) return emptyPng();                      // 204: no scene covers this tile
  const out = new PNG({ width: 256, height: 256 });
  out.data = Buffer.from(composeSnow(PNG.sync.read(v.buf).data, n.buf?.length ? PNG.sync.read(n.buf).data : null));
  return PNG.sync.write(out, { colorType: 6 });
}

export function s2Tile(sid, z, x, y) {
  if (!/^[\w.-]{16,80}$/.test(sid)) throw new Error('bad scene id');
  return cached(`s2/tiles/v2/${sid}/${z}/${x}/${y}.png`, 0, () => renderTile(sid, z, x, y));
}
