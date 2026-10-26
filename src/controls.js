// Camera navigation in the manner of Google Earth and Google Maps:
//   drag                         the ground under the cursor follows it
//   Shift, Ctrl/⌘ or right drag  turn and tilt around the point you grabbed, which stays where it is
//   Alt drag                     look around from where you stand
//   wheel / trackpad pinch       zoom to the point under the cursor; double-click zooms in there (Shift: out)
//   one finger pans, two fingers pinch, twist and tilt
//   arrows / WASD pan, Q E turn, R F tilt, + − zoom, N north up
// The camera is a position plus heading and pitch (no roll). It glides on after a drag and never goes underground.
import * as THREE from 'three';

const D2R = Math.PI / 180;
const UP = new THREE.Vector3(0, 1, 0);
const MIN_AGL = 12, MIN_DIST = 15, MAX_ALT = 250000;
const MIN_PITCH = -89.5 * D2R, MAX_PITCH = 30 * D2R, LOOK_MAX_PITCH = 60 * D2R;
const ORBIT_SPEED = 0.0065, TILT_SPEED = 0.004, LOOK_SPEED = 0.0035;   // radians per pixel
const KEYS = { ArrowUp: 'f', KeyW: 'f', ArrowDown: 'b', KeyS: 'b', ArrowLeft: 'l', KeyA: 'l', ArrowRight: 'r', KeyD: 'r',
  KeyQ: 'tl', KeyE: 'tr', KeyR: 'tu', KeyF: 'td', Equal: 'in', NumpadAdd: 'in', Minus: 'out', NumpadSubtract: 'out' };

const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
const v3 = () => new THREE.Vector3();

