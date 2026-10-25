// Streaming terrain: a quadtree of Web Mercator tiles. Each frame the tree is walked from the root tiles, split where
// a tile would cover more than SPLIT_PX on screen, and every leaf is drawn with the data of its nearest loaded
// ancestor (through uv transforms), so the view is never empty while finer tiles load.
import * as THREE from 'three';
import { terrainVertex, terrainFragment } from './shaders.js';
import { EARTH_R } from './geo.js';

const N = 256, S = N + 3, SEG = 64;
const ROOT_Z = 8, MAX_Z = 17, S2_MAX_Z = 14, TIRIS_MIN_Z = 12, ROUTES_MIN_Z = 9;
const MAX_LOADS = 8, MAX_TILES = 260, ROUTE_DRAWS_PER_FRAME = 8;

// ---------------------------------------------------------------- shared grid with skirts
function gridGeometry() {
  const pos = [], idx = [], g = (i, j) => j * (SEG + 1) + i;
  for (let j = 0; j <= SEG; j++) for (let i = 0; i <= SEG; i++) pos.push(i / SEG, j / SEG, 0);
  for (let j = 0; j < SEG; j++) for (let i = 0; i < SEG; i++) idx.push(g(i, j), g(i, j + 1), g(i + 1, j), g(i + 1, j), g(i, j + 1), g(i + 1, j + 1));
  const skirt = (pts) => {
    const base = pos.length / 3;
    pts.forEach(([i, j]) => pos.push(i / SEG, j / SEG, 1));
    for (let k = 0; k < pts.length - 1; k++) {
      const a = g(...pts[k]), b = g(...pts[k + 1]), c = base + k, d = base + k + 1;
      idx.push(a, c, b, b, c, d);
    }
  };
  const r = [...Array(SEG + 1).keys()];
  skirt(r.map((i) => [i, 0])); skirt(r.map((i) => [i, SEG])); skirt(r.map((j) => [0, j])); skirt(r.map((j) => [SEG, j]));
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  return geo;
}

const blank = (() => {
  const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1); t.needsUpdate = true; return t;
})();
const gray = (() => {
  const t = new THREE.DataTexture(new Uint8Array([128, 128, 120, 255]), 1, 1); t.colorSpace = THREE.SRGBColorSpace; t.needsUpdate = true; return t;
})();


class Tile {
  constructor(tm, z, x, y, parent) {
    this.z = z; this.x = x; this.y = y; this.parent = parent; this.children = null;
    [this.wx, this.wz, this.size] = tm.frame.tileRect(z, x, y);
    this.state = 0;                         // 0 not loaded, 1 loading, 2 ready, 3 failed
    this.minH = parent ? parent.minH : -100; this.maxH = parent ? parent.maxH : 4500;
    this.used = 0;
    this.s2 = {};                           // season -> { state, tex }
    this.tiris = null;                      // { key, state, tex }
    this.routes = null;                     // { version, tex, canvas }
  }
  get key() { return `${this.z}/${this.x}/${this.y}`; }
  readyAncestor() { let t = this; while (t && t.state !== 2) t = t.parent; return t; }
  ancestorAt(z) { let t = this; while (t && t.z > z) t = t.parent; return t; }
  dispose() {
    for (const k of ['demTex', 'normTex', 'imgTex']) { this[k]?.dispose(); this[k] = null; }
    for (const s of Object.values(this.s2)) s.tex?.dispose();
    this.s2 = {};
    this.tiris?.tex?.dispose(); this.tiris = null;
    this.routes?.tex?.dispose(); this.routes = null;
    this.dem = null; this.state = 0;
  }
}

// uv transform from a node to one of its ancestors' textures
function xfTo(node, src, v) {
  const d = node.z - src.z, s = 1 / 2 ** d;
  return v.set((node.x - src.x * 2 ** d) * s, (node.y - src.y * 2 ** d) * s, s, s);
}

