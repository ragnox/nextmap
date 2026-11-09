// Planning a route on the map. A click adds a waypoint; a leg follows roads and paths to it (the route worker finds
// the way on nextmap's path network, shared/router.js) or runs freehand: a straight line over the ground, or a line
// drawn with the pen. Drag a waypoint to move it (the way follows as you drag), drag the line (or click it) to put a
// waypoint in, click a waypoint to take it out; ⌘Z undoes. Length, climb, time and the elevation profile follow every
// change, steep stretches are coloured on the map and in the profile, and the stretches to push or carry the bike,
// or harder than the grade, are marked; a bike can be left where riding ends (Bike & Hike). Plans are kept in this
// browser (My routes), in the link and as GPX.
import * as THREE from 'three';
import { PlanLayer } from './planlayer.js';
import { drawProfile, profileIndex } from './profile.js';
import { gpxText, gpxPoints, gpxName, fileName, saveFile } from './gpx.js';
import { km, hm, statsHtml, esc } from './format.js';
import { haversine, lineLength, simplify, densify } from '../shared/geo.js';
import {
  emptyPlan, addPoint, movePoint, insertPoint, removePoint, reverse, backToStart, outAndBack, planLine, legLine,
  nearestLeg, planFromLine, encodePlan, decodePlan, steepColors, GRADE_CLASSES, SLOPE_CLASSES, ACTIVITIES, GRADES, RIDE,
  splitAt, parkAt, walkedLegs, legProfile, routeKey, routeKeyOf, needsRoute, setRoute, planMarks, planTime,
} from '../shared/plan.js';

const $ = (id) => document.getElementById(id);
const STORE = 'nextmap-plans';
export const ACTIVITY_LABEL = { hike: 'Hike', mtb: 'Mountain bike ride', emtb: 'eMTB ride', skitour: 'Ski tour' };
const NAMED_AFTER = new Set(['city', 'town', 'village', 'hamlet', 'hut', 'lake']);
const GRAB_PX = 8;                                      // how close to the line a press grabs it
const FOLLOW = 'nextmap-follow';
// the grades by name, and what a marked stretch means
const GRADE_NAMES = {
  T: ['', 'T1 · hiking trail', 'T2 · mountain hiking', 'T3 · demanding mountain hiking', 'T4 · alpine hiking', 'T5 · demanding alpine hiking', 'T6 · difficult alpine hiking'],
  S: ['S0 · smooth, no obstacles', 'S1 · roots and gravel', 'S2 · rocks and steps', 'S3 · steep, big rocks', 'S4 · very steep, hairpins', 'S5 · blocks, extreme'],
};
const MARK_LABEL = {
  push: (g) => `Push the bike: harder than ${g}`, steep: () => 'Push the bike: too steep to ride up', against: () => 'Push the bike: against a one-way street',
  carry: () => 'Carry the bike: steps or alpine path', hard: (g) => `Harder than ${g}`, closed: () => 'Closed to walkers',
};
const BIKE_MARK = new Set(['push', 'steep', 'against', 'carry']);
const FAILED = {
  outside: 'Outside Tyrol and the area around it there is no path network yet, so a leg runs straight.',
  from: 'No road or path within 150 m of a point, so a leg runs straight. Freehand draws it your way.',
  to: 'No road or path within 150 m of a point, so a leg runs straight. Freehand draws it your way.',
  none: 'No road or path joins two of the points, so a leg runs straight.',
  far: 'A leg over 60 km is not searched: add a point in between.',
  nonet: 'The path network is not available here, so legs run straight.',
  failed: 'Finding the way failed (no connection?), so a leg runs straight. Move a point to try again.',
};
const pt = (p) => `${p[0]},${p[1]}`;
const dist = (m) => (m < 950 ? `${Math.round(m / 10) * 10} m` : km(m));

// My routes: the plans kept in this browser
export function savedPlans() { try { return JSON.parse(localStorage.getItem(STORE)) || []; } catch { return []; } }
function keep(list) { try { localStorage.setItem(STORE, JSON.stringify(list)); return true; } catch { return false; } }

