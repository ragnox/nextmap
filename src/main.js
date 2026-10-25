// nextmap: 3D map of Tyrol on three.js. Terrain from the Land Tirol laser scan, summer/winter imagery, routes.
import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { Frame, lonToX, latToY } from './geo.js';
import { Terrain } from './terrain.js';
import { RouteLayer } from './routes.js';
import { createUI } from './ui.js';
import { Controls } from './controls.js';

const view = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.5;
renderer.autoClear = false;
view.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 5, 600000);

// sky in its own pass, as in the Stummerberg walkthrough
const skyScene = new THREE.Scene(), skyCam = new THREE.PerspectiveCamera(50, 1, 100, 4e6);
const sky = new Sky(); sky.scale.setScalar(1e6); skyScene.add(sky);
sky.material.uniforms.turbidity.value = 3; sky.material.uniforms.rayleigh.value = 1.3;
sky.material.uniforms.mieCoefficient.value = 0.004; sky.material.uniforms.mieDirectionalG.value = 0.8;

const START = { lon: 11.865, lat: 47.17 };
const frame = new Frame(START.lon, START.lat);
const terrain = new Terrain(renderer, scene, frame);
const routes = new RouteLayer();
terrain.routeLayer = routes;

const visualCenter = new THREE.Vector2();
const controls = new Controls(camera, renderer.domElement, terrain, visualCenter);

let dirty = true;
const invalidate = () => { dirty = true; };
terrain.onChange = invalidate;

// ---------------------------------------------------------------- sun
function setSun(t) {
  // t in 0..1: morning in the east to evening in the west, highest at noon in the south
  const az = (90 + t * 180) * Math.PI / 180, el = (12 + 45 * Math.sin(t * Math.PI)) * Math.PI / 180;
  const dir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize();
  terrain.settings.sunDir.copy(dir);
  sky.material.uniforms.sunPosition.value.copy(dir);
  invalidate();
}
setSun(0.45);

// ---------------------------------------------------------------- camera helpers
const ground = (x, z) => terrain.heightAt(x, z) ?? 1000;
function lookAt(lon, lat, { dist = 9000, pitch = 38, heading = 180 } = {}) {
  const [x, z] = frame.fromLonLat(lon, lat);
  const tgt = new THREE.Vector3(x, ground(x, z), z);
  const p = pitch * Math.PI / 180, h = heading * Math.PI / 180;
  // heading is where the camera looks: 180 = south
  const off = new THREE.Vector3(-Math.sin(h) * Math.cos(p), Math.sin(p), Math.cos(h) * Math.cos(p)).multiplyScalar(dist);
  return { pos: tgt.clone().add(off), tgt };
}

function flyTo(view, ms = 1600) { controls.flyTo(view, ms); invalidate(); }
function flyToBounds([w, s, e, n], { heading } = {}) {
  const [x0, z0] = frame.fromLonLat(w, n), [x1, z1] = frame.fromLonLat(e, s);
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, span = Math.max(x1 - x0, z1 - z0, 800);
  const dist = (span * 1.7) / (2 * Math.tan((camera.fov * Math.PI) / 360));
  const [lon, lat] = frame.toLonLat(cx, cz);
  flyTo(lookAt(lon, lat, { dist, pitch: 52, heading: heading ?? controls.heading * 180 / Math.PI }));
}
const ray = new THREE.Raycaster();

function setRegion(region, { fly = true } = {}) {
  const [lon, lat] = region.view;
  const far = Math.hypot((lon - frame.lon0) * 75, (lat - frame.lat0) * 111) > 120;
  if (far) {                                         // move the world origin with the region
    frame.set(lon, lat); terrain.setFrame(frame);
    controls.setView(lookAt(lon, lat, { dist: 14000, pitch: 35, heading: 180 }));
  } else if (fly) flyTo(lookAt(lon, lat, { dist: 14000, pitch: 35, heading: 180 }), 2000);
  invalidate();
}

// ---------------------------------------------------------------- picking
const toMerc = (p) => { const [lon, lat] = frame.toLonLat(p.x, p.z); return { lon, lat, mx: lonToX(lon), my: latToY(lat) }; };
function pickAt(clientX, clientY) {
  const r = renderer.domElement.getBoundingClientRect();
  ray.setFromCamera(new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1), camera);
  const hit = terrain.raycast(ray.ray);
  if (!hit) return null;
  const m = toMerc(hit), dist = hit.distanceTo(camera.position);
  const mPerPx = (dist * 2 * Math.tan((camera.fov * Math.PI) / 360)) / r.height;
  return { hit, ...m, mPerPx, route: routes.visible ? routes.pick(m.mx, m.my, (mPerPx * 9) / frame.k) : null };
}

// ---------------------------------------------------------------- loop
// centre the view in the part of the window the side panel leaves free (beside it, or above it on phones)
function resize() {
  const W = window.innerWidth, H = window.innerHeight, side = document.getElementById('side').getBoundingClientRect();
  const left = W > 760 ? side.right : 0, bottom = W > 760 ? 0 : H - side.top;
  for (const c of [camera, skyCam]) {
    c.aspect = (W + left) / (H + bottom);
    if (left || bottom) c.setViewOffset(W + left, H + bottom, 0, bottom, W, H); else c.clearViewOffset();
    c.updateProjectionMatrix();
  }
  visualCenter.set(left / W, bottom / H);
  renderer.setSize(W, H); invalidate();
}
window.addEventListener('resize', resize);

const ui = createUI({ terrain, routes, camera, controls, frame, flyTo, flyToBounds, lookAt, setRegion, setSun, pickAt, invalidate, renderer });

let last = performance.now();
function tick(now) {
  requestAnimationFrame(tick);
  const moved = controls.update((now - last) / 1000);
  last = now;
  const g = terrain.heightAt(camera.position.x, camera.position.z);
  if (!dirty && !moved && !terrain.busy() && !ui.busy()) return;
  dirty = false;
  const agl = camera.position.y - (g ?? 0);
  camera.near = Math.min(Math.max(agl * 0.15, 2), 400); camera.far = 600000; camera.updateProjectionMatrix();
  terrain.update(camera);
  skyCam.quaternion.copy(camera.quaternion);
  renderer.clear();
  renderer.render(skyScene, skyCam);
  renderer.clearDepth();
  renderer.render(scene, camera);
  ui.frame();
}

resize();
controls.setView(lookAt(START.lon, START.lat, { dist: 16000, pitch: 32, heading: 180 }));
// settle the start view on the real ground once the first tiles are in
let settled = false;
terrain.onChange = () => {
  invalidate();
  if (!settled && terrain.heightAt(controls.target.x, controls.target.z) !== null) {
    settled = true;
    controls.setView(lookAt(START.lon, START.lat, { dist: 16000, pitch: 32, heading: 180 }));
  }
};
requestAnimationFrame(tick);
window.nextmap = { terrain, routes, camera, controls, frame, flyTo, lookAt, ui };