export class Terrain {
  constructor(renderer, scene, frame, backend) {
    this.renderer = renderer; this.scene = scene; this.frame = frame; this.backend = backend;
    this.geo = gridGeometry();
    this.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    this.pool = []; this.frameNo = 0; this.loading = 0; this.tileCount = 0;
    this.splitPx = 420;
    this.settings = {
      season: 'summer', imagery: 'ortho', satellite: false, slope: 0, contours: 0, contourStep: 20,
      tiris: [], relief: 0.55, hazeColor: new THREE.Color(0xc5d3e0), hazeDensity: 1 / 200000, sunDir: new THREE.Vector3(0.3, 0.8, 0.5).normalize(),
    };
    this.s2Scenes = {};                     // season -> scene id
    this.routeLayer = null;
    this.onChange = null;
    this.buildRoots();
  }

  buildRoots() {
    for (const t of this.roots || []) this.disposeTree(t);
    const [cx, cy] = this.frame.tileAt(ROOT_Z, 0, 0);
    this.roots = [];
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) this.roots.push(new Tile(this, ROOT_Z, cx + dx, cy + dy, null));
  }
  disposeTree(t) { t.dispose(); t.children?.forEach((c) => this.disposeTree(c)); }
  setFrame(frame) { this.frame = frame; this.buildRoots(); }

  // ------------------------------------------------------------ settings
  set(patch) {
    const s = this.settings, before = { imagery: s.imagery };
    Object.assign(s, patch);
    if (patch.imagery && patch.imagery !== before.imagery) this.forEachTile((t) => { if (t.state === 2) { t.imgTex?.dispose(); t.imgTex = null; t.imgPending = false; } });
  }
  setS2Scene(season, sceneId) {
    if (this.s2Scenes[season] === sceneId) return;
    this.s2Scenes[season] = sceneId;
    this.forEachTile((t) => { t.s2[season]?.tex?.dispose(); delete t.s2[season]; });
  }
  forEachTile(fn) {
    const walk = (t) => { fn(t); t.children?.forEach(walk); };
    this.roots.forEach(walk);
  }

  // ------------------------------------------------------------ per frame
  update(camera) {
    this.frameNo++;
    camera.updateMatrixWorld();
    const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const K = this.renderer.domElement.clientHeight / (2 * Math.tan((camera.fov * Math.PI) / 360));
    const cam = camera.position, box = new THREE.Box3();
    const draw = [], wanted = new Map(), s2Wanted = new Map(), tirisWanted = new Map();
    const season = this.settings.season;
    const needS2 = (season === 'winter' || this.settings.satellite) && this.s2Scenes[season];
    const tirisKey = this.settings.tiris.join(',');

    const want = (map, t, d) => { if (!map.has(t)) map.set(t, d); };
    const visit = (t) => {
      t.used = this.frameNo;
      const src = t.readyAncestor();
      const lo = src ? src.minH : t.minH, hi = src ? src.maxH : t.maxH;
      // farthest corner drops below the camera's horizon by d^2 / 2R
      const fx = Math.max(Math.abs(t.wx - cam.x), Math.abs(t.wx + t.size - cam.x)), fz = Math.max(Math.abs(t.wz - cam.z), Math.abs(t.wz + t.size - cam.z));
      const drop = (fx * fx + fz * fz) / (2 * EARTH_R);
      box.min.set(t.wx, lo - drop - t.size * 0.02 - 50, t.wz); box.max.set(t.wx + t.size, hi + 10, t.wz + t.size);
      if (!frustum.intersectsBox(box)) return;
      const dist = Math.max(box.distanceToPoint(cam), 1);
      if (t.z < MAX_Z && (t.size * K) / dist > this.splitPx) {
        if (!t.children) t.children = [0, 1, 2, 3].map((i) => new Tile(this, t.z + 1, t.x * 2 + (i & 1), t.y * 2 + (i >> 1), t));
        if (!src && t.state === 0) want(wanted, t, dist);   // something has to be drawn first
        t.children.forEach(visit);
        return;
      }
      // load this tile, or an ancestor a few levels below the data we have, so detail arrives coarse to fine
      if (t.state === 0) {
        let target = t;
        const base = src ? src.z : ROOT_Z - 1;
        while (target.z > base + 4) target = target.parent;
        want(wanted, target, dist);
      }
      if (!src) return;
      draw.push({ node: t, src, dist });
      if (needS2) {
        const s2t = t.ancestorAt(S2_MAX_Z);
        if (!s2t.s2[season]) want(s2Wanted, s2t, dist);
      }
      if (tirisKey && t.z >= TIRIS_MIN_Z && (!t.tiris || t.tiris.key !== tirisKey)) want(tirisWanted, t, dist);
    };
    this.roots.forEach(visit);

    this.schedule('tile', wanted, (t) => this.loadTile(t));
    if (needS2) this.schedule('s2', s2Wanted, (t) => this.loadS2(t, season, this.s2Scenes[season]), 6);
    if (tirisKey) this.schedule('tiris', tirisWanted, (t) => this.loadTiris(t, tirisKey), 4);
    this.render(draw, needS2, tirisKey, cam);
    if (this.frameNo % 60 === 0) this.evict();
  }

  // start the most urgent loads (coarse levels first, then nearest) within a budget per kind of load
  schedule(key, map, start, max = MAX_LOADS) {
    const list = [...map.entries()].sort((a, b) => a[0].z - b[0].z || a[1] - b[1]);
    this.active = this.active || {};
    for (const [t] of list) {
      if ((this.active[key] || 0) >= max) break;
      this.active[key] = (this.active[key] || 0) + 1;
      start(t).finally(() => { this.active[key]--; this.onChange?.(); });
    }
  }

  // ------------------------------------------------------------ loading
  async loadTile(t) {
    t.state = 1; this.loading++;
    try {
      const [buf] = await Promise.all([
        this.backend.demTile(t.z, t.x, t.y),
        this.loadImagery(t),
      ]);
      const dem = new Float32Array(buf);
      let lo = Infinity, hi = -Infinity;
      for (let j = 1; j <= N + 1; j++) for (let i = 1; i <= N + 1; i++) { const h = dem[j * S + i]; if (h < lo) lo = h; if (h > hi) hi = h; }
      t.dem = dem; t.minH = lo; t.maxH = hi;
      t.demTex = new THREE.DataTexture(dem, S, S, THREE.RedFormat, THREE.FloatType);
      t.demTex.minFilter = t.demTex.magFilter = THREE.NearestFilter; t.demTex.needsUpdate = true;
      t.normTex = this.normals(dem, t.size / N);
      t.state = 2; this.tileCount++;
    } catch (e) {
      console.warn('tile', t.key, e.message);
      t.state = 3; setTimeout(() => { if (t.state === 3) t.state = 0; }, 8000);
    } finally { this.loading--; }
  }

  normals(dem, cell) {
    const W = N + 1, out = new Uint8Array(W * W * 4);
    for (let j = 0; j < W; j++) for (let i = 0; i < W; i++) {
      const c = (j + 1) * S + (i + 1);
      const dx = (dem[c + 1] - dem[c - 1]) / (2 * cell), dz = (dem[c + S] - dem[c - S]) / (2 * cell);
      const l = Math.hypot(dx, 1, dz), o = (j * W + i) * 4;
      out[o] = Math.round((-dx / l * 0.5 + 0.5) * 255); out[o + 1] = Math.round((-dz / l * 0.5 + 0.5) * 255); out[o + 3] = 255;
    }
    const tex = new THREE.DataTexture(out, W, W);
    tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter; tex.generateMipmaps = true; tex.needsUpdate = true;
    return tex;
  }

  imageryLayer() { return this.settings.imagery === 'tiris' ? 'tiris' : 'ortho'; }

  // orthophoto: four tiles one level down on a 512 px canvas (one tile for the coarse levels)
  async loadImagery(t) {
    const layer = this.imageryLayer();
    let canvas;
    if (t.z < 11) {
      const b = await this.backend.imagery(layer, t.z, t.x, t.y).catch(() => null);
      canvas = b;
    } else {
      canvas = document.createElement('canvas'); canvas.width = canvas.height = 512;
      const ctx = canvas.getContext('2d');
      await Promise.all([0, 1, 2, 3].map(async (i) => {
        const b = await this.backend.imagery(layer, t.z + 1, t.x * 2 + (i & 1), t.y * 2 + (i >> 1)).catch(() => null);
        if (b) { ctx.drawImage(b, (i & 1) * 256, (i >> 1) * 256); b.close(); }
      }));
    }
    if (layer !== this.imageryLayer()) return;
    t.imgTex?.dispose();
    t.imgTex = canvas ? this.texture(canvas) : null;
    t.imgLayer = layer;
  }

  texture(img, srgb = true) {
    const tex = img instanceof HTMLCanvasElement ? new THREE.CanvasTexture(img) : new THREE.Texture(img);
    tex.flipY = false; tex.premultiplyAlpha = false;
    if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = this.anisotropy; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.generateMipmaps = true;
    tex.needsUpdate = true;
    return tex;
  }

  // raw RGBA (Sentinel-2 composed in the browser): alpha carries the snow fraction, so no canvas in between
  rgbaTexture(rgba) {
    const tex = new THREE.DataTexture(rgba, 256, 256, THREE.RGBAFormat);
    tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = this.anisotropy;
    tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter; tex.generateMipmaps = true;
    tex.needsUpdate = true;
    return tex;
  }

  async loadS2(t, season, sid) {
    t.s2[season] = { state: 1 };
    try {
      const s = await this.backend.s2Tile(sid, t.z, t.x, t.y);
      if (this.s2Scenes[season] !== sid) return;
      t.s2[season] = { state: 2, tex: !s ? null : s.bitmap ? this.texture(s.bitmap) : this.rgbaTexture(s.rgba) };
    } catch (e) {
      t.s2[season] = { state: 3 };
      setTimeout(() => { if (t.s2[season]?.state === 3) delete t.s2[season]; }, 10000);
    }
  }

  async loadTiris(t, key) {
    t.tiris = { key, state: 1 };
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 512;
    const ctx = canvas.getContext('2d');
    await Promise.all([0, 1, 2, 3].map(async (i) => {
      const b = await this.backend.imagery('over', t.z + 1, t.x * 2 + (i & 1), t.y * 2 + (i >> 1), key).catch(() => null);
      if (b) { ctx.drawImage(b, (i & 1) * 256, (i >> 1) * 256); b.close(); }
    }));
    if (t.tiris?.key !== key) return;
    t.tiris = { key, state: 2, tex: this.texture(canvas) };
  }

  // ------------------------------------------------------------ drawing
  material() {
    const u = {
      uNode: { value: new THREE.Vector4() }, uEarthR: { value: EARTH_R },
      uDem: { value: null }, uDemXf: { value: new THREE.Vector4() },
      uNormal: { value: null }, uNormalXf: { value: new THREE.Vector4() },
      uImg: { value: gray }, uImgXf: { value: new THREE.Vector4() },
      uS2: { value: blank }, uS2Xf: { value: new THREE.Vector4() }, uHasS2: { value: 0 },
      uTiris: { value: blank }, uTirisXf: { value: new THREE.Vector4() }, uHasTiris: { value: 0 },
      uRoutes: { value: blank }, uRoutesXf: { value: new THREE.Vector4() }, uHasRoutes: { value: 0 },
      uSeason: { value: 0 }, uImagery: { value: 0 }, uSlope: { value: 0 }, uContours: { value: 0 }, uContourStep: { value: 20 },
      uSunDir: { value: new THREE.Vector3() }, uRelief: { value: 0.5 }, uHazeColor: { value: new THREE.Color() }, uHazeDensity: { value: 0 },
      uTileTint: { value: 0 },
    };
    return new THREE.ShaderMaterial({ uniforms: u, vertexShader: terrainVertex, fragmentShader: terrainFragment, side: THREE.DoubleSide, toneMapped: false });
  }

  render(draw, needS2, tirisKey, cam) {
    draw.sort((a, b) => a.dist - b.dist);
    const st = this.settings, season = st.season;
    let routeBudget = ROUTE_DRAWS_PER_FRAME;
    this.pendingRoutes = false;
    while (this.pool.length < draw.length) {
      const m = new THREE.Mesh(this.geo, this.material());
      m.frustumCulled = false; this.scene.add(m); this.pool.push(m);
    }
    this.drawn = draw.length;
    this.pool.forEach((m, i) => {
      const item = draw[i];
      m.visible = !!item;
      if (!item) return;
      const { node: t, src } = item, u = m.material.uniforms;
      m.renderOrder = i;
      u.uNode.value.set(t.wx, t.wz, t.size, Math.max(t.size * 0.015, 5));
      u.uDem.value = src.demTex; xfTo(t, src, u.uDemXf.value);
      u.uNormal.value = src.normTex; u.uNormalXf.value.copy(u.uDemXf.value);
      // imagery may lag behind the DEM after switching sources
      let img = src; while (img && !img.imgTex) img = img.parent?.readyAncestor();
      u.uImg.value = img ? img.imgTex : gray; if (img) xfTo(t, img, u.uImgXf.value);
      u.uHasS2.value = 0;
      if (needS2) {
        let s = t.ancestorAt(S2_MAX_Z);
        while (s && !(s.s2[season]?.state === 2 && s.s2[season].tex)) s = s.parent;
        if (s) { u.uS2.value = s.s2[season].tex; xfTo(t, s, u.uS2Xf.value); u.uHasS2.value = 1; }
      }
      u.uHasTiris.value = 0;
      if (tirisKey && t.z >= TIRIS_MIN_Z - 1) {
        let s = t;
        while (s && !(s.tiris?.key === tirisKey && s.tiris.state === 2)) s = s.parent;
        if (s && s.z >= TIRIS_MIN_Z) { u.uTiris.value = s.tiris.tex; xfTo(t, s, u.uTirisXf.value); u.uHasTiris.value = 1; }
      }
      u.uHasRoutes.value = 0;
      if (this.routeLayer?.visible && t.z >= ROUTES_MIN_Z) {
        if (!t.routes || t.routes.version !== this.routeLayer.version) {
          if (routeBudget > 0) { routeBudget--; this.drawRoutes(t); } else this.pendingRoutes = true;
        }
        let s = t;
        while (s && !(s.routes && s.routes.version === this.routeLayer.version)) s = s.parent;
        if (s && s.routes.tex) { u.uRoutes.value = s.routes.tex; xfTo(t, s, u.uRoutesXf.value); u.uHasRoutes.value = 1; }
      }
      u.uSeason.value = season === 'winter' ? 1 : 0;
      u.uImagery.value = st.satellite ? 1 : 0;
      u.uSlope.value = st.slope; u.uContours.value = st.contours; u.uContourStep.value = st.contourStep;
      u.uSunDir.value.copy(st.sunDir); u.uRelief.value = st.relief;
      u.uHazeColor.value.copy(st.hazeColor); u.uHazeDensity.value = st.hazeDensity;
    });
  }

  drawRoutes(t) {
    if (!t.routes) {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 512;
      t.routes = { canvas, tex: null, version: -1 };
    }
    const ctx = t.routes.canvas.getContext('2d');
    ctx.clearRect(0, 0, 512, 512);
    const any = this.routeLayer.draw(ctx, t.z, t.x, t.y, 512);
    t.routes.version = this.routeLayer.version;
    if (!any) { t.routes.tex?.dispose(); t.routes.tex = null; return; }
    if (!t.routes.tex) t.routes.tex = this.texture(t.routes.canvas);
    else t.routes.tex.needsUpdate = true;
  }

  evict() {
    const loaded = [];
    this.forEachTile((t) => { if (t.state === 2 || t.routes || Object.keys(t.s2).length || t.tiris) loaded.push(t); });
    if (loaded.length <= MAX_TILES) return;
    loaded.sort((a, b) => a.used - b.used || b.z - a.z);
    for (const t of loaded.slice(0, loaded.length - MAX_TILES)) {
      if (t.used >= this.frameNo - 2 || t.z <= ROOT_Z) continue;
      if (t.state === 2) this.tileCount--;
      t.dispose();
    }
  }

  // work left for the next frames even if nothing moves
  busy() { return this.pendingRoutes || this.loading > 0; }

  // ------------------------------------------------------------ queries
  deepestReady(wx, wz) {
    const root = this.roots.find((r) => wx >= r.wx && wx < r.wx + r.size && wz >= r.wz && wz < r.wz + r.size);
    let t = root, best = root && root.state === 2 ? root : null;
    while (t && t.children) {
      const i = (wx >= t.wx + t.size / 2 ? 1 : 0) + (wz >= t.wz + t.size / 2 ? 2 : 0);
      t = t.children[i];
      if (t.state === 2) best = t;
    }
    return best;
  }
  heightAt(wx, wz) {
    const t = this.deepestReady(wx, wz);
    if (!t) return null;
    const gx = ((wx - t.wx) / t.size) * N + 1, gz = ((wz - t.wz) / t.size) * N + 1;
    const i = Math.min(Math.max(Math.floor(gx), 0), S - 2), j = Math.min(Math.max(Math.floor(gz), 0), S - 2), fx = gx - i, fz = gz - j;
    const d = t.dem;
    return (d[j * S + i] * (1 - fx) + d[j * S + i + 1] * fx) * (1 - fz) + (d[(j + 1) * S + i] * (1 - fx) + d[(j + 1) * S + i + 1] * fx) * fz;
  }
  // terrain as drawn, i.e. lowered by the earth's curvature as seen from `from`
  surfaceAt(wx, wz, from) {
    const h = this.heightAt(wx, wz);
    if (h === null) return null;
    const dx = wx - from.x, dz = wz - from.z;
    return h - (dx * dx + dz * dz) / (2 * EARTH_R);
  }
  slopeAt(wx, wz) {
    const e = 4, h = (x, z) => this.heightAt(x, z) ?? 0;
    const dx = (h(wx + e, wz) - h(wx - e, wz)) / (2 * e), dz = (h(wx, wz + e) - h(wx, wz - e)) / (2 * e);
    return { slope: Math.atan(Math.hypot(dx, dz)) * 180 / Math.PI, aspect: (Math.atan2(-dx, dz) * 180 / Math.PI + 360) % 360 };
  }
  // march a ray against the terrain; returns the world point or null
  raycast(ray, maxDist = 400000) {
    const o = ray.origin, d = ray.direction, p = new THREE.Vector3();
    let t = 0, prev = 0;
    const above = (tt) => {
      p.copy(d).multiplyScalar(tt).add(o);
      const s = this.surfaceAt(p.x, p.z, o);
      return s === null ? true : p.y > s;
    };
    if (!above(0)) return null;
    while (t < maxDist) {
      const agl = p.y - (this.surfaceAt(p.x, p.z, o) ?? -1e4);
      prev = t; t += Math.max(2, Math.min(agl * 0.5, 2000), t * 0.004);
      if (!above(t)) {
        let a = prev, b = t;
        for (let k = 0; k < 24; k++) { const m = (a + b) / 2; if (above(m)) a = m; else b = m; }
        p.copy(d).multiplyScalar(b).add(o);
        p.y = this.heightAt(p.x, p.z) ?? p.y;
        return p.clone();
      }
    }
    return null;
  }
}
