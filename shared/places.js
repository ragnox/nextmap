// The place list behind the search box: towns, villages, valleys, mountain ranges, peaks, huts and lakes in and
// around Tyrol, from OpenStreetMap (server/crawler/atlas.js). Searched as you type, without asking a geocoder.
import { slug } from './geo.js';

// stored compactly, one array per place: [name, type, lon, lat, ele, near, w, s, e, n], where near is the index of
// the closest town or village (to tell the six peaks called Kreuzjoch apart) and the extent comes only for valleys,
// ranges and lakes
export const TYPES = ['city', 'town', 'village', 'hamlet', 'valley', 'range', 'peak', 'saddle', 'hut', 'lake'];
const round = (v) => Math.round(v * 1e5) / 1e5;
const SETTLEMENT = new Set(['city', 'town', 'village']), EXTENT = new Set(['valley', 'range', 'lake']);

export function packPlaces(places) {
  const list = [], pieces = new Map();
  for (const p of places) {
    const type = p.type === 'place' ? p.cls : p.type;
    if (!TYPES.includes(type)) continue;
    const q = { name: p.name_de || p.name, type, at: p.at, ele: p.ele, bbox: p.bbox };
    // a valley or lake mapped in several pieces is one place
    const k = `${type}|${q.name}`, same = q.bbox && EXTENT.has(type) && pieces.get(k)?.find((o) => touch(o.bbox, q.bbox));
    if (same) { same.bbox = [Math.min(same.bbox[0], q.bbox[0]), Math.min(same.bbox[1], q.bbox[1]), Math.max(same.bbox[2], q.bbox[2]), Math.max(same.bbox[3], q.bbox[3])]; same.at = [(same.bbox[0] + same.bbox[2]) / 2, (same.bbox[1] + same.bbox[3]) / 2]; continue; }
    list.push(q);
    if (q.bbox && EXTENT.has(type)) pieces.set(k, [...(pieces.get(k) || []), q]);
  }
  const towns = list.map((p, i) => [p, i]).filter(([p]) => SETTLEMENT.has(p.type));
  return list.map((p) => {
    let near = -1, best = 0.15 ** 2;                       // within about 12 km
    if (!SETTLEMENT.has(p.type)) for (const [t, i] of towns) { const d = dist2(p.at, t.at); if (d < best) { best = d; near = i; } }
    const row = [p.name, TYPES.indexOf(p.type), round(p.at[0]), round(p.at[1]), p.ele ? Math.round(p.ele) : 0, near];
    if (p.bbox) row.push(...p.bbox.map(round));
    return row;
  });
}
const touch = (a, b, m = 0.03) => a[0] - m < b[2] && b[0] - m < a[2] && a[1] - m < b[3] && b[1] - m < a[3];

export function unpackPlaces(rows) {
  const list = rows.map(([name, t, lon, lat, ele, , ...bbox]) => ({ name, type: TYPES[t], at: [lon, lat], ele: ele || null, bbox: bbox.length ? bbox : null, near: null, key: fold(name) }));
  rows.forEach((r, i) => { if (r[5] >= 0 && list[r[5]]) list[i].near = list[r[5]].name; });
  return list;
}

// lower case without accents, so "otztal" finds Ötztal and "strasse" finds Straße
export const fold = (s) => slug(s).replace(/-/g, ' ');

// how much each kind of place is worth in the list (a city before a hamlet, a high peak before a low one)
const WEIGHT = { range: 60, valley: 58, city: 62, town: 56, village: 48, lake: 34, peak: 30, hut: 30, hamlet: 22, saddle: 18 };
const value = (p) => WEIGHT[p.type] + (p.type === 'peak' && p.ele ? p.ele / 250 : 0);

// the best few places for what was typed; names that start with it come first, then words in the name that do
export function searchPlaces(places, q, limit = 8) {
  const k = fold(q);
  if (k.length < 2) return [];
  const hits = [];
  for (const p of places) {
    const at = p.key.indexOf(k);
    if (at < 0) continue;
    const match = p.key === k ? 40 : at === 0 ? 25 : p.key[at - 1] === ' ' ? 15 : 0;
    hits.push({ p, score: match + value(p) - p.key.length / 10 });
  }
  hits.sort((a, b) => b.score - a.score);
  // one entry for the same name and kind close together (a peak with two summits, a village and its node)
  const out = [];
  for (const { p } of hits) {
    if (out.some((o) => o.name === p.name && o.type === p.type && Math.abs(o.at[0] - p.at[0]) + Math.abs(o.at[1] - p.at[1]) < 0.03)) continue;
    out.push(p);
    if (out.length >= limit) break;
  }
  return out;
}

// the place called `name`; with several, the one nearest `near` ([lon, lat]), else the most important
export function findPlace(places, name, near) {
  const k = fold(name);
  const same = places.filter((p) => p.key === k);
  if (!same.length) return null;
  if (near) return same.reduce((a, b) => (dist2(a.at, near) <= dist2(b.at, near) ? a : b));
  return same.reduce((a, b) => (value(a) >= value(b) ? a : b));
}
const dist2 = (a, b) => (a[0] - b[0]) ** 2 + ((a[1] - b[1]) * 1.5) ** 2;

// a place as a region to show and list routes for: its own extent for a valley or range, else ~20 km around it
const KM = 1 / 111.32;
export function regionFromPlace(p) {
  const [lon, lat] = p.at, k = Math.cos(lat * Math.PI / 180);
  const half = p.type === 'hamlet' || p.type === 'hut' || p.type === 'saddle' ? 8 : 10;
  let [w, s, e, n] = p.bbox || [lon, lat, lon, lat];
  const hw = Math.max((e - w) / 2 + 2 * KM / k, half * KM / k), hh = Math.max((n - s) / 2 + 2 * KM, half * KM);
  const cx = (w + e) / 2, cy = (s + n) / 2;
  const bbox = [cx - hw, cy - hh, cx + hw, cy + hh].map((v) => Math.round(v * 1e4) / 1e4);
  return { name: p.name, type: p.type, bbox, view: p.at, bergfex: slug(p.name), slug: slug(p.name) };
}

export const PLACE_LABEL = { city: 'City', town: 'Town', village: 'Village', hamlet: 'Hamlet', valley: 'Valley', range: 'Mountain range', peak: 'Peak', saddle: 'Pass', hut: 'Hut', lake: 'Lake' };
