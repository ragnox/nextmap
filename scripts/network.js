// The path network for the route planner: every road, track and path of the atlas area usable on foot or by bike,
// from Geofabrik's OpenStreetMap extract of the Alps, measured on the elevation model and written as tiles
// (shared/network.js) to cache/net/; scripts/build.js puts them into the static site, the local server serves them.
//   node scripts/network.js       reads cache/osm/alps-latest.osm.pbf (download EXTRACT there first, 2.3 GB)
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { readPbf } from '../server/osmpbf.js';
import { NodeStore, Network, buildTiles } from '../server/network.js';
import { encodeTile, NET_Z, NET_VERSION } from '../shared/network.js';
import { sampleElevations } from '../server/dem.js';
import { ATLAS_BBOX } from '../server/crawler/atlas.js';
import { CACHE } from '../server/util.js';

export const EXTRACT = 'https://download.geofabrik.de/europe/alps-latest.osm.pbf';
const PBF = path.join(CACHE, 'osm', 'alps-latest.osm.pbf');
const OUT = path.join(CACHE, 'net');
const log = (...a) => console.log('[network]', ...a);
const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;

async function main() {
  if (!fs.existsSync(PBF)) throw new Error(`download ${EXTRACT} to ${PBF} first`);
  const size = fs.statSync(PBF).size, t0 = Date.now();
  const nodes = new NodeStore(ATLAS_BBOX);
  let net = null, shown = 0;
  // one pass: a sorted extract has all nodes before the first way
  const header = await readPbf(PBF, {
    header: (h) => { if (!h.optional.includes('Sort.Type_then_ID')) throw new Error('the extract is not sorted'); log(`OpenStreetMap data of ${h.timestamp}`); },
    nodes: (ids, lons, lats, n) => nodes.add(ids, lons, lats, n),
    way: (id, refs, tags) => {
      if (!net) { nodes.finish(); log(`${nodes.count} nodes in the area`); net = new Network(nodes); }
      net.addWay(refs, tags);
    },
    wayKey: 'highway',
    progress: (pos) => { if (Date.now() - shown > 15000) { shown = Date.now(); log(`read ${Math.round(pos / size * 100)}%`); } },
  });
  log(`read in ${Math.round((Date.now() - t0) / 1000)} s: ${net.ways} ways, ${net.kinds.length} kinds`);

  const tmp = `${OUT}.tmp`, tiles = {}, hash = crypto.createHash('sha256');
  fs.rmSync(tmp, { recursive: true, force: true });
  let raw = 0, packed = 0;
  const totals = await buildTiles(net, {
    sample: (pts) => sampleElevations(13, pts),
    put: (t) => {
      const bytes = encodeTile(t), gz = zlib.deflateRawSync(bytes, { level: 9 }), file = path.join(tmp, `${t.z}/${t.x}/${t.y}.bin`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, gz);
      tiles[`${t.x}/${t.y}`] = gz.length;
      hash.update(`${t.x}/${t.y}:`).update(gz);
      raw += bytes.length; packed += gz.length;
    },
    log,
  });
  const km = (m) => Math.round(m / 1000);
  const index = {
    format: NET_VERSION, z: NET_Z, bbox: ATLAS_BBOX, version: hash.digest('hex').slice(0, 10),
    osm: header.timestamp, source: EXTRACT, built: new Date().toISOString(),
    counts: { tiles: totals.tiles, junctions: totals.junctions, edges: totals.edges, km: km(totals.length) },
    kmByClass: Object.fromEntries(Object.entries(totals.byClass).sort((a, b) => b[1] - a[1]).map(([c, m]) => [c, km(m)])),
    bytes: packed, tiles,
  };
  fs.writeFileSync(path.join(tmp, 'index.json'), JSON.stringify(index));
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.renameSync(tmp, OUT);
  const sizes = Object.values(tiles).sort((a, b) => a - b);
  log(`${totals.tiles} tiles, ${totals.edges} edges, ${totals.junctions} junctions, ${km(totals.length)} km`);
  log(`${mb(packed)} compressed (${mb(raw)} raw); a tile is ${Math.round(sizes[sizes.length >> 1] / 1024)} kB typically, ${Math.round(sizes.at(-1) / 1024)} kB at most`);
  log(`version ${index.version} in ${Math.round((Date.now() - t0) / 1000)} s, ${mb(process.memoryUsage().rss)} memory`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
