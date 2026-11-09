// Route worker: snapping points to the path network and finding the way along it (shared/router.js), off the main
// thread so the map stays smooth while a leg is searched, even while a point is dragged. The network's tiles are
// fetched as a search reaches them and kept for the next one.
import { Graph, route, snap, profileFor } from '../shared/router.js';
import { fetchTile, tileUrl } from '../shared/network.js';

let graph = null;
const profiles = new Map();
const profile = (p) => { const k = `${p.activity}:${p.grade}`; if (!profiles.has(k)) profiles.set(k, profileFor(p)); return profiles.get(k); };

const ops = {
  // the network's index (data/net.json, api/net locally, or null) and the page address its paths start from
  init(index, base) {
    graph = index ? new Graph(index, (x, y) => fetchTile(new URL(tileUrl(index, x, y), base))) : null;
    return !!graph;
  },
  snap: async (p) => (graph ? (await snap(graph, p))?.point ?? null : null),
  route: (a, b, p) => (graph ? route(graph, a, b, profile(p)) : { error: 'nonet' }),
};

self.onmessage = async ({ data: { id, op, args } }) => {
  try { self.postMessage({ id, result: await ops[op](...args) }); }
  catch (e) { self.postMessage({ id, error: e.message }); }
};