// hooks: onOpen() and onClose() swap the panels, link() is the address of the current view, syncUrl(push) writes it,
// fit(bbox) shows an area, setMarker([lon, lat], ele) marks a point (null hides it), savedChanged() after My routes
// changed, summary() after the figures changed
export function createPlanner(app, hooks) {
  const { terrain, camera, frame, invalidate, backend, renderer } = app;
  const layer = new PlanLayer();
  terrain.planLayer = layer;
  const canvas = renderer.domElement, view = $('view'), sketchCanvas = $('plan-draw'), dctx = sketchCanvas.getContext('2d');
  let plan = null, saved = null, undo = [], redo = [], profile = null, fresh = false, pen = false, gesture = null, hoverAt = null, lastAdd = null;
  let season = null, autoName = '', autoFor = null;
  let follow = true, busy = false;
  const snaps = new Map(), routes = new Map();            // waypoints on the network, and legs routed (or in work)

  // your own route is white, so it stands out from the routes of the atlas; steep stretches are coloured on top
  const color = () => '#f6f5f0';
  const nameOf = () => plan?.name?.trim() || autoName || 'My route';
  const note = (t) => { $('p-note').textContent = t; };

  // ------------------------------------------------------------ opening, editing, undo
  function open(p, { id = null, fit = false } = {}) {
    if (plan) flushSave();
    plan = p; saved = id; undo = []; redo = []; profile = null; fresh = false; gesture = null; autoFor = null;
    follow = followFor(p.activity);
    hooks.onOpen();
    hooks.count?.('planner', 'open');
    $('plan').hidden = false;
    $('p-name').value = plan.name || '';
    note('');
    setPen(false);
    show();
    if (fit && plan.points.length > 1) hooks.fit(bounds(planLine(plan)));
    hooks.syncUrl(true);
  }
  function openSaved(id) {
    const e = savedPlans().find((x) => x.id === id);
    if (!e) return;
    try { open(decodePlan(e.code, e.name), { id, fit: true }); } catch { hooks.status?.(`“${e.name}” could not be read.`); }
  }
  function close({ url = true } = {}) {
    if (!plan) return;
    flushSave();
    plan = null; gesture = null; profile = null; hoverAt = null;
    layer.set([], ''); terrain.dropOverlay('plan');
    syncHandles(); paint();
    $('plan').hidden = true;
    hooks.setMarker(null);
    hooks.onClose();
    if (url) hooks.syncUrl(true);
    invalidate();
  }

  function commit(next) {
    undo.push(plan);
    if (undo.length > 300) undo.shift();
    redo = [];
    plan = { ...next, name: plan.name };
    changed();
  }
  function step(from, to) {
    if (!from.length) return;
    to.push(plan);
    plan = { ...from.pop(), name: plan.name };
    changed();
  }
  const undoStep = () => step(undo, redo), redoStep = () => step(redo, undo);
  function changed() { show(); autosave(); hooks.syncUrl(); }
  // the plan finished by the route worker: not a step of its own to undo
  function amend(next) { plan = { ...next, name: plan.name }; changed(); }

  // the plan on the map and in the panel; the profile follows, and the legs that follow paths are routed
  function show() {
    layer.set([planLine(plan)], color(), null, markLines());
    invalidate();
    syncHandles(); renderPanel(); queueProfile(); nameAfterStart();
    settle();
  }

  // ------------------------------------------------------------ following roads and paths
  // whether new legs follow paths, as last chosen for the activity (ski tours go freehand unless told otherwise)
  function followFor(activity) {
    try { const v = JSON.parse(localStorage.getItem(FOLLOW))?.[activity]; if (typeof v === 'boolean') return v; } catch { /* not kept */ }
    return activity !== 'skitour';
  }
  function setFollow(on) {
    follow = on;
    try { const all = JSON.parse(localStorage.getItem(FOLLOW)) || {}; all[plan.activity] = on; localStorage.setItem(FOLLOW, JSON.stringify(all)); } catch { /* not kept */ }
    show();
  }
  const mode = () => (follow ? 'path' : 'free');
  const cap = (m) => { while (m.size > 600) m.delete(m.keys().next().value); };
  // a waypoint at a leg that follows paths (or the first one, when the next leg will) goes onto the network
  const onPath = (P, i) => P.legs[i - 1]?.mode === 'path' || P.legs[i]?.mode === 'path' || (P.points.length === 1 && follow);

  // brings the plan up to date with the network, one step at a time: waypoints snapped, then legs routed. Answers
  // come back from the worker and call this again; nothing waits for them.
  function settle() {
    if (!plan || gesture?.moved) return;
    const P = plan;
    let next = P, pending = 0;
    P.points.forEach((p, i) => {
      if (!onPath(P, i)) return;
      const s = snaps.get(pt(p));
      if (s === undefined) {
        snaps.set(pt(p), backend.snap(p).then((r) => { snaps.set(pt(p), r || false); if (r) snaps.set(pt(r), r); settle(); },
          () => { snaps.set(pt(p), false); settle(); }));
        cap(snaps);
      }
      if (s === undefined || s instanceof Promise) pending++;
      else if (s && pt(s) !== pt(p)) next = movePoint(next, i, s);
    });
    if (next !== P) { amend(next); return; }
    P.legs.forEach((l, i) => {
      if (!needsRoute(P, i)) return;
      const sa = snaps.get(pt(P.points[i])), sb = snaps.get(pt(P.points[i + 1]));
      if (sa === undefined || sb === undefined || sa instanceof Promise || sb instanceof Promise) { pending++; return; }
      const key = routeKey(P, i), r = routes.get(key);
      if (r === undefined) {
        routes.set(key, backend.route(P.points[i], P.points[i + 1], legProfile(P, i))
          .then((x) => { routes.set(key, x); settle(); }, () => { routes.set(key, { error: 'failed' }); settle(); }));
        cap(routes);
      }
      if (r === undefined || r instanceof Promise) pending++;
      else next = setRoute(next, i, r);
    });
    if (next !== P) { amend(next); return; }
    if (busy !== pending > 0) { busy = pending > 0; renderPanel(); }
  }

  // while a point is dragged, the legs it pulls are routed to where it is now (one search at a time); the answers
  // also stand ready for when it is let go
  function preview(g) {
    const T = g.temp, k = g.kind === 'move' ? g.i : g.leg + 1;
    const legs = [k - 1, k].filter((j) => T.legs[j]?.mode === 'path');
    if (!legs.length) return;
    if (g.busy) { g.again = true; return; }
    g.busy = true;
    Promise.all(legs.map((j) => backend.route(T.points[j], T.points[j + 1], legProfile(T, j)).then((r) => [j, r], () => [j, { error: 'failed' }]))).then((rs) => {
      g.busy = false;
      if (gesture !== g) return;
      g.preview = Object.fromEntries(rs);
      for (const [j, r] of rs) {
        if (r.error) continue;
        const raw = T.points[k], at = j === k - 1 ? r.to : r.from;
        snaps.set(pt(raw), at); snaps.set(pt(at), at);
        routes.set(routeKeyOf(legProfile(T, j), r.from, r.to), r);
      }
      cap(snaps); cap(routes);
      paint();
      if (g.again) { g.again = false; preview(gesture); }
    });
  }

  // the marked stretches: where along the route ([from, to] metres), what, and the first point
  function stretches() {
    const line = planLine(plan), at = [0];
    for (let i = 1; i < line.length; i++) at.push(at[i - 1] + haversine(line[i - 1], line[i]));
    return planMarks(plan).map(([a, b, why]) => ({ a, b, why, from: at[a], to: at[b], start: line[a] }));
  }
  const markLines = () => { const line = planLine(plan); return planMarks(plan).map(([a, b]) => line.slice(a, b + 1)); };
  const gradeName = () => `${GRADES[plan.activity].scale}${plan.grade}`;
  // the bike left at the start of a marked stretch: a waypoint there, walked on from it
  function parkAtStretch(m) {
    let at = 0;
    for (let i = 0; i < plan.legs.length; i++) {
      const L = plan.legs[i].via.length + 1;
      if (m.a === at) { commit(parkAt(plan, i)); return; }
      if (m.a < at + L) { commit(parkAt(splitAt(plan, i, m.a - at), i + 1)); return; }
      at += L;
    }
  }

  // ------------------------------------------------------------ profile, figures, colours
  let profTimer = null, profSeq = 0;
  function queueProfile() {
    const n = ++profSeq, line = planLine(plan);
    clearTimeout(profTimer);
    fresh = false;
    if (line.length < 2) { profile = null; renderStats(); drawProf(); return; }
    renderStats();
    profTimer = setTimeout(async () => {
      try {
        const p = await backend.profile([line], { slope: true });
        if (n !== profSeq || !plan) return;
        profile = p; fresh = true;
        colorize(); renderStats();
        if (saved) save();
      } catch (e) { if (n === profSeq) note(`No elevation profile: ${e.message}`); }
    }, 120);
  }
  function colorize() {
    season = terrain.settings.season;
    renderLegend();
    if (!profile || !plan) return;
    profile.colors = steepColors(profile, season === 'winter');
    if (!gesture?.moved) layer.set([profile.coords], color(), profile.colors, markLines());
    invalidate(); drawProf();
  }
  function renderStats() {
    const line = planLine(plan), len = line.length > 1 ? lineLength(line) : null, p = fresh ? profile : null;
    $('p-stats').innerHTML = statsHtml({ length: len, ascent: p?.ascent, descent: p?.descent, max: p?.max, min: p?.min, duration: p ? planTime(plan, p) : null });
    hooks.summary();
  }
  function renderLegend() {
    const winter = terrain.settings.season === 'winter', cls = winter ? SLOPE_CLASSES : GRADE_CLASSES;
    $('p-legend-title').textContent = winter ? 'Steepness: angle of the slope crossed' : 'Steepness: gradient of the route, up or down';
    $('p-legend').innerHTML = cls.map(([v, c], i) => `<span style="--c:${c}">${v}${winter ? '°' : '%'}${i === cls.length - 1 ? '+' : ''}</span>`).join('');
  }
  const pc = $('p-profile');
  function drawProf(hover = -1) {
    pc.hidden = !profile;
    if (profile) drawProfile(pc, profile, { color: color(), colors: profile.colors, hover, marks: plan ? stretches().map((m) => [m.from, m.to]) : [] });
  }
  pc.addEventListener('pointermove', (e) => {
    if (!profile) return;
    const i = profileIndex(pc, profile, e.clientX);
    drawProf(i); hooks.setMarker(profile.coords[i], profile.e[i]);
  });
  pc.addEventListener('pointerleave', () => { drawProf(); hooks.setMarker(null); });

  // ------------------------------------------------------------ the panel
  function renderPanel() {
    const n = plan.points.length, G = GRADES[plan.activity];
    document.querySelectorAll('#p-activity button').forEach((b) => b.classList.toggle('on', b.dataset.activity === plan.activity));
    document.querySelectorAll('#p-mode button').forEach((b) => b.classList.toggle('on', (b.dataset.mode === 'path') === follow));
    const sel = $('p-grade'), opts = GRADE_NAMES[G.scale].slice(G.min).map((t, i) => `<option value="${G.min + i}">${t}</option>`).join('');
    if (sel.dataset.scale !== G.scale) { sel.innerHTML = opts; sel.dataset.scale = G.scale; }
    sel.value = String(plan.grade);
    $('p-grade-label').textContent = RIDE[plan.activity] ? 'Rides up to' : 'Keeps to';
    renderRoute();
    $('p-undo').disabled = !undo.length; $('p-redo').disabled = !redo.length;
    for (const id of ['p-reverse', 'p-loop', 'p-outback', 'p-gpx', 'p-share']) $(id).disabled = n < 2;
    $('p-clear').disabled = !n;
    $('p-save').hidden = !!saved || n < 2;
    $('p-delete').hidden = !saved;
    $('p-saved').textContent = saved ? 'Kept in this browser under My routes' : '';
    $('p-hint').textContent = pen ? 'Pen: drag on the map to draw the way. The map stays put until you put the pen away (P).'
      : busy ? 'Finding the way along roads and paths…'
      : !n ? 'Click the map where the route starts, or take the pen and draw it.'
      : n === 1 ? (follow ? 'Click to add the next point. The route follows roads and paths to it.' : 'Click to add the next point. The route runs straight over the ground between points.')
      : 'Drag a point to move it, drag the line to add one, click a point to remove it.';
  }

  // what the route asks of you: the marked stretches (with a place to leave the bike), legs that could not follow
  // paths, and where the bike is left
  function renderRoute() {
    const box = $('p-route'), ride = !!RIDE[plan.activity], walked = walkedLegs(plan), list = stretches();
    const parts = [];
    if (ride && plan.park != null && walked.some(Boolean)) {
      const line = planLine(plan);
      let at = 0;
      for (let i = 0; i < plan.park; i++) at += plan.legs[i].via.length + 1;
      const d = line.slice(0, at + 1).reduce((s, q, i, a) => (i ? s + haversine(a[i - 1], q) : 0), 0);
      parts.push(`<div class="park"><b>Bike left at ${km(d)}</b>, walked on from there${walked.at(-1) ? '' : ' and back'}. <button data-unpark>Ride all the way</button></div>`);
    }
    for (const [i, m] of list.entries()) {
      // a bike's marks go by its grade, a hike's by the hiker's, the walked part of a Bike & Hike by the usual T3
      const label = MARK_LABEL[m.why]?.(BIKE_MARK.has(m.why) || !ride ? gradeName() : `T${GRADES.hike.def}`) || m.why;
      const len = m.to - m.from, offer = ride && BIKE_MARK.has(m.why) && plan.park == null && len >= 100;
      parts.push(`<div class="mark"><a href="#" data-mark="${i}">${esc(label)}</a> <span class="muted">${dist(len)} from ${km(m.from)}</span>${offer ? ` <button data-park="${i}">Leave the bike here</button>` : ''}</div>`);
    }
    const failed = [...new Set(plan.legs.filter((l) => l.mode === 'path' && l.failed).map((l) => FAILED[l.failed] || FAILED.failed))];
    for (const f of failed) parts.push(`<div class="muted">${esc(f)}</div>`);
    box.innerHTML = parts.join('');
    box.hidden = !parts.length;
    box.onclick = (e) => {
      const t = e.target.closest('[data-mark], [data-park], [data-unpark]');
      if (!t) return;
      e.preventDefault();
      if (t.dataset.unpark !== undefined) commit(parkAt(plan, null));
      else if (t.dataset.park) parkAtStretch(list[Number(t.dataset.park)]);
      else { const m = list[Number(t.dataset.mark)]; hooks.setMarker(m.start); }
    };
  }

  function setPen(on) {
    pen = on; hoverAt = null;
    $('p-pen').classList.toggle('on', on); $('p-pen').setAttribute('aria-pressed', String(on));
    canvas.style.cursor = on && plan ? 'crosshair' : '';
    if (plan) renderPanel();
    paint();
  }

  $('p-close').addEventListener('click', () => close());
  $('p-name').addEventListener('input', () => { plan.name = $('p-name').value; autosave(); hooks.syncUrl(); hooks.summary(); });
  document.querySelectorAll('#p-activity button').forEach((b) => b.addEventListener('click', () => {
    const a = b.dataset.activity;
    if (plan.activity === a) return;
    // a grade on the other scale goes back to that scale's usual one
    const grade = GRADES[a].scale === GRADES[plan.activity].scale ? plan.grade : GRADES[a].def;
    follow = followFor(a);
    commit({ ...plan, activity: a, grade }); autoFor = null; nameAfterStart();
  }));
  document.querySelectorAll('#p-mode button').forEach((b) => b.addEventListener('click', () => setFollow(b.dataset.mode === 'path')));
  $('p-grade').addEventListener('change', () => commit({ ...plan, grade: Number($('p-grade').value) }));
  $('p-pen').addEventListener('click', () => setPen(!pen));
  $('p-undo').addEventListener('click', undoStep);
  $('p-redo').addEventListener('click', redoStep);
  $('p-reverse').addEventListener('click', () => commit(reverse(plan)));
  $('p-loop').addEventListener('click', () => commit(backToStart(plan, mode())));
  $('p-outback').addEventListener('click', () => commit(outAndBack(plan)));
  $('p-clear').addEventListener('click', () => commit(emptyPlan(plan.activity, plan.name)));
  $('p-save').addEventListener('click', () => { save(); hooks.count?.('plan', 'save'); });
  $('p-delete').addEventListener('click', remove);
  $('p-gpx').addEventListener('click', exportGpx);
  $('p-share').addEventListener('click', share);
  $('p-import').addEventListener('click', () => fileInput.click());

  window.addEventListener('keydown', (e) => {
    if (!plan || e.target.closest?.('input, select, textarea')) return;
    const mod = e.metaKey || e.ctrlKey, k = e.key.toLowerCase();
    if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redoStep() : undoStep(); }
    else if (mod && k === 'y') { e.preventDefault(); redoStep(); }
    else if (!mod && k === 'p') setPen(!pen);
    else if (e.key === 'Escape') { if (gesture) cancel(); else if (pen) setPen(false); }
    else if ((e.key === 'Backspace' || e.key === 'Delete') && plan.points.length) { e.preventDefault(); commit(removePoint(plan, plan.points.length - 1)); }
  });

  // a name from the place nearest the start, until the route is given one
  async function nameAfterStart() {
    const s = plan?.points[0], key = s ? `${plan.activity}|${s}` : '';
    if (key === autoFor) return;
    autoFor = key;
    if (!s) { autoName = ''; $('p-name').placeholder = 'Name this route'; return; }
    const places = await backend.places().catch(() => []);
    if (autoFor !== key) return;
    let best = null, bd = 5000;
    for (const p of places) {
      if (!NAMED_AFTER.has(p.type)) continue;
      const d = haversine(p.at, s) * (p.type === 'hut' || p.type === 'lake' || p.type === 'hamlet' ? 2 : 1);
      if (d < bd) { bd = d; best = p; }
    }
    autoName = `${ACTIVITY_LABEL[plan.activity]}${best ? ` from ${best.name}` : ''}`;
    $('p-name').placeholder = autoName;
    hooks.summary();
  }

  // ------------------------------------------------------------ keeping, sharing, GPX
  let saveTimer = null;
  function autosave() { if (plan.points.length > 1) { clearTimeout(saveTimer); saveTimer = setTimeout(save, 400); } }
  function flushSave() { if (saveTimer) save(); }
  function save() {
    clearTimeout(saveTimer); saveTimer = null;
    if (!plan || plan.points.length < 2) return;
    const list = savedPlans(), now = Date.now();
    const entry = { id: saved || now.toString(36), name: nameOf(), activity: plan.activity, code: encodePlan(plan), saved: now,
      length: Math.round(lineLength(planLine(plan))), ascent: fresh ? profile.ascent : null };
    const i = list.findIndex((x) => x.id === entry.id);
    if (i >= 0) list[i] = entry; else list.unshift(entry);
    if (!keep(list)) { note('This browser keeps nothing for this site (a private window?), so the route lives only in its link.'); return; }
    saved = entry.id;
    renderPanel(); hooks.savedChanged();
  }
  function remove() {
    if (!saved || !window.confirm(`Delete “${nameOf()}” from My routes?`)) return;
    clearTimeout(saveTimer); saveTimer = null;
    keep(savedPlans().filter((x) => x.id !== saved));
    saved = null;
    hooks.savedChanged();
    close();
  }
  async function share() {
    const url = hooks.link();
    hooks.count?.('plan', 'share');
    try { await navigator.clipboard.writeText(url); note('Link copied. It holds the whole route, so it opens for anyone, no account needed.'); } catch { window.prompt('Copy this link:', url); }
  }
  function exportGpx() {
    const line = planLine(plan);
    if (line.length < 2) return;
    hooks.count?.('plan', 'gpx');
    const pts = fresh ? profile.coords.map((c, i) => [c[0], c[1], profile.e[i]]) : line.map(([a, b]) => [a, b, null]);
    saveFile(fileName(nameOf()), gpxText(nameOf(), [pts], hooks.link()));
  }
  const fileInput = Object.assign(document.createElement('input'), { type: 'file', accept: '.gpx,application/gpx+xml', hidden: true });
  fileInput.addEventListener('change', () => { importFile(fileInput.files[0]); fileInput.value = ''; });
  document.body.appendChild(fileInput);
  async function importFile(file) {
    if (!file) return;
    const text = await file.text(), pts = gpxPoints(text);
    if (pts.length < 2) { if (plan) note(`${file.name} has no track in it.`); else hooks.status?.(`${file.name} has no track in it.`); return; }
    open(planFromLine(pts, { activity: plan?.activity || 'hike', name: gpxName(text) || file.name.replace(/\.gpx$/i, '') }), { fit: true });
    hooks.count?.('planner', 'gpx');
    save();
  }

  // ------------------------------------------------------------ waypoints on the map
  const handleBox = $('plan-handles'), handles = [];
  const shown = () => gesture?.temp || plan;
  function syncHandles() {
    const pts = plan ? shown().points : [];
    while (handles.length < pts.length) {
      const h = document.createElement('div');
      h.addEventListener('pointerdown', (e) => startMove(e, Number(h.dataset.i)));
      handleBox.appendChild(h); handles.push(h);
    }
    while (handles.length > pts.length) handles.pop().remove();
    handles.forEach((h, i) => {
      h.dataset.i = i;
      h.className = `wp${i === 0 ? ' start' : ''}${i && i === pts.length - 1 ? ' end' : ''}${i === shown().park && RIDE[shown().activity] ? ' park' : ''}`;
      h.title = i === 0 ? 'Start · drag to move, click to remove' : i === pts.length - 1 ? 'End · drag to move, click to remove' : 'Drag to move, click to remove';
    });
    placeHandles();
  }
  const v3 = new THREE.Vector3();
  function screenOf([lon, lat]) {
    const [x, z] = frame.fromLonLat(lon, lat), y = terrain.surfaceAt(x, z, camera.position);
    if (y === null) return null;
    v3.set(x, y, z).project(camera);
    if (v3.z >= 1) return null;
    const r = canvas.getBoundingClientRect();
    return [r.left + (v3.x * 0.5 + 0.5) * r.width, r.top + (-v3.y * 0.5 + 0.5) * r.height];
  }
  function placeHandles() {
    const pts = plan ? shown().points : [];
    handles.forEach((h, i) => {
      const s = screenOf(pts[i]);
      h.style.display = s ? '' : 'none';
      if (s) h.style.transform = `translate(${s[0]}px, ${s[1]}px)`;
    });
  }

  // ------------------------------------------------------------ gestures: move a point, put one in, draw with the pen
  function startMove(e, i) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    gesture = { kind: 'move', i, pointerId: e.pointerId, x: e.clientX, y: e.clientY, moved: false, temp: null };
  }
  // presses on the map that are for the planner, before the map moves: the pen, or the line itself
  view.addEventListener('pointerdown', (e) => {
    if (!plan || gesture || !e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0) || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
    if (!pen && !plan.legs.length) return;
    const p = app.pickAt(e.clientX, e.clientY);
    const at = p && [p.lon, p.lat];
    if (!pen) {
      const n = at ? nearestLeg(plan, at) : null;
      if (!n || n.d > p.mPerPx * GRAB_PX) return;
      gesture = { kind: 'insert', leg: n.leg, at0: at };
    } else gesture = { kind: 'sketch', pts: at ? [at] : [], screen: [[e.clientX, e.clientY]], mPerPx: p?.mPerPx ?? 2 };
    Object.assign(gesture, { pointerId: e.pointerId, x: e.clientX, y: e.clientY, moved: false, temp: null });
    e.stopPropagation(); e.preventDefault();
    view.setPointerCapture(e.pointerId);
  }, true);

  window.addEventListener('pointermove', (e) => {
    const g = gesture;
    if (!g || e.pointerId !== g.pointerId) return;
    if (!g.moved && Math.hypot(e.clientX - g.x, e.clientY - g.y) < 4) return;
    if (!g.moved) { g.moved = true; if (g.kind !== 'sketch') hideEditedLegs(g); }
    const p = app.pickAt(e.clientX, e.clientY), at = p && [p.lon, p.lat];
    if (g.kind === 'sketch') {
      const [lx, ly] = g.screen.at(-1);
      if (Math.hypot(e.clientX - lx, e.clientY - ly) < 3) return;
      g.screen.push([e.clientX, e.clientY]);
      if (at) { g.pts.push(at); g.mPerPx = p.mPerPx; }
    } else if (at) { g.temp = g.kind === 'move' ? movePoint(plan, g.i, at) : movePoint(insertPoint(plan, g.leg, g.at0), g.leg + 1, at); preview(g); }
    syncHandles(); paint();
  });
  window.addEventListener('pointerup', (e) => {
    const g = gesture;
    if (!g || e.pointerId !== g.pointerId) return;
    gesture = null;
    if (g.kind === 'sketch') finishSketch(g);
    else if (!g.moved) commit(g.kind === 'move' ? removePoint(plan, g.i) : insertPoint(plan, g.leg, g.at0));
    else if (g.temp) commit(g.temp);
    else show();
    paint();
  });
  window.addEventListener('pointercancel', (e) => { if (gesture && e.pointerId === gesture.pointerId) cancel(); });
  function cancel() { gesture = null; show(); paint(); }

  // while a point moves, the map shows the legs it does not touch; the touched ones follow the pointer on top
  function hideEditedLegs(g) {
    const skip = g.kind === 'move' ? [g.i - 1, g.i] : [g.leg];
    layer.set(plan.legs.map((_, j) => j).filter((j) => !skip.includes(j)).map((j) => legLine(plan, j)), color());
    invalidate();
  }
  function finishSketch(g) {
    if (!g.pts.length) return;
    if (g.pts.length < 2) { commit(addPoint(plan, g.pts[0])); return; }        // a tap with the pen adds a point
    const line = simplify(g.pts, Math.max(1, g.mPerPx * 1.5));
    let next = plan;
    if (!next.points.length) next = addPoint(next, line[0]);
    commit(addPoint(next, line.at(-1), line.slice(plan.points.length ? 0 : 1, -1)));
  }

  // a click on the map: a new last point (the second click of a double-click zooms instead)
  function click(x, y) {
    if (pen) return;
    const p = app.pickAt(x, y);
    if (!p) return;
    const now = performance.now();
    if (lastAdd && now - lastAdd.t < 350 && Math.hypot(x - lastAdd.x, y - lastAdd.y) < 10) return;
    lastAdd = { t: now, x, y };
    commit(addPoint(plan, [p.lon, p.lat], [], mode()));
  }
  function cursor(p) {
    if (pen) return 'crosshair';
    return p && plan.legs.length && nearestLeg(plan, [p.lon, p.lat]).d < p.mPerPx * GRAB_PX ? 'copy' : 'crosshair';
  }
  function hover(p, x, y) {
    const next = p && !pen && !gesture && plan.points.length ? [x, y] : null;
    if (next || hoverAt) { hoverAt = next; paint(); }
  }

  // ------------------------------------------------------------ the drawing layer over the map
  function paint() {
    const dpr = window.devicePixelRatio || 1, W = Math.round(innerWidth * dpr), H = Math.round(innerHeight * dpr);
    if (sketchCanvas.width !== W || sketchCanvas.height !== H) { sketchCanvas.width = W; sketchCanvas.height = H; }
    dctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    dctx.clearRect(0, 0, innerWidth, innerHeight);
    if (!plan) return;
    const stroke = (pts, dash = []) => {
      if (pts.length < 2) return;
      dctx.lineJoin = 'round'; dctx.lineCap = 'round';
      for (const [w, c] of [[7, 'rgba(14,14,14,0.85)'], [3.5, color()]]) {
        dctx.beginPath(); pts.forEach(([x, y], i) => (i ? dctx.lineTo(x, y) : dctx.moveTo(x, y)));
        dctx.setLineDash(dash); dctx.lineWidth = w; dctx.strokeStyle = c; dctx.stroke();
      }
      dctx.setLineDash([]);
    };
    const g = gesture;
    if (g?.kind === 'sketch') {
      const last = plan.points.length ? screenOf(plan.points.at(-1)) : null;
      if (last && g.screen.length) stroke([last, g.screen[0]], [6, 8]);
      stroke(g.screen);
    } else if (g?.moved && g.temp) {
      const k = g.kind === 'move' ? g.i : g.leg + 1;
      for (const j of [k - 1, k]) {
        if (j < 0 || j >= g.temp.legs.length) continue;
        const r = g.temp.legs[j].mode === 'path' && g.preview?.[j];
        const line = r && !r.error ? [r.from, ...r.via, r.to] : legLine(g.temp, j), len = lineLength(line);
        stroke(densify(line, Math.max(5, len / 48)).map(screenOf).filter(Boolean), r && r.error ? [6, 8] : []);
      }
    } else if (hoverAt) {
      const a = screenOf(plan.points.at(-1));
      if (a) stroke([a, hoverAt], [6, 8]);
    }
  }
  window.addEventListener('resize', paint);

  // after each render: waypoints follow the camera, colours follow the season
  function frameUpdate() {
    if (!plan) return;
    placeHandles();
    if (gesture || hoverAt) paint();
    if (terrain.settings.season !== season) colorize();
  }

  return {
    open, openSaved, close, click, cursor, hover, importFile,
    frame: frameUpdate,
    pickFile: () => fileInput.click(),
    active: () => !!plan,
    plan: () => plan,
    code: () => (plan?.points.length ? encodePlan(plan) : null),
    name: () => plan?.name?.trim() || null,
    summary: () => {
      const line = plan ? planLine(plan) : [];
      return `${nameOf()}${line.length > 1 ? ` · ${km(lineLength(line))}${fresh ? ` · ↑ ${hm(profile.ascent)}` : ''}` : ''}`;
    },
    // a plan from a link, a route of the atlas or a GPX track
    fromCode: (code, name) => decodePlan(code, name || ''),
    fromRoute: (r) => planFromLine(r.lines.flat(), { activity: ACTIVITIES.includes(r.kind) ? r.kind : { bikehike: 'mtb', freeride: 'skitour', snowshoe: 'skitour' }[r.kind] || 'hike', name: `${r.name} (copy)` }),
    blank: () => emptyPlan(terrain.settings.season === 'winter' ? 'skitour' : 'hike'),
  };
}

function bounds(line) {
  return line.reduce((b, [x, y]) => [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)], [Infinity, Infinity, -Infinity, -Infinity]);
}