export class Controls extends THREE.EventDispatcher {
  constructor(camera, dom, terrain, visualCenter) {
    super();
    this.camera = camera; this.dom = dom; this.terrain = terrain; this.visualCenter = visualCenter;
    camera.rotation.order = 'YXZ';
    this.heading = 0; this.pitch = -35 * D2R;
    this.target = v3();                     // ground at the centre of the view
    this.ray = new THREE.Raycaster();
    this.pointers = new Map();
    this.drag = null; this.glide = null; this.flight = null;
    this.zoom = { pending: 0, pivot: null, at: 0, x: 0, y: 0 };
    this.keys = new Set(); this.keyPivot = null;
    this.samples = [];
    this.active = false;

    dom.addEventListener('pointerdown', (e) => this.onDown(e));
    dom.addEventListener('pointermove', (e) => this.onMove(e));
    dom.addEventListener('pointerup', (e) => this.onUp(e));
    dom.addEventListener('pointercancel', (e) => this.onUp(e));
    dom.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    dom.addEventListener('dblclick', (e) => this.onDblClick(e));
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => this.onKey(e, true));
    window.addEventListener('keyup', (e) => this.onKey(e, false));
    window.addEventListener('blur', () => { this.keys.clear(); });
  }

  // ------------------------------------------------------------ geometry helpers
  setRay(clientX, clientY) {
    const r = this.dom.getBoundingClientRect();
    this.ray.setFromCamera(new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1), this.camera);
    return this.ray.ray;
  }
  hit(clientX, clientY) { return this.terrain.raycast(this.setRay(clientX, clientY)); }
  centerHit() {
    this.ray.setFromCamera(this.visualCenter, this.camera);
    return this.terrain.raycast(this.ray.ray);
  }
  // somewhere to turn around when the cursor is on the sky: the ground in the middle, or a point ahead
  pivotAt(clientX, clientY) {
    return (clientX != null && this.hit(clientX, clientY)) || this.centerHit() ||
      this.camera.position.clone().addScaledVector(this.forward(), Math.max(this.agl() * 3, 2000));
  }
  forward() {
    const cp = Math.cos(this.pitch);
    return new THREE.Vector3(Math.sin(this.heading) * cp, Math.sin(this.pitch), -Math.cos(this.heading) * cp);
  }
  agl() {
    const g = this.terrain.heightAt(this.camera.position.x, this.camera.position.z);
    return this.camera.position.y - (g ?? 0);
  }
  // heading and pitch from wherever the camera looks
  syncFromCamera() {
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    this.heading = Math.atan2(f.x, -f.z); this.pitch = Math.asin(clamp(f.y, -1, 1));
  }
  apply() { this.camera.rotation.set(this.pitch, -this.heading, 0, 'YXZ'); }
  updateTarget() { const h = this.centerHit(); if (h) this.target.copy(h); return this.target; }

  // ------------------------------------------------------------ the moves
  panTo(clientX, clientY, grab) {
    const ray = this.setRay(clientX, clientY), o = this.camera.position, d = ray.direction;
    if (Math.abs(d.y) < 1e-3) return null;
    const t = (grab.y - o.y) / d.y;
    if (t <= 0) return null;                                   // the grabbed point went over the horizon
    const move = new THREE.Vector3(grab.x - (o.x + d.x * t), 0, grab.z - (o.z + d.z * t));
    const max = Math.max(o.distanceTo(grab), 200) * 2;
    if (move.length() > max) move.setLength(max);
    o.add(move);
    return move;
  }

  // turn by dh (radians, about the vertical) and tilt by dp around a pivot; the pivot stays put on screen
  orbit(dh, dp, pivot) {
    const cam = this.camera.position, h0 = this.heading, p0 = this.pitch;
    const off = cam.clone().sub(pivot).applyAxisAngle(UP, -dh);
    this.heading += dh;
    const np = clamp(this.pitch + dp, MIN_PITCH, MAX_PITCH), a = np - this.pitch;
    if (a) {
      const right = new THREE.Vector3(Math.cos(this.heading), 0, Math.sin(this.heading));
      const tilted = off.clone().applyAxisAngle(right, a);
      const pos = pivot.clone().add(tilted), g = this.terrain.heightAt(pos.x, pos.z);
      // keep above the pivot's horizon and above the ground
      const ok = (tilted.y / tilted.length() > Math.sin(1.5 * D2R) || a < 0) && (g === null || pos.y > g + MIN_AGL || a < 0);
      if (ok) { off.copy(tilted); this.pitch = np; }
    }
    // a slope in the way: come closer along the line of sight, so the pivot stays where it is on screen
    for (let k = 1; k > 0.15; k *= 0.85) {
      const pos = pivot.clone().addScaledVector(off, k), g = this.terrain.heightAt(pos.x, pos.z);
      if (g === null || pos.y >= g + MIN_AGL || off.length() * k < MIN_DIST) { cam.copy(pos); return; }
    }
    this.heading = h0; this.pitch = p0;                          // no room at all: stay put
  }

  look(dh, dp) {
    this.heading += dh;
    this.pitch = clamp(this.pitch + dp, MIN_PITCH, LOOK_MAX_PITCH);
  }

  // move towards (f < 1) or away from (f > 1) a point; the point stays under the cursor
  zoomAbout(pivot, f) {
    const cam = this.camera.position, off = cam.clone().sub(pivot), d = off.length();
    let nd = Math.max(d * f, MIN_DIST);
    if (f > 1 && pivot.y + (off.y / d) * nd > MAX_ALT) nd = Math.max(d, (MAX_ALT - pivot.y) / Math.max(off.y / d, 1e-3));
    cam.copy(pivot).addScaledVector(off, nd / d);
  }

  // ------------------------------------------------------------ pointer input
  begin() {
    this.flight = null; this.glide = null;
    if (!this.active) { this.active = true; this.dispatchEvent({ type: 'start' }); }
  }
  end() {
    if (this.drag || this.glide || this.keys.size || Math.abs(this.zoom.pending) > 1e-3 || this.flight) return;
    if (this.active) { this.active = false; this.updateTarget(); this.dispatchEvent({ type: 'end' }); }
  }

  onDown(e) {
    if (e.pointerType === 'mouse' && e.button > 2) return;
    this.dom.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.begin();
    this.samples = [];
    if (this.pointers.size === 1) {
      const turn = e.button === 2 || e.button === 1 || e.shiftKey || e.ctrlKey || e.metaKey;
      const mode = turn ? 'orbit' : e.altKey ? 'look' : 'pan';
      const d = { mode, x: e.clientX, y: e.clientY };
      if (mode === 'pan') {
        d.grab = this.hit(e.clientX, e.clientY);
        // on the sky: drag the ground in the middle of the view instead
        if (!d.grab) { d.grab = this.centerHit(); d.offX = e.clientX; d.offY = e.clientY; }
        if (!d.grab) d.mode = 'look';
      }
      if (mode === 'orbit') d.pivot = this.pivotAt(e.clientX, e.clientY);
      this.drag = d;
    } else if (this.pointers.size === 2) {
      this.drag = this.twoFingers();
    }
    this.dom.style.cursor = this.drag?.mode === 'pan' ? 'grabbing' : this.drag?.mode === 'orbit' ? 'move' : '';
  }

  twoFingers() {
    const [a, b] = [...this.pointers.values()];
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    return { mode: 'touch2', mx, my, dist: Math.hypot(a.x - b.x, a.y - b.y), angle: Math.atan2(b.y - a.y, b.x - a.x), pivot: this.pivotAt(mx, my) };
  }

  onMove(e) {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const d = this.drag;
    if (!d) return;
    const now = performance.now();
    if (d.mode === 'touch2' && this.pointers.size >= 2) {
      const n = this.twoFingers();
      if (n.dist > 0 && d.dist > 0) this.zoomAbout(d.pivot, d.dist / n.dist);
      let da = n.angle - d.angle;
      da = Math.atan2(Math.sin(da), Math.cos(da));
      const [a, b] = [...this.pointers.values()];
      const dy = n.my - d.my, together = Math.abs(n.dist - d.dist) < 6 && Math.abs(a.x - b.x) > Math.abs(a.y - b.y);
      this.orbit(-da, together ? -dy * TILT_SPEED : 0, d.pivot);
      Object.assign(d, { mx: n.mx, my: n.my, dist: n.dist, angle: n.angle });
    } else if (d.mode === 'pan') {
      const x = d.offX != null ? this.dom.getBoundingClientRect().left + (this.visualCenter.x * 0.5 + 0.5) * this.dom.clientWidth + (e.clientX - d.offX) : e.clientX;
      const y = d.offY != null ? this.dom.getBoundingClientRect().top + (-this.visualCenter.y * 0.5 + 0.5) * this.dom.clientHeight + (e.clientY - d.offY) : e.clientY;
      const m = this.panTo(x, y, d.grab);
      if (m) this.samples.push({ t: now, x: m.x, z: m.z });
    } else if (d.mode === 'orbit') {
      const dh = (e.clientX - d.x) * ORBIT_SPEED, dp = -(e.clientY - d.y) * TILT_SPEED;
      this.orbit(dh, dp, d.pivot);
      this.samples.push({ t: now, h: dh, p: dp });
    } else if (d.mode === 'look') {
      const dh = -(e.clientX - d.x) * LOOK_SPEED, dp = (e.clientY - d.y) * LOOK_SPEED;
      this.look(dh, dp);
      this.samples.push({ t: now, h: dh, p: dp });
    }
    d.x = e.clientX; d.y = e.clientY;
    this.samples = this.samples.filter((s) => now - s.t < 90);
    this.changed = true;
  }

  onUp(e) {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.delete(e.pointerId);
    const d = this.drag, now = performance.now();
    if (this.pointers.size === 1 && d?.mode === 'touch2') {
      // one finger left: carry on panning from where it is
      const [p] = this.pointers.values();
      this.drag = { mode: 'pan', x: p.x, y: p.y, grab: this.hit(p.x, p.y) };
      if (!this.drag.grab) this.drag = null;
      return;
    }
    if (this.pointers.size) return;
    // let go while moving: glide on
    const recent = this.samples.filter((s) => now - s.t < 90);
    const span = Math.max(now - (recent[0]?.t ?? now), 16) / 1000;
    if (d && recent.length > 1 && now - recent.at(-1).t < 50) {
      const sum = recent.reduce((a, s) => ({ x: a.x + (s.x || 0), z: a.z + (s.z || 0), h: a.h + (s.h || 0), p: a.p + (s.p || 0) }), { x: 0, z: 0, h: 0, p: 0 });
      this.glide = { mode: d.mode, pivot: d.pivot, x: sum.x / span, z: sum.z / span, h: sum.h / span, p: sum.p / span };
    }
    this.drag = null; this.samples = [];
    this.dom.style.cursor = '';
    this.end();
  }

  onWheel(e) {
    e.preventDefault();
    let dy = e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1);
    if (e.ctrlKey) dy *= 4;                                     // trackpad pinch arrives as small ctrl+wheel steps
    const now = performance.now(), z = this.zoom;
    if (!z.pivot || now - z.at > 300 || Math.hypot(e.clientX - z.x, e.clientY - z.y) > 8) {
      z.pivot = this.hit(e.clientX, e.clientY);
      if (!z.pivot) {
        const r = this.setRay(e.clientX, e.clientY);
        z.pivot = r.origin.clone().addScaledVector(r.direction, Math.max(this.camera.position.distanceTo(this.target), 1000));
      }
      z.x = e.clientX; z.y = e.clientY;
    }
    z.at = now;
    this.begin();
    z.pending = clamp(z.pending - dy * 0.0018, -4, 4);
  }

  onDblClick(e) {
    const p = this.hit(e.clientX, e.clientY);
    if (!p) return;
    this.begin();
    Object.assign(this.zoom, { pivot: p, at: performance.now(), x: e.clientX, y: e.clientY });
    this.zoom.pending += e.shiftKey ? -0.9 : 0.9;
  }

  onKey(e, down) {
    if (e.target.closest?.('input, select, textarea, button') || e.metaKey || e.ctrlKey || e.altKey) return;
    let k = KEYS[e.code];
    if (e.key === '+') k = 'in';
    if (e.key === '-') k = 'out';                              // German layouts put + and - on other keys
    if (e.code === 'KeyN' && down) { this.northUp(); return; }
    if (!k) return;
    if (e.shiftKey && ['l', 'r', 'f', 'b'].includes(k)) k = { l: 'tl', r: 'tr', f: 'tu', b: 'td' }[k];
    e.preventDefault();
    if (down) { if (!this.keys.size) { this.begin(); this.keyPivot = null; } this.keys.add(k); }
    else {
      for (const x of [k, ...{ tl: ['l'], tr: ['r'], tu: ['f'], td: ['b'], l: ['tl'], r: ['tr'], f: ['tu'], b: ['td'] }[k] || []]) this.keys.delete(x);
      this.end();
    }
  }

  // ------------------------------------------------------------ programmatic
  flyTo({ pos, tgt }, ms = 1600) {
    this.begin();
    this.flight = { t0: performance.now(), ms, p0: this.camera.position.clone(), q0: this.camera.position.clone().addScaledVector(this.forward(), Math.max(this.camera.position.distanceTo(this.updateTarget()), 100)), p1: pos.clone(), q1: tgt.clone() };
  }
  setView({ pos, tgt }) {
    this.camera.position.copy(pos); this.camera.lookAt(tgt); this.syncFromCamera(); this.target.copy(tgt);
    this.changed = true;
  }
  // place the camera exactly (from a link)
  setPose(x, y, z, heading, pitch) {
    this.flight = null; this.glide = null; this.spin = null;
    this.camera.position.set(x, y, z);
    this.heading = heading; this.pitch = Math.min(Math.max(pitch, MIN_PITCH), LOOK_MAX_PITCH);
    this.apply(); this.changed = true;
  }

  // turn to north around the middle of the view
  northUp() {
    const pivot = this.pivotAt(), turn = Math.atan2(Math.sin(-this.heading), Math.cos(-this.heading));
    this.begin();
    this.glide = null;
    this.spin = { left: turn, pivot };
  }
  zoomStep(sign) {
    this.begin();
    Object.assign(this.zoom, { pivot: this.pivotAt(), at: performance.now(), x: -1e4, y: -1e4 });
    this.zoom.pending += sign * 0.7;
  }
  // between looking straight down and the usual oblique view, around the middle of the view
  toggleTilt() {
    const pivot = this.pivotAt(), want = this.pitch < -75 * D2R ? -35 * D2R : -89 * D2R;
    this.begin();
    this.spin = { left: 0, tilt: want - this.pitch, pivot };
  }

  // ------------------------------------------------------------ per frame
  update(dt) {
    dt = Math.min(dt, 0.1);
    let moved = this.changed; this.changed = false;
    const cam = this.camera.position;

    if (this.flight) {
      const f = this.flight, k = Math.min((performance.now() - f.t0) / f.ms, 1), e = k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2;
      cam.lerpVectors(f.p0, f.p1, e);
      cam.y += Math.sin(k * Math.PI) * Math.min(f.p0.distanceTo(f.p1) * 0.25, 15000);
      this.camera.lookAt(v3().lerpVectors(f.q0, f.q1, e));
      this.syncFromCamera();
      if (k >= 1) { this.flight = null; this.target.copy(f.q1); this.end(); }
      moved = true;
    }

    if (this.glide && !this.drag) {
      const g = this.glide, decay = Math.exp(-dt * 4.5);
      if (g.mode === 'pan') { cam.x += g.x * dt; cam.z += g.z * dt; }
      else if (g.mode === 'orbit') this.orbit(g.h * dt, g.p * dt, g.pivot);
      else if (g.mode === 'look') this.look(g.h * dt, g.p * dt);
      for (const k of ['x', 'z', 'h', 'p']) g[k] *= decay;
      const still = g.mode === 'pan' ? Math.hypot(g.x, g.z) < Math.max(this.agl(), 50) * 0.02 : Math.hypot(g.h, g.p) < 0.01;
      if (still) { this.glide = null; this.end(); }
      moved = true;
    }

    const z = this.zoom;
    if (Math.abs(z.pending) > 1e-3 && z.pivot) {
      const step = z.pending * (1 - Math.exp(-dt * 12));
      z.pending -= step;
      this.zoomAbout(z.pivot, Math.exp(-step));
      if (Math.abs(z.pending) <= 1e-3) { z.pending = 0; this.end(); }
      moved = true;
    }

    if (this.spin) {
      const s = this.spin, k = 1 - Math.exp(-dt * 7);
      const dh = s.left * k, dp = (s.tilt || 0) * k, before = this.pitch;
      this.orbit(dh, dp, s.pivot);
      s.left -= dh; if (s.tilt) s.tilt -= dp;
      if (dp && Math.abs(this.pitch - before) < 1e-6) s.tilt = 0;    // the ground is in the way
      if (Math.abs(s.left) < 1e-3 && Math.abs(s.tilt || 0) < 1e-3) { this.spin = null; this.end(); }
      moved = true;
    }

    if (this.keys.size) {
      const has = (k) => (this.keys.has(k) ? 1 : 0);
      const fwd = has('f') - has('b'), side = has('r') - has('l');
      if (fwd || side) {
        const speed = Math.max(this.agl(), 150) * 1.1 * dt;
        cam.x += (Math.sin(this.heading) * fwd + Math.cos(this.heading) * side) * speed;
        cam.z += (-Math.cos(this.heading) * fwd + Math.sin(this.heading) * side) * speed;
      }
      const turn = has('tr') - has('tl'), tilt = has('tu') - has('td');
      if (turn || tilt) {
        this.keyPivot = this.keyPivot || this.pivotAt();
        this.orbit(turn * 1.1 * dt, tilt * 0.8 * dt, this.keyPivot);
      } else this.keyPivot = null;
      const zin = has('in') - has('out');
      if (zin) { this.zoomAbout(this.keyPivot || (this.keyPivot = this.pivotAt()), Math.exp(-zin * 1.6 * dt)); }
      moved = true;
    }

    // never underground, never into space
    const g = this.terrain.heightAt(cam.x, cam.z);
    if (g !== null && cam.y < g + MIN_AGL) { cam.y = g + MIN_AGL; moved = true; }
    if (cam.y > MAX_ALT) { cam.y = MAX_ALT; moved = true; }
    this.apply();
    return moved;
  }
}
