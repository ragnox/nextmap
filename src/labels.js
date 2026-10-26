// Place and peak names for the hybrid map, as labels on the screen: read from the OpenStreetMap vector tiles under
// the drawn terrain, set on their ground point, the most important first, none overlapping, and hidden when a ridge
// stands between them and the camera.
import * as THREE from 'three';
import { EARTH_R } from './geo.js';

const MAX = 60;
const PLACE_WEIGHT = { city: 120, town: 90, suburb: 40, village: 55, hamlet: 25 };

export class Labels {
  constructor(container, backend, terrain, frame) {
    this.el = container; this.backend = backend; this.terrain = terrain; this.frame = frame;
    this.visible = false; this.tiles = new Map(); this.pool = []; this.onChange = null;
  }

  // label tiles (zoom 9-12) under the drawn terrain
  wanted(draw) {
    const keys = new Set();
    for (const { node: t } of draw) {
      if (t.z < 9) continue;
      const lz = Math.min(t.z, 12), d = t.z - lz;
      keys.add(`${lz}/${t.x >> d}/${t.y >> d}`);
    }
    return keys;
  }

  load(key) {
    if (this.tiles.has(key)) return;
    const [z, x, y] = key.split('/').map(Number);
    this.tiles.set(key, null);
    this.backend.labels(z, x, y).then((list) => {
      for (const l of list) { const [wx, wz] = this.frame.fromLonLat(l.at[0], l.at[1]); l.wx = wx; l.wz = wz; }
      this.tiles.set(key, list); this.onChange?.();
    }).catch(() => this.tiles.delete(key));
    if (this.tiles.size > 400) this.tiles.delete(this.tiles.keys().next().value);
  }

  hidden(cam, p) {
    for (let k = 1; k < 12; k++) {
      const f = k / 12, x = cam.x + (p.x - cam.x) * f, z = cam.z + (p.z - cam.z) * f, y = cam.y + (p.y - cam.y) * f;
      const g = this.terrain.surfaceAt(x, z, cam);
      if (g !== null && g > y + 4) return true;
    }
    return false;
  }

  update(camera, draw) {
    const el = this.el;
    if (!this.visible) { el.hidden = true; return; }
    el.hidden = false;
    const keys = this.wanted(draw);
    for (const k of keys) this.load(k);
    const W = el.clientWidth, H = el.clientHeight, cam = camera.position, v = new THREE.Vector3();
    // candidates, deduplicated (the same place comes in tiles of several zoom levels)
    const seen = new Set(), cands = [];
    for (const k of keys) for (const l of this.tiles.get(k) || []) {
      const id = `${l.name}|${Math.round(l.wx / 200)}|${Math.round(l.wz / 200)}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const ground = this.terrain.heightAt(l.wx, l.wz);
      const h = l.kind === 'peak' && l.ele ? Math.max(l.ele, ground ?? 0) : ground;
      if (h == null) continue;
      const dx = l.wx - cam.x, dz = l.wz - cam.z, dist = Math.hypot(dx, dz);
      const y = h - (dx * dx + dz * dz) / (2 * EARTH_R) + 8;
      v.set(l.wx, y, l.wz).project(camera);
      if (v.z > 1 || v.x < -1.05 || v.x > 1.05 || v.y < -1.05 || v.y > 1.05) continue;
      const weight = l.kind === 'place' ? PLACE_WEIGHT[l.cls] ?? 20 : l.kind === 'peak' ? 20 + (l.ele ?? 1500) / 50 : 15;
      cands.push({ l, sx: (v.x * 0.5 + 0.5) * W, sy: (-v.y * 0.5 + 0.5) * H, p: { x: l.wx, y, z: l.wz }, score: weight - dist / 1500 });
    }
    cands.sort((a, b) => b.score - a.score);
    // the panels over the map count as taken
    const placed = [], boxes = [...document.querySelectorAll('#side, #layers.open, #layers-btn, #nav')]
      .filter((e) => e.offsetParent !== null).map((e) => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; });
    for (const c of cands) {
      if (placed.length >= MAX) break;
      const text = c.l.kind === 'peak' && c.l.ele ? `${c.l.name} ${Math.round(c.l.ele)}` : c.l.name;
      const w = text.length * 6.6 + 18, h = 18;
      const box = [c.sx - w / 2, c.sy - h - 6, c.sx + w / 2, c.sy];
      if (boxes.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) continue;
      if (this.hidden(cam, c.p)) continue;
      boxes.push(box); placed.push({ ...c, text });
    }
    while (this.pool.length < placed.length) { const d = document.createElement('div'); el.appendChild(d); this.pool.push(d); }
    this.pool.forEach((d, i) => {
      const c = placed[i];
      d.hidden = !c;
      if (!c) return;
      d.className = `label ${c.l.kind} ${c.l.cls || ''}`;
      if (d.textContent !== c.text) d.textContent = c.text;
      d.style.transform = `translate(${Math.round(c.sx)}px, ${Math.round(c.sy)}px)`;
    });
  }
}
