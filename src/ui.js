// The side panel (region, crawler, route list and details), the layer panel and the status line.
import * as THREE from 'three';
import { KIND_COLORS, routeBounds } from './routes.js';
import { haversine } from './geo.js';
import { parseState, stateQuery, LAYERS } from './urlstate.js';
import { fold, searchPlaces, regionFromPlace, PLACE_LABEL } from '../shared/places.js';
import { createPlanner, savedPlans, ACTIVITY_LABEL } from './planner.js';
import { drawProfile as paintProfile, profileIndex } from './profile.js';
import { gpxText, gpxPoints, fileName, saveFile } from './gpx.js';
import { km, hm, statsHtml } from './format.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const KIND_LABEL = { hike: 'Hiking', bikehike: 'Bike & Hike', mtb: 'Mountain bike', emtb: 'eMTB', skitour: 'Ski touring', freeride: 'Freeride', snowshoe: 'Snowshoe' };
const SOURCE_LABEL = { osm: 'OpenStreetMap', bergfex: 'bergfex', combined: 'combined' };
const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const clock = (t) => new Date(t).toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' });


export function createUI(app) {
  const { terrain, routes, labels, camera, controls, frame, invalidate, backend } = app;
  const count = app.stats?.count || (() => {});          // usage counts on the public site (src/stats.js)
  const local = backend.mode === 'server';            // crawler, bergfex and GPX uploads need the local server
  document.body.classList.toggle('static-site', !local);
  const state = { region: null, all: [], kind: 'all', q: '', sort: 'near', inView: false, selected: null, profile: null, crawling: false, s2: {} };
  const marker = Object.assign(document.createElement('div'), { id: 'marker' });
  Object.assign(marker.style, { position: 'fixed', width: '14px', height: '14px', margin: '-7px 0 0 -7px', borderRadius: '50%', background: '#ffd23f', border: '2px solid #141414', pointerEvents: 'none', zIndex: 6, display: 'none' });
  document.body.appendChild(marker);
  let markerPos = null;

  // ------------------------------------------------------------ planning a route (src/planner.js)
  const planner = createPlanner(app, {
    onOpen: () => {
      if (state.selected) select(null);
      $('browse').hidden = true; $('crawl-box').hidden = true; $('detail').hidden = true;
      if (phone() && side.dataset.sheet === 'peek') setSheet('half');
    },
    onClose: () => { $('browse').hidden = false; $('crawl-box').hidden = false; renderMine(); sheetSummary(); },
    link: () => `${location.origin}${location.pathname}?${stateQuery(collectState())}`,
    syncUrl: (push) => syncUrl(push),
    fit: (b) => app.flyToBounds(b),
    count,
    setMarker: (at, ele) => {
      if (!at) { markerPos = null; marker.style.display = 'none'; invalidate(); return; }
      const [wx, wz] = frame.fromLonLat(at[0], at[1]);
      markerPos = new THREE.Vector3(wx, ele ?? terrain.heightAt(wx, wz) ?? 0, wz);
      invalidate();
    },
    savedChanged: () => renderMine(),
    summary: () => sheetSummary(),
    status: (t) => { $('crawl-status').textContent = t; },
  });
  $('plan-new').addEventListener('click', () => planner.open(planner.blank()));
  $('plan-import-gpx').addEventListener('click', () => planner.pickFile());
  // My routes: the plans kept in this browser
  function renderMine() {
    const list = savedPlans();
    $('mine').hidden = !list.length;
    $('mine-count').textContent = list.length;
    $('mine-list').innerHTML = list.map((p) => `<li data-id="${esc(p.id)}"><span class="dot" style="background:${KIND_COLORS[p.activity] || '#999'}"></span><span class="name">${esc(p.name)}</span><span class="meta">${esc([ACTIVITY_LABEL[p.activity], km(p.length), p.ascent != null ? `↑ ${hm(p.ascent)}` : null, new Date(p.saved).toLocaleDateString('de-AT')].filter(Boolean).join(' · '))}</span></li>`).join('');
  }
  $('mine-toggle').addEventListener('click', () => {
    const open = $('mine-list').hidden;
    $('mine-list').hidden = !open; $('mine-toggle').setAttribute('aria-expanded', String(open));
  });
  $('mine-list').addEventListener('click', (e) => { const li = e.target.closest('li[data-id]'); if (li) { planner.openSaved(li.dataset.id); count('planner', 'saved'); } });
  $('mine-list').hidden = false; $('mine-toggle').setAttribute('aria-expanded', 'true');
  renderMine();
  // a route from a link: the one kept under My routes if it is the same
  function openPlanFromLink(st) {
    try { planner.open(planner.fromCode(st.plan, st.pname), { fit: !st.camera, id: savedPlans().find((p) => p.code === st.plan)?.id }); count('planner', 'link'); }
    catch { $('crawl-status').textContent = 'The route in this link could not be read.'; }
  }

  // ------------------------------------------------------------ regions
  // the search box suggests the preset regions and, as you type, places from the place list (towns, valleys,
  // ranges, peaks, huts, lakes); Enter takes the first suggestion, and anything else goes to the geocoder
  let presets = [];
  backend.regions().then((list) => { presets = list.map((r) => ({ ...r, preset: true })); });
  const box = $('region'), sug = $('region-suggest');
  let hits = [], cur = -1, typed = 0;
  function showSuggestions(list) {
    hits = list; cur = -1;
    sug.hidden = !list.length;
    box.setAttribute('aria-expanded', String(!!list.length));
    box.removeAttribute('aria-activedescendant');
    sug.innerHTML = list.map((p, i) => `<li role="option" id="sug-${i}" data-i="${i}"><span>${esc(p.name)}</span><span class="muted">${p.preset ? 'Region' : PLACE_LABEL[p.type]}${p.ele ? ` · ${p.ele.toLocaleString('de-AT')} m` : ''}${p.near && p.near !== p.name ? ` · ${esc(p.near)}` : ''}</span></li>`).join('');
  }
  function highlight(i) {
    cur = i;
    sug.querySelectorAll('li').forEach((li, k) => li.classList.toggle('on', k === i));
    box.setAttribute('aria-activedescendant', `sug-${i}`);
    sug.children[i]?.scrollIntoView({ block: 'nearest' });
  }
  async function suggest() {
    const n = ++typed, k = fold(box.value);
    // the box still shows the current region: offer all presets, like a menu
    if (!k || box.value === state.region?.name) return showSuggestions(presets);
    const own = presets.filter((r) => fold(r.name).includes(k));
    const found = k.length >= 2 ? searchPlaces(await backend.places().catch(() => []), box.value, 8) : [];
    if (n === typed) showSuggestions([...own, ...found.filter((p) => !own.some((r) => fold(r.name) === p.key))].slice(0, 9));
  }
  function choose(p) {
    showSuggestions([]);
    box.blur();
    count('search', p.preset ? 'preset' : 'place');
    goRegion(p.name, true, { region: p.preset ? null : regionFromPlace(p) }).then(() => syncUrl(true));
  }
  box.addEventListener('input', suggest);
  box.addEventListener('focus', () => { box.select(); suggest(); if (phone()) setSheet('full'); });
  box.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== box) showSuggestions([]); }, 150));
  box.addEventListener('keydown', (e) => {
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && hits.length) {
      e.preventDefault();
      highlight(e.key === 'ArrowDown' ? (cur + 1) % hits.length : cur <= 0 ? hits.length - 1 : cur - 1);
    } else if (e.key === 'Escape') showSuggestions([]);
  });
  sug.addEventListener('pointerdown', (e) => e.preventDefault());        // keep the focus in the box
  sug.addEventListener('click', (e) => { const li = e.target.closest('li[data-i]'); if (li) choose(hits[li.dataset.i]); });
  $('region-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (hits.length && (cur >= 0 || box.value !== state.region?.name)) return choose(hits[Math.max(cur, 0)]);
    showSuggestions([]); box.blur();
    count('search', 'text');
    goRegion(box.value, true).then(() => syncUrl(true));
  });

  // camera and route: from a link, or Back/Forward; region: a place chosen in the search box
  async function goRegion(q, fly, { camera, route, region: chosen } = {}) {
    try {
      // a name used by several places (there are many a Kreuzjoch) means the one where the camera is
      const region = chosen || await backend.region(q || 'Zillertal', camera ? [camera.lon, camera.lat] : null);
      state.region = region;
      $('region').value = region.name;
      count('region', region.name);
      app.setRegion(region, { fly: fly && !camera });
      if (camera) app.setCamera(camera);
      const data = await loadRoutes();
      if (route) { const r = state.all.find((x) => x.id === route); if (r) await select(r, { fly: !camera }); }
      // a region nobody has crawled yet: fetch its OpenStreetMap routes right away (the web sites stay on the button)
      if (!state.all.length && !Object.keys(data.sources || {}).length && !state.crawling) {
        $('crawl-status').textContent = `Searching OpenStreetMap for routes in ${region.name}…`;
        startCrawl(['osm']);
      }
      state.s2 = {};
      refreshS2();
    } catch (e) { $('crawl-status').textContent = `Region not found: ${e.message}`; }
  }

  // ------------------------------------------------------------ routes
  async function loadRoutes() {
    const data = await backend.routes(state.region);
    const sel = state.selected?.id;
    state.all = data.routes;
    routes.setRoutes(state.all);
    const srcs = Object.entries(data.sources || {}).map(([k, v]) => `${v.label} ${v.count} (${new Date(v.crawled).toLocaleDateString('de-AT')})`);
    const t = data.tracks;
    const trackNote = t && t.total && t.withTrack < t.total
      ? ` · bergfex tracks ${t.withTrack}/${t.total}${t.waitUntil ? `, more after ${clock(t.waitUntil)}` : t.running ? ', loading' : ''}` : '';
    $('crawl-status').textContent = !local
      ? (state.all.length ? `${state.all.length} routes from OpenStreetMap, ${data.searchedHere ? 'searched in this browser' : 'collected'} ${new Date(data.updated || Object.values(data.sources)[0]?.crawled).toLocaleDateString('de-AT')}.` : 'No routes for this region yet. Search the web to find some.')
      : state.all.length ? `${state.all.length} routes cached · ${srcs.join(' · ')}${trackNote}` : 'No routes for this region yet. Search the web to find some.';
    // tracks still arriving in the background: look again in a minute
    clearTimeout(state.trackTimer);
    if (t?.running && !state.crawling) state.trackTimer = setTimeout(() => { if (!state.crawling) loadRoutes(); }, 60000);
    applyFilter();
    if (sel) { const r = state.all.find((x) => x.id === sel); if (r) { state.selected = r; routes.select(r); } }
    return data;
  }

  function viewCenterLonLat() { return frame.toLonLat(controls.target.x, controls.target.z); }
  function inViewTest() {
    const c = viewCenterLonLat(), radius = Math.max(camera.position.distanceTo(controls.target) * 1.4, 3000);
    return (r) => { const s = r.start; return s && haversine(c, s) < radius; };
  }

  function applyFilter() {
    const q = state.q.trim().toLowerCase();
    const near = state.inView || state.sort === 'near' ? inViewTest() : null;
    const matching = state.all.filter((r) => (!q || [r.name, r.ref, r.from, r.to, r.description, r.network].some((v) => v && String(v).toLowerCase().includes(q))) &&
      (!state.inView || near(r)));
    // how many of each kind the other filters leave; kinds with none are dimmed
    const perKind = {};
    for (const r of matching) perKind[r.kind] = (perKind[r.kind] || 0) + 1;
    document.querySelectorAll('#kind-filter button').forEach((b) => {
      const k = b.dataset.kind, n = k === 'all' ? matching.length : perKind[k] || 0;
      b.dataset.count = n; b.classList.toggle('none', !n && k !== 'all');
    });
    let list = matching.filter((r) => state.kind === 'all' || r.kind === state.kind);
    const c = viewCenterLonLat();
    const key = {
      name: (r) => r.name.toLowerCase(), ascent: (r) => -Math.max(r.stats?.ascent ?? -1, r.stats?.descent ?? -1), length: (r) => -(r.stats?.length ?? -1),
      max: (r) => -(r.stats?.max ?? -1), near: (r) => (r.start ? haversine(c, r.start) : 1e9),
    }[state.sort];
    list.sort((a, b) => { const ka = key(a), kb = key(b); return ka < kb ? -1 : ka > kb ? 1 : 0; });
    state.list = list;
    routes.setShown(list);
    renderList();
    invalidate();
  }

  function renderList() {
    const list = state.list || [];
    sheetSummary();
    const bySrc = {};
    list.forEach((r) => { bySrc[r.source] = (bySrc[r.source] || 0) + 1; });
    $('count').textContent = `${list.length} routes`;
    $('count').title = Object.entries(bySrc).map(([k, v]) => `${SOURCE_LABEL[k] || k}: ${v}`).join('\n');
    const ul = $('list');
    if (!list.length) { ul.innerHTML = `<li class="empty">${state.all.length ? 'No routes match.' : 'Nothing here yet — press “Search the web for routes”.'}</li>`; return; }
    ul.innerHTML = list.slice(0, 600).map((r, i) => {
      const s = r.stats || {};
      const src = r.source === 'combined' ? [...new Set((r.parts || []).map((p) => SOURCE_LABEL[p.source] || p.source))].join(' + ') : SOURCE_LABEL[r.source];
      const bits = [KIND_LABEL[r.kind], km(s.length), s.ascent != null ? `↑ ${hm(s.ascent)}${s.descent != null ? ` ↓ ${hm(s.descent)}` : ''}` : null, s.max ? `▲ ${hm(s.max)}` : null, r.difficulty, src].filter(Boolean);
      return `<li data-i="${i}"><span class="dot" style="background:${KIND_COLORS[r.kind] || '#999'}"></span><span class="name">${esc(r.name)}${r.ref && !r.name.includes(r.ref) ? ` <span class="muted">${esc(r.ref)}</span>` : ''}</span><span class="meta">${esc(bits.join(' · '))}</span></li>`;
    }).join('');
  }
  $('list').addEventListener('click', (e) => { const li = e.target.closest('li[data-i]'); if (li) select(state.list[li.dataset.i]); });
  $('list').addEventListener('mouseover', (e) => { const li = e.target.closest('li[data-i]'); routes.hover(li ? state.list[li.dataset.i] : null); invalidate(); });
  $('list').addEventListener('mouseleave', () => { routes.hover(null); invalidate(); });

  function setKind(kind) {
    document.querySelectorAll('#kind-filter button').forEach((x) => x.classList.toggle('on', x.dataset.kind === kind));
    state.kind = kind; applyFilter();
  }
  document.querySelectorAll('#kind-filter button').forEach((b) => b.addEventListener('click', () => { setKind(b.dataset.kind); count('kind', b.dataset.kind); syncUrl(); }));
  let qTimer;
  $('q').addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(() => { state.q = $('q').value; applyFilter(); }, 150); });
  $('sort').addEventListener('change', () => { state.sort = $('sort').value; applyFilter(); });
  $('in-view').addEventListener('change', () => { state.inView = $('in-view').checked; applyFilter(); });
  let viewTimer;
  controls.addEventListener('end', () => {
    if (state.inView || state.sort === 'near') { clearTimeout(viewTimer); viewTimer = setTimeout(applyFilter, 300); }
    syncUrl();
  });

  // ------------------------------------------------------------ details
  async function select(r, { fly = true } = {}) {
    if (r && planner.active()) planner.close({ url: false });
    state.selected = r; state.profile = null;
    routes.select(r); invalidate();
    syncUrl(true);
    sheetSummary();
    if (r && phone() && side.dataset.sheet === 'peek') setSheet('half');
    if (!r) { $('detail').hidden = true; $('browse').hidden = false; $('crawl-box').hidden = false; return; }
    count('route', r.source);
    $('browse').hidden = true; $('crawl-box').hidden = true; $('detail').hidden = false;
    $('d-name').textContent = r.name;
    $('d-badges').innerHTML = [`<span class="chip" style="border-color:${KIND_COLORS[r.kind] || '#999'}">${KIND_LABEL[r.kind] || r.kind}</span>`, `<span class="chip">${SOURCE_LABEL[r.source] || r.source}</span>`,
      r.ref ? `<span class="chip">${esc(r.ref)}</span>` : '', r.network ? `<span class="chip">${esc({ iwn: 'international', nwn: 'national', rwn: 'regional', lwn: 'local' }[r.network] || r.network)}</span>` : '',
      r.difficulty ? `<span class="chip">${esc(r.difficulty)}</span>` : ''].join('');
    renderStats(r.stats || {});
    $('d-desc').textContent = [r.from && r.to ? `${r.from} → ${r.to}` : '', r.description || ''].filter(Boolean).join('. ');
    $('d-img').hidden = !r.image; if (r.image) $('d-img').src = r.image;
    renderActions(r);
    $('profile').hidden = true;
    if (!r.lines && r.source === 'bergfex') {
      // crawled before tracks were fetched: get this one now
      $('d-profile-note').textContent = 'Fetching the track from bergfex…';
      if (fly) zoomTo(r);
      try {
        const t = await backend.track(state.region, r.id);
        if (state.selected !== r) return;
        trackArrived(r, t, fly);
      } catch (e) {
        $('d-profile-note').textContent = e.status === 429
          ? `bergfex allows only a few track downloads at a time; this one follows in the background after ${clock(e.until)}. Or get it with “GPX on bergfex” while logged in and drop the file here.`
          : `bergfex has no track for this tour (${e.message}). If you have one, drop the GPX file here.`;
      }
    } else if (fly) zoomTo(r);
    if (r.lines) {
      $('d-profile-note').textContent = 'Measuring the elevation profile on the tiris DGM…';
      try {
        const p = await backend.profile(r.lines);
        if (state.selected !== r) return;
        state.profile = p;
        renderStats({ ...(r.stats || {}), length: p.length, ascent: p.ascent, descent: p.descent, min: p.min, max: p.max });
        $('profile').hidden = false; $('d-profile-note').textContent = 'Elevation from the Land Tirol laser scan (0.5 m DGM), sampled every 10 m.';
        drawProfile();
      } catch (e) { $('d-profile-note').textContent = `No profile: ${e.message}`; }
    } else if (r.source !== 'bergfex') $('d-profile-note').textContent = 'Only the start point is known for this route.';
  }
  function trackArrived(r, t, fly) {
    Object.assign(r, { lines: t.lines, start: t.start, stats: t.stats, top: t.top, measured: true });
    routes.refresh(r);
    renderStats(r.stats); renderActions(r); renderList();
    if (fly) zoomTo(r);
  }

  // attach a GPX file to the selected route: dropped on the panel or picked with the button
  async function attachFile(file) {
    const r = state.selected;
    if (!r || !file) return;
    $('d-profile-note').textContent = `Reading ${file.name}…`;
    const text = await file.text();
    // make sure the file belongs to this route: bergfex names its files after the tour, and a track should pass its start
    const inName = file.name.match(/bergfextour_(\d+)/), own = r.id.match(/^bergfex-(\d+)$/);
    const pts = gpxPoints(text);
    if (!pts.length) { $('d-profile-note').textContent = `${file.name} has no track points.`; return; }
    const closest = r.start ? Math.min(...pts.map((p) => haversine(p, r.start))) : 0;
    const doubt = inName && own && inName[1] !== own[1] ? `${file.name} is bergfex tour ${inName[1]}, not this one.`
      : closest > 3000 ? `This track comes no closer than ${km(closest)} to where “${r.name}” starts.` : null;
    if (doubt && !window.confirm(`${doubt}\n\nAttach it to “${r.name}” anyway?`)) { $('d-profile-note').textContent = `${file.name} was not attached.`; return; }
    try {
      const t = await backend.attachGpx(state.region, r.id, text);
      if (state.selected !== r) return;
      trackArrived(r, t, true);
      select(r, { fly: false });                               // profile and stats from the new track
    } catch (e) { $('d-profile-note').textContent = `Could not use ${file.name}: ${e.message}`; }
  }
  const gpxInput = Object.assign(document.createElement('input'), { type: 'file', accept: '.gpx,application/gpx+xml', hidden: true });
  gpxInput.addEventListener('change', () => { attachFile(gpxInput.files[0]); gpxInput.value = ''; });
  document.body.appendChild(gpxInput);
  // a GPX file dropped on the panel: the selected route's track (local app), or else a route to look at and change
  const attaching = () => local && state.selected && !planner.active();
  $('side').addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    if (attaching()) $('detail').classList.add('drop');
  });
  $('side').addEventListener('dragleave', () => $('detail').classList.remove('drop'));
  $('side').addEventListener('drop', (e) => {
    $('detail').classList.remove('drop');
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    if (attaching()) attachFile(e.dataTransfer.files[0]); else planner.importFile(e.dataTransfer.files[0]);
  });

  function renderActions(r) {
    const acts = [`<button id="d-zoom">Zoom to route</button>`];
    if (r.kind === 'bikehike' && Array.isArray(r.parts)) for (const p of r.parts) acts.push(`<a href="${esc(p.url)}" target="_blank" rel="noopener" title="${esc(p.name)}">${p.role === 'bike' ? 'Bike route' : 'Hiking route'} on ${SOURCE_LABEL[p.source] || 'source'} ↗</a>`);
    else acts.push(`<a href="${esc(r.url)}" target="_blank" rel="noopener">Open on ${SOURCE_LABEL[r.source] || 'source'} ↗</a>`);
    if (r.website) acts.push(`<a href="${esc(r.website)}" target="_blank" rel="noopener">Website ↗</a>`);
    if (r.lines) acts.push(`<button id="d-gpx">GPX</button>`, `<button id="d-copy" title="Open this route in the planner to change it">Edit a copy</button>`);
    const bf = r.id.match(/^bergfex-(\d+)$/);
    if (bf) acts.push(`<a href="https://www.bergfex.at/downloads/gps/?id=${bf[1]}&amp;fileType=gpx" target="_blank" rel="noopener">GPX on bergfex ↗</a>`);
    if (local && (!r.lines || r.source === 'bergfex')) acts.push(`<button id="d-attach" title="Use a GPX file you downloaded as this route's track (or drop it on this panel)">Attach GPX…</button>`);
    $('d-actions').innerHTML = acts.join('');
    $('d-attach')?.addEventListener('click', () => gpxInput.click());
    $('d-zoom').onclick = () => zoomTo(r);
    if (r.lines) { $('d-gpx').onclick = () => { downloadGpx(r); count('gpx', 'route'); }; $('d-copy').onclick = () => { planner.open(planner.fromRoute(r)); count('planner', 'copy'); }; }
  }
  function renderStats(s) { $('d-stats').innerHTML = statsHtml(s); }
  function zoomTo(r) {
    if (r.lines) app.flyToBounds(routeBounds(r));
    else if (r.start) app.flyTo(app.lookAt(r.start[0], r.start[1], { dist: 3500, pitch: 45, heading: headingNow() }));
  }
  $('back').addEventListener('click', () => { select(null); marker.style.display = 'none'; markerPos = null; });

  function downloadGpx(r) {
    const p = state.profile;
    const lines = p ? [p.coords.map((c, i) => [c[0], c[1], p.e[i]])] : r.lines.map((l) => l.map((c) => [c[0], c[1], null]));
    saveFile(fileName(r.name), gpxText(r.name, lines, r.url));
  }

  // elevation profile
  const pc = $('profile');
  function drawProfile(hoverI = -1) {
    if (state.profile) paintProfile(pc, state.profile, { color: KIND_COLORS[state.selected?.kind] || '#ff5a2e', hover: hoverI });
  }
  pc.addEventListener('mousemove', (e) => {
    const p = state.profile; if (!p) return;
    const i = profileIndex(pc, p, e.clientX);
    drawProfile(i);
    const [lon, lat] = p.coords[i], [wx, wz] = frame.fromLonLat(lon, lat);
    markerPos = new THREE.Vector3(wx, p.e[i] ?? terrain.heightAt(wx, wz) ?? 0, wz);
    invalidate();
  });
  pc.addEventListener('mouseleave', () => { drawProfile(); markerPos = null; marker.style.display = 'none'; invalidate(); });

  // ------------------------------------------------------------ crawler
  backend.sources().then((list) => {
    $('crawl-sources').innerHTML = list.map((s) => `<label><input type="checkbox" value="${s.id}" checked> ${esc(s.label)}</label>`).join('');
  });
  $('crawl-toggle').addEventListener('click', () => { $('crawl-more').hidden = !$('crawl-more').hidden; $('crawl-log').hidden = $('crawl-more').hidden; });
  async function startCrawl(sources) {
    state.crawling = true;
    await backend.startCrawl(state.region?.name || $('region').value, sources);
    pollCrawl();
  }
  $('crawl').addEventListener('click', () => { count('crawl', 'web'); startCrawl([...document.querySelectorAll('#crawl-sources input:checked')].map((i) => i.value)); });
  let lastReload = 0;
  async function pollCrawl() {
    const s = await backend.crawlStatus().catch(() => null);
    if (!s || s.state === 'idle') return;
    const running = s.state === 'running';
    state.crawling = running;
    $('crawl').disabled = running;
    $('crawl').textContent = running ? 'Searching…' : 'Search the web for routes';
    const parts = s.sources.map((x) => `${x.label}: ${x.state}${x.found ? ` (${x.found})` : ''}`);
    $('crawl-status').textContent = `${s.region}: ${parts.join(' · ')}`;
    $('crawl-log').innerHTML = s.log.slice(-30).map((l) => `<li>${esc(l.msg)}</li>`).join('');
    $('crawl-log').scrollTop = 1e6;
    if (state.region && s.slug === state.region.slug && (!running || Date.now() - lastReload > 6000)) { lastReload = Date.now(); await loadRoutes(); if (!running) $('crawl-status').textContent += ' — done'; }
    if (running) setTimeout(pollCrawl, 1500);
  }
  pollCrawl();

  // ------------------------------------------------------------ layers
  async function refreshS2() {
    const st = terrain.settings, season = st.season;
    if (!(season === 'winter' || st.satellite) || !state.region) { $('s2-info').textContent = ''; return; }
    const key = `${season}-${state.region.slug}`;
    if (!state.s2[key]) {
      $('s2-info').textContent = `Finding the best Sentinel-2 ${season} scene…`;
      state.s2[key] = backend.s2Scene(season, state.region).catch((e) => ({ error: e.message }));
    }
    const s = await state.s2[key];
    if (terrain.settings.season !== season) return;
    if (s.error || s.none) { $('s2-info').textContent = `No Sentinel-2 scene: ${s.error || 'none in ' + s.window?.join(' – ')}`; delete state.s2[key]; return; }
    terrain.setS2Scene(season, s.searchid, s.maxZoom);
    const day = (d, o) => new Date(d).toLocaleDateString('de-AT', o);
    $('s2-info').textContent = (s.mosaic
      ? `Sentinel-2 ${season} mosaic, ${day(s.window[0], { day: 'numeric', month: 'short' })} – ${day(s.window[1], { day: 'numeric', month: 'short', year: 'numeric' })}, least clouds first`
      : `Sentinel-2 ${day(s.date, { day: 'numeric', month: 'short', year: 'numeric' })} · ${Math.round(s.cloud)}% cloud`) + (season === 'winter' && !st.satellite ? ' · snow on the orthophoto' : '');
    invalidate();
  }
  function setSeason(season) {
    document.querySelectorAll('#season button').forEach((x) => x.classList.toggle('on', x.dataset.season === season));
    terrain.set({ season }); refreshS2(); invalidate();
  }
  function setImagery(v) {
    $('imagery').value = v;
    terrain.set(v === 's2' ? { satellite: true } : { satellite: false, imagery: v }); refreshS2(); invalidate();
  }
  function setHybrid(on) {
    document.querySelectorAll('#mapstyle button').forEach((x) => x.classList.toggle('on', (x.dataset.style === 'hybrid') === on));
    terrain.set({ hybrid: on }); labels.visible = on; invalidate();
  }
  function setLayers(list, showRoutes) {
    $('l-slope').checked = list.includes('slope'); $('l-contours').checked = list.includes('contours');
    document.querySelectorAll('[data-tiris]').forEach((c) => { c.checked = list.includes(c.dataset.tiris); });
    $('l-routes').checked = showRoutes;
    readLayers();
  }
  function readLayers() {
    terrain.set({ slope: $('l-slope').checked ? 0.6 : 0, contours: $('l-contours').checked ? 0.8 : 0,
      tiris: [...document.querySelectorAll('[data-tiris]:checked')].map((x) => x.dataset.tiris) });
    $('slope-legend').hidden = !$('l-slope').checked;
    routes.visible = $('l-routes').checked; invalidate();
  }
  document.querySelectorAll('#season button').forEach((b) => b.addEventListener('click', () => { setSeason(b.dataset.season); count('season', b.dataset.season); syncUrl(); }));
  $('imagery').addEventListener('change', () => { setImagery($('imagery').value); count('imagery', $('imagery').value); syncUrl(); });
  document.querySelectorAll('#mapstyle button').forEach((b) => b.addEventListener('click', () => { setHybrid(b.dataset.style === 'hybrid'); count('style', b.dataset.style); syncUrl(); }));
  for (const el of [$('l-routes'), $('l-slope'), $('l-contours'), ...document.querySelectorAll('[data-tiris]')]) el.addEventListener('change', () => { readLayers(); if (el.checked) count('layer', el.dataset.tiris || el.id.replace('l-', '')); syncUrl(); });
  $('sun').addEventListener('input', () => { app.setSun($('sun').value / 100); syncUrl(); });

  // ------------------------------------------------------------ the address bar: every view is a link
  let quiet = 0, urlTimer;
  function collectState() {
    return {
      region: state.region?.name, camera: app.cameraState(), season: terrain.settings.season, imagery: $('imagery').value,
      hybrid: terrain.settings.hybrid, routes: routes.visible, kind: state.kind, route: planner.active() ? null : state.selected?.id || null, sun: Number($('sun').value),
      plan: planner.code(), pname: planner.name(),
      layers: LAYERS.filter((l) => (l === 'slope' ? $('l-slope').checked : l === 'contours' ? $('l-contours').checked : document.querySelector(`[data-tiris="${l}"]`)?.checked)),
    };
  }
  // region and route changes make history entries (Back works); moving the map and switching layers replace the entry
  function syncUrl(push = false) {
    if (quiet || !state.region) return;
    clearTimeout(urlTimer);
    urlTimer = setTimeout(() => {
      const q = stateQuery(collectState()), url = `${location.pathname}${q ? `?${q}` : ''}`;
      if (url === location.pathname + location.search) return;
      history[push ? 'pushState' : 'replaceState'](null, '', url);
    }, push ? 0 : 300);
  }
  function applySettings(st) {
    setSeason(st.season); setImagery(st.imagery); setHybrid(st.hybrid); setLayers(st.layers, st.routes); setKind(st.kind);
    $('sun').value = st.sun; app.setSun(st.sun / 100);
  }
  window.addEventListener('popstate', async () => {
    const st = parseState(location.search);
    quiet++;
    try {
      applySettings(st);
      if (st.region && st.region !== state.region?.name) await goRegion(st.region, false, { camera: st.camera, route: st.route });
      else {
        if (st.camera) app.setCamera(st.camera);
        if ((st.route || null) !== (state.selected?.id || null)) await select(state.all.find((r) => r.id === st.route) || null, { fly: !st.camera });
      }
      if (st.plan) { if (st.plan !== planner.code()) openPlanFromLink(st); } else if (planner.active()) planner.close({ url: false });
    } finally { quiet--; }
  });

  // phones: the layer panel opens from a button, the side panel is a bottom sheet that expands from its header
  $('layers-btn').addEventListener('click', () => {
    const open = $('layers').classList.toggle('open');
    $('layers-btn').setAttribute('aria-expanded', open);
  });

  // the bottom sheet on phones: peek (only the search), half, or full; the map gets everything above it
  const side = $('side'), phone = () => window.innerWidth <= 760;
  const sheetHeights = () => {
    const H = window.innerHeight, peek = side.querySelector('header').offsetHeight + 2;
    return { peek, half: Math.round(H * 0.48), full: H - 64 };
  };
  function setSheet(name, px) {
    if (!phone()) { document.documentElement.style.removeProperty('--sheet-h'); return; }
    const h = px ?? sheetHeights()[name];
    side.dataset.sheet = name;
    document.documentElement.style.setProperty('--sheet-h', `${h}px`);
  }
  const relayout = () => window.dispatchEvent(new Event('resize'));
  side.addEventListener('transitionend', (e) => { if (e.target === side) relayout(); });
  // drag the handle: the sheet follows the finger and snaps to the nearest height
  let drag = null;
  $('sheet-handle').addEventListener('pointerdown', (e) => {
    if (!phone()) return;
    drag = { y: e.clientY, h: side.offsetHeight, moved: false };
    $('sheet-handle').setPointerCapture(e.pointerId);
    side.classList.add('dragging');
  });
  $('sheet-handle').addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dy = drag.y - e.clientY;
    if (Math.abs(dy) > 4) drag.moved = true;
    const { peek, full } = sheetHeights();
    document.documentElement.style.setProperty('--sheet-h', `${Math.min(Math.max(drag.h + dy, peek), full)}px`);
    relayout();
  });
  $('sheet-handle').addEventListener('pointerup', () => {
    if (!drag) return;
    side.classList.remove('dragging');
    const hs = sheetHeights(), cur = side.offsetHeight;
    if (!drag.moved) setSheet(side.dataset.sheet === 'peek' ? 'half' : 'peek');
    else setSheet(Object.entries(hs).sort((a, b) => Math.abs(a[1] - cur) - Math.abs(b[1] - cur))[0][0]);
    drag = null;
    setTimeout(relayout, 260);
  });
  $('sheet-handle').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSheet(side.dataset.sheet === 'peek' ? 'half' : 'peek'); } });
  window.addEventListener('resize', () => { if (!drag && phone()) document.documentElement.style.setProperty('--sheet-h', `${sheetHeights()[side.dataset.sheet || 'peek']}px`); });
  setSheet('peek'); relayout();
  // tapping the map closes the layer panel; the attribution opens on a tap
  app.renderer.domElement.addEventListener('pointerdown', () => { if (phone()) { $('layers').classList.remove('open'); $('layers-btn').setAttribute('aria-expanded', false); } });
  $('status').addEventListener('click', () => { if (phone()) $('status').classList.toggle('open'); });
  // fullscreen where the browser allows it (not on iPhones; there, "Add to Home Screen" opens without browser bars)
  if (document.fullscreenEnabled) {
    $('fullscreen').hidden = false;
    $('fullscreen').addEventListener('click', () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {}));
  }
  function sheetSummary() {
    $('sheet-summary').textContent = planner.active() ? planner.summary() : state.selected ? state.selected.name
      : `${state.region?.name || ''} · ${(state.list || state.all).length} routes`;
  }

  const headingNow = () => (controls.heading * 180) / Math.PI;

  // navigation buttons and the help card
  const nav = { 'zoom-in': () => controls.zoomStep(1), 'zoom-out': () => controls.zoomStep(-1), tilt: () => controls.toggleTilt(), compass: () => controls.northUp(), 'help-btn': () => toggleHelp() };
  for (const [id, fn] of Object.entries(nav)) $(id).addEventListener('click', () => { fn(); invalidate(); });
  const toggleHelp = (show = $('help').hidden) => { $('help').hidden = !show; if (show) count('help', 'open'); };
  $('help').addEventListener('click', (e) => { if (e.target === $('help') || e.target.closest('.close')) toggleHelp(false); });
  window.addEventListener('keydown', (e) => {
    if (e.target.closest?.('input, select, textarea')) return;
    if (e.key === '?') toggleHelp();
    if (e.key === 'Escape') toggleHelp(false);
  });

  // ------------------------------------------------------------ map pointer
  const tip = $('tooltip');
  let down = null, pending = null;
  const canvas = app.renderer.domElement;
  canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
  canvas.addEventListener('pointerup', (e) => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5 || performance.now() - down.t > 500) return;
    if (planner.active()) { planner.click(e.clientX, e.clientY); return; }
    const p = app.pickAt(e.clientX, e.clientY);
    if (p?.route) { select(p.route, { fly: false }); }
  });
  canvas.addEventListener('pointermove', (e) => { pending = e; if (e.buttons) tip.hidden = true; });
  canvas.addEventListener('pointerleave', () => { pending = null; tip.hidden = true; });

  function updateCursor() {
    const e = pending; pending = null;
    if (!e || e.buttons) return;
    const p = app.pickAt(e.clientX, e.clientY);
    if (planner.active()) planner.hover(p, e.clientX, e.clientY);
    if (!p) { $('cursor').textContent = ''; tip.hidden = true; return; }
    const { slope, aspect } = terrain.slopeAt(p.hit.x, p.hit.z);
    $('cursor').textContent = `${p.lat.toFixed(5)} N  ${p.lon.toFixed(5)} E  ·  ${Math.round(p.hit.y)} m  ·  ${slope.toFixed(0)}° ${DIRS[Math.round(aspect / 45) % 8]}`;
    // while planning, a click adds a point, so routes under the cursor are not picked out
    const over = planner.active() ? null : p.route;
    if (over !== routes.hovered) { routes.hover(over); invalidate(); }
    tip.hidden = !over;
    if (over) { tip.textContent = `${over.name} · ${KIND_LABEL[over.kind] || ''}`; tip.style.left = `${e.clientX}px`; tip.style.top = `${e.clientY}px`; }
    canvas.style.cursor = planner.active() ? planner.cursor(p) : p.route ? 'pointer' : '';
  }
  setInterval(updateCursor, 60);

  // ------------------------------------------------------------ per frame
  const v = new THREE.Vector3();
  function frameUpdate() {
    planner.frame();
    $('compass').firstElementChild.style.transform = `rotate(${-headingNow()}deg)`;
    $('tilt').textContent = controls.pitch < -75 * Math.PI / 180 ? '3D' : '2D';
    const n = Object.values(terrain.active || {}).reduce((a, b) => a + b, 0);
    $('loading').textContent = n ? `Loading terrain… ${n}` : '';
    if (markerPos) {
      v.copy(markerPos).project(camera);
      const r = canvas.getBoundingClientRect();
      marker.style.display = v.z < 1 ? 'block' : 'none';
      marker.style.left = `${r.left + (v.x * 0.5 + 0.5) * r.width}px`; marker.style.top = `${r.top + (-v.y * 0.5 + 0.5) * r.height}px`;
    }
  }

  // start from the link (or Zillertal)
  const start = parseState(location.search);
  quiet++;
  applySettings(start);
  goRegion(start.region || 'Zillertal', false, { camera: start.camera, route: start.route }).finally(() => {
    if (start.plan) openPlanFromLink(start);
    quiet--; syncUrl();
    // the place list for the search box, fetched while nobody waits for it
    const later = (f) => (window.requestIdleCallback ? requestIdleCallback(f, { timeout: 3000 }) : setTimeout(f, 3000));
    later(() => backend.places().catch(() => {}));
  });
  return { frame: frameUpdate, busy: () => false, syncUrl, planner };
}
