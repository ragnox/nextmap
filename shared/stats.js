// Anonymous usage counts for the public site. The browser tallies a fixed list of events during a visit
// (src/stats.js) and sends the tallies once, when the tab is hidden, to functions/stats.js, which writes them to
// Workers Analytics Engine. Both sides check against this list: an event or value not here never leaves the
// browser, and never reaches the dataset. No identifier, no IP, no position, no time finer than the day.
import { PRESETS } from './regions.js';

const OTHER = 'other';
const KIND = ['all', 'hike', 'bikehike', 'mtb', 'emtb', 'skitour', 'freeride'];

// event → the values it may carry. `open: true` maps any other value to "other" instead of dropping the event
// (regions: the presets are listed, every other place or geocoded name counts as "other").
export const EVENTS = {
  visit: { values: ['phone', 'desktop'] },                          // once per visit, the denominator for the rest
  region: { values: PRESETS.map((p) => p.name), open: true },        // a region opened
  season: { values: ['summer', 'winter'] },                          // the Summer/Winter switch
  style: { values: ['satellite', 'hybrid'] },                        // the Satellite/Hybrid switch
  imagery: { values: ['ortho', 'tiris', 's2'] },                     // the imagery menu
  layer: { values: ['slope', 'contours', 'bergwege', 'wildschutz', 'lifte', 'routes'] },   // a layer switched on
  kind: { values: KIND },                                            // a route-kind filter
  route: { values: ['osm', 'combined', OTHER], open: true },         // a route opened, by its source
  search: { values: ['preset', 'place', 'text'] },                   // the search box: a preset, a place, free text
  crawl: { values: ['web'] },                                        // "Search the web for routes"
  planner: { values: ['open', 'copy', 'link', 'gpx', 'saved'] },     // the planner opened, and from what
  plan: { values: ['gpx', 'share', 'save'] },                        // a planned route exported, shared or saved
  gpx: { values: ['route'] },                                        // a route's GPX downloaded
  help: { values: ['open'] },                                        // the help card
  error: { values: ['webgl', 'js', 'promise', 'worker'] },           // something broke in the visitor's browser
};
export const MAX_KEYS = 25;                                          // Analytics Engine writes at most 25 points per request
export const MAX_BYTES = 2048;
export const MAX_COUNT = 10000;

// the value an event may be stored with, or null when the event or value is not allowed
export function allowed(event, value) {
  const e = EVENTS[event];
  if (!e) return null;
  const v = String(value ?? '');
  if (e.values.includes(v)) return v;
  return e.open ? OTHER : null;
}

export const key = (event, value) => `${event}:${value}`;

// counts: { "event:value": n }; adds one if the event is allowed, returns whether it was
export function tally(counts, event, value) {
  const v = allowed(event, value);
  if (v === null) return false;
  const k = key(event, v);
  counts[k] = Math.min((counts[k] || 0) + 1, MAX_COUNT);
  return true;
}

// what the browser sends: {"v":1,"c":{"region:Zillertal":3,…}}, the MAX_KEYS largest counts, under MAX_BYTES
export function encode(counts) {
  const entries = Object.entries(counts).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, MAX_KEYS);
  let text = JSON.stringify({ v: 1, c: Object.fromEntries(entries) });
  while (text.length > MAX_BYTES && entries.length) { entries.pop(); text = JSON.stringify({ v: 1, c: Object.fromEntries(entries) }); }
  return text;
}

// what the Function accepts: [[event, value, count], …] or null for anything that is not exactly the format above
export function decode(text) {
  if (typeof text !== 'string' || !text || text.length > MAX_BYTES) return null;
  let body;
  try { body = JSON.parse(text); } catch { return null; }
  if (!body || typeof body !== 'object' || body.v !== 1 || !body.c || typeof body.c !== 'object' || Array.isArray(body.c)) return null;
  const entries = Object.entries(body.c);
  if (!entries.length || entries.length > MAX_KEYS) return null;
  const out = [];
  for (const [k, n] of entries) {
    const i = k.indexOf(':');
    if (i < 1) return null;
    const v = allowed(k.slice(0, i), k.slice(i + 1));
    if (v === null || v !== k.slice(i + 1)) return null;                        // the browser already normalised: no "other" games here
    if (!Number.isInteger(n) || n < 1 || n > MAX_COUNT) return null;
    out.push([k.slice(0, i), v, n]);
  }
  return out;
}
