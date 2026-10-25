// The side panel (region, crawler, route list and details), the layer panel and the status line.
import * as THREE from 'three';
import { KIND_COLORS, routeBounds } from './routes.js';
import { haversine } from './geo.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const KIND_LABEL = { hike: 'Hiking', skitour: 'Ski touring', snowshoe: 'Snowshoe' };
const SOURCE_LABEL = { osm: 'OpenStreetMap', bergfex: 'bergfex' };
const km = (m) => (m == null ? '–' : m >= 10000 ? `${(m / 1000).toFixed(0)} km` : `${(m / 1000).toFixed(1)} km`);
const hm = (m) => (m == null ? '–' : `${Math.round(m).toLocaleString('de-AT')} m`);
const hours = (h) => (h == null ? null : `${Math.floor(h)}:${String(Math.round((h % 1) * 60)).padStart(2, '0')} h`);
const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

async function getJSON(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.json();
}

export function createUI(app) {
  const { terrain, routes, camera, controls, frame, invalidate } = app;
  const state = { region: null, all: [], kind: 'all', q: '', sort: 'near', inView: false, selected: null, profile: null, crawling: false, s2: {} };
  const marker = Object.assign(document.createElement('div'), { id: 'marker' });
  Object.assign(marker.style, { position: 'fixed', width: '14px', height: '14px', margin: '-7px 0 0 -7px', borderRadius: '50%', background: '#ffd23f', border: '2px solid #141414', pointerEvents: 'none', zIndex: 6, display: 'none' });
  document.body.appendChild(marker);
  let markerPos = null;

  // ------------------------------------------------------------ regions
  getJSON('/api/regions').then((list) => {
    $('region-list').innerHTML = list.map((r) => `<option value="${esc(r.name)}">`).join('');
  });
  $('region-form').addEventListener('submit', (e) => { e.preventDefault(); goRegion($('region').value, true); });

  async function goRegion(q, fly) {
    try {
      const region = await getJSON(`/api/region?q=${encodeURIComponent(q || 'Zillertal')}`);
      state.region = region;
      $('region').value = region.name;
      app.setRegion(region, { fly });
      await loadRoutes();
      state.s2 = {};
      refreshS2();
    } catch (e) { $('crawl-status').textContent = `Region not found: ${e.message}`; }
  }

  // ------------------------------------------------------------ routes
  async function loadRoutes() {
    const data = await getJSON(`/api/routes?region=${encodeURIComponent(state.region.name)}`);
    const sel = state.selected?.id;
    state.all = data.routes;
    routes.setRoutes(state.all);
    const srcs = Object.entries(data.sources || {}).map(([k, v]) => `${v.label} ${v.count} (${new Date(v.crawled).toLocaleDateString('de-AT')})`);
    $('crawl-status').textContent = state.all.length ? `${state.all.length} routes cached · ${srcs.join(' · ')}` : 'No routes for this region yet. Search the web to find some.';
    applyFilter();
    if (sel) { const r = state.all.find((x) => x.id === sel); if (r) { state.selected = r; routes.select(r); } }
  }

  function viewCenterLonLat() { return frame.toLonLat(controls.target.x, controls.target.z); }
  function inViewTest() {
    const c = viewCenterLonLat(), radius = Math.max(camera.position.distanceTo(controls.target) * 1.4, 3000);
    return (r) => { const s = r.start; return s && haversine(c, s) < radius; };
  }

  function applyFilter() {
    const q = state.q.trim().toLowerCase();
    const near = state.inView || state.sort === 'near' ? inViewTest() : null;
    let list = state.all.filter((r) => (state.kind === 'all' || r.kind === state.kind) &&
      (!q || [r.name, r.ref, r.from, r.to, r.description, r.network].some((v) => v && String(v).toLowerCase().includes(q))) &&
      (!state.inView || near(r)));
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
    const bySrc = {};
    list.forEach((r) => { bySrc[r.source] = (bySrc[r.source] || 0) + 1; });
    $('count').textContent = `${list.length} routes`;
    $('count').title = Object.entries(bySrc).map(([k, v]) => `${SOURCE_LABEL[k] || k}: ${v}`).join('\n');
    const ul = $('list');
    if (!list.length) { ul.innerHTML = `<li class="empty">${state.all.length ? 'No routes match.' : 'Nothing here yet — press “Search the web for routes”.'}</li>`; return; }
    ul.innerHTML = list.slice(0, 600).map((r, i) => {
      const s = r.stats || {};
      const bits = [KIND_LABEL[r.kind], km(s.length), s.ascent != null ? `↑ ${hm(s.ascent)}${s.descent != null ? ` ↓ ${hm(s.descent)}` : ''}` : null, s.max ? `▲ ${hm(s.max)}` : null, r.difficulty, SOURCE_LABEL[r.source]].filter(Boolean);
      return `<li data-i="${i}"><span class="dot" style="background:${KIND_COLORS[r.kind] || '#999'}"></span><span class="name">${esc(r.name)}${r.ref && !r.name.includes(r.ref) ? ` <span class="muted">${esc(r.ref)}</span>` : ''}</span><span class="meta">${esc(bits.join(' · '))}</span></li>`;
    }).join('');
  }
  $('list').addEventListener('click', (e) => { const li = e.target.closest('li[data-i]'); if (li) select(state.list[li.dataset.i]); });
  $('list').addEventListener('mouseover', (e) => { const li = e.target.closest('li[data-i]'); routes.hover(li ? state.list[li.dataset.i] : null); invalidate(); });
  $('list').addEventListener('mouseleave', () => { routes.hover(null); invalidate(); });

  document.querySelectorAll('#kind-filter button').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('#kind-filter button').forEach((x) => x.classList.toggle('on', x === b));
    state.kind = b.dataset.kind; applyFilter();
  }));
  let qTimer;
  $('q').addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(() => { state.q = $('q').value; applyFilter(); }, 150); });
  $('sort').addEventListener('change', () => { state.sort = $('sort').value; applyFilter(); });
  $('in-view').addEventListener('change', () => { state.inView = $('in-view').checked; applyFilter(); });
  let viewTimer;
  controls.addEventListener('end', () => { if (state.inView || state.sort === 'near') { clearTimeout(viewTimer); viewTimer = setTimeout(applyFilter, 300); } });

  // ------------------------------------------------------------ details
  async function select(r, { fly = true } = {}) {
    state.selected = r; state.profile = null;
    routes.select(r); invalidate();
    if (!r) { $('detail').hidden = true; $('browse').hidden = false; $('crawl-box').hidden = false; return; }
    $('browse').hidden = true; $('crawl-box').hidden = true; $('detail').hidden = false;
    $('d-name').textContent = r.name;
    $('d-badges').innerHTML = [`<span class="chip ${r.kind}">${KIND_LABEL[r.kind] || r.kind}</span>`, `<span class="chip">${SOURCE_LABEL[r.source] || r.source}</span>`,
      r.ref ? `<span class="chip">${esc(r.ref)}</span>` : '', r.network ? `<span class="chip">${esc({ iwn: 'international', nwn: 'national', rwn: 'regional', lwn: 'local' }[r.network] || r.network)}</span>` : '',
      r.difficulty ? `<span class="chip">${esc(r.difficulty)}</span>` : ''].join('');
    renderStats(r.stats || {});
    $('d-desc').textContent = [r.from && r.to ? `${r.from} → ${r.to}` : '', r.description || ''].filter(Boolean).join('. ');
    $('d-img').hidden = !r.image; if (r.image) $('d-img').src = r.image;
    const acts = [`<button id="d-zoom">Zoom to route</button>`, `<a href="${esc(r.url)}" target="_blank" rel="noopener">Open on ${SOURCE_LABEL[r.source] || 'source'} ↗</a>`];
    if (r.website) acts.push(`<a href="${esc(r.website)}" target="_blank" rel="noopener">Website ↗</a>`);
    if (r.lines) acts.push(`<button id="d-gpx">GPX</button>`);
    $('d-actions').innerHTML = acts.join('');
    $('d-zoom').onclick = () => zoomTo(r);
    if (r.lines) $('d-gpx').onclick = () => downloadGpx(r);
    $('profile').hidden = true;
    $('d-profile-note').textContent = r.lines ? 'Measuring the elevation profile on the tiris DGM…' : 'Only the start point is known for this route; the track is on the source page.';
    if (fly) zoomTo(r);
    if (r.lines) {
      try {
        const p = await getJSON('/api/profile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lines: r.lines }) });
        if (state.selected !== r) return;
        state.profile = p;
        renderStats({ ...(r.stats || {}), length: p.length, ascent: p.ascent, descent: p.descent, min: p.min, max: p.max });
        $('profile').hidden = false; $('d-profile-note').textContent = 'Elevation from the Land Tirol laser scan (0.5 m DGM), sampled every 10 m.';
        drawProfile();
      } catch (e) { $('d-profile-note').textContent = `No profile: ${e.message}`; }
    }
  }
  function renderStats(s) {
    const items = [['Length', km(s.length)], ['Ascent', hm(s.ascent)], ['Descent', hm(s.descent)], ['Highest', hm(s.max)], ['Lowest', hm(s.min)], ['Time', hours(s.duration) || '–']];
    $('d-stats').innerHTML = items.map(([k, v]) => `<div><b>${v}</b><span>${k}</span></div>`).join('');
  }
  function zoomTo(r) {
    if (r.lines) app.flyToBounds(routeBounds(r));
    else if (r.start) app.flyTo(app.lookAt(r.start[0], r.start[1], { dist: 3500, pitch: 45, heading: headingNow() }));
  }
  $('back').addEventListener('click', () => { select(null); marker.style.display = 'none'; markerPos = null; });

  function downloadGpx(r) {
    const p = state.profile;
    const pts = p ? [p.coords.map((c, i) => [c[0], c[1], p.e[i]])] : r.lines.map((l) => l.map((c) => [c[0], c[1], null]));
    const seg = (l) => `<trkseg>${l.map(([lon, lat, e]) => `<trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}">${e != null ? `<ele>${e}</ele>` : ''}</trkpt>`).join('')}</trkseg>`;
    const gpx = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="nextmap" xmlns="http://www.topografix.com/GPX/1/1"><metadata><name>${esc(r.name)}</name><link href="${esc(r.url)}"/></metadata><trk><name>${esc(r.name)}</name>${pts.map(seg).join('')}</trk></gpx>`;
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([gpx], { type: 'application/gpx+xml' })), download: `${r.name.replace(/[^\w\-äöüÄÖÜß ]+/g, '').trim() || 'route'}.gpx` });
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  // elevation profile
  const pc = $('profile');
  function drawProfile(hoverI = -1) {
    const p = state.profile; if (!p) return;
    const ctx = pc.getContext('2d'), W = pc.width, H = pc.height, pad = { l: 44, r: 8, t: 10, b: 22 };
    ctx.clearRect(0, 0, W, H);
    const es = p.e.filter((v) => v != null), lo = Math.floor(Math.min(...es) / 100) * 100, hi = Math.ceil(Math.max(...es) / 100) * 100 || lo + 100;
    const X = (d) => pad.l + (d / (p.d[p.d.length - 1] || 1)) * (W - pad.l - pad.r), Y = (e) => H - pad.b - ((e - lo) / (hi - lo)) * (H - pad.t - pad.b);
    ctx.font = '18px system-ui'; ctx.fillStyle = 'rgba(242,241,236,0.6)'; ctx.strokeStyle = 'rgba(255,255,255,0.1)'; ctx.lineWidth = 1;
    const step = (hi - lo) > 1200 ? 500 : (hi - lo) > 500 ? 200 : 100;
    for (let e = lo; e <= hi; e += step) { ctx.beginPath(); ctx.moveTo(pad.l, Y(e)); ctx.lineTo(W - pad.r, Y(e)); ctx.stroke(); ctx.fillText(e, 2, Y(e) + 6); }
    const total = p.d[p.d.length - 1], kstep = total > 20000 ? 5000 : total > 8000 ? 2000 : 1000;
    for (let d = kstep; d < total; d += kstep) ctx.fillText(`${d / 1000}`, X(d) - 5, H - 3);
    ctx.beginPath(); ctx.moveTo(X(0), H - pad.b);
    p.d.forEach((d, i) => { if (p.e[i] != null) ctx.lineTo(X(d), Y(p.e[i])); });
    ctx.lineTo(X(total), H - pad.b); ctx.closePath();
    const col = KIND_COLORS[state.selected?.kind] || '#ff5a2e';
    ctx.fillStyle = col + '55'; ctx.fill();
    ctx.beginPath(); p.d.forEach((d, i) => { if (p.e[i] != null) ctx.lineTo(X(d), Y(p.e[i])); }); ctx.strokeStyle = col; ctx.lineWidth = 3; ctx.stroke();
    if (hoverI >= 0) {
      const x = X(p.d[hoverI]);
      ctx.strokeStyle = '#ffd23f'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, H - pad.b); ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.font = 'bold 20px system-ui';
      const label = `${(p.d[hoverI] / 1000).toFixed(1)} km · ${Math.round(p.e[hoverI])} m`;
      ctx.fillText(label, Math.min(x + 6, W - ctx.measureText(label).width - 4), pad.t + 18);
    }
  }
  pc.addEventListener('mousemove', (e) => {
    const p = state.profile; if (!p) return;
    const r = pc.getBoundingClientRect(), x = ((e.clientX - r.left) / r.width) * pc.width;
    const total = p.d[p.d.length - 1], d = ((x - 44) / (pc.width - 52)) * total;
    let i = 0; while (i < p.d.length - 1 && p.d[i] < d) i++;
    drawProfile(i);
    const [lon, lat] = p.coords[i], [wx, wz] = frame.fromLonLat(lon, lat);
    markerPos = new THREE.Vector3(wx, p.e[i] ?? terrain.heightAt(wx, wz) ?? 0, wz);
    invalidate();
  });
  pc.addEventListener('mouseleave', () => { drawProfile(); markerPos = null; marker.style.display = 'none'; invalidate(); });

  // ------------------------------------------------------------ crawler
  getJSON('/api/sources').then((list) => {
    $('crawl-sources').innerHTML = list.map((s) => `<label><input type="checkbox" value="${s.id}" checked> ${esc(s.label)}</label>`).join('');
  });
  $('crawl-toggle').addEventListener('click', () => { $('crawl-more').hidden = !$('crawl-more').hidden; $('crawl-log').hidden = $('crawl-more').hidden; });
  $('crawl').addEventListener('click', async () => {
    const sources = [...document.querySelectorAll('#crawl-sources input:checked')].map((i) => i.value);
    await getJSON('/api/crawl', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ region: state.region?.name || $('region').value, sources }) });
    pollCrawl();
  });
  let lastReload = 0;
  async function pollCrawl() {
    const s = await getJSON('/api/crawl').catch(() => null);
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
      state.s2[key] = getJSON(`/api/s2/${season}?region=${encodeURIComponent(state.region.name)}`).catch((e) => ({ error: e.message }));
    }
    const s = await state.s2[key];
    if (terrain.settings.season !== season) return;
    if (s.error || s.none) { $('s2-info').textContent = `No Sentinel-2 scene: ${s.error || 'none in ' + s.window?.join(' – ')}`; delete state.s2[key]; return; }
    terrain.setS2Scene(season, s.searchid);
    $('s2-info').textContent = `Sentinel-2 ${new Date(s.date).toLocaleDateString('de-AT', { day: 'numeric', month: 'short', year: 'numeric' })} · ${Math.round(s.cloud)}% cloud${season === 'winter' && !st.satellite ? ' · snow on the orthophoto' : ''}`;
    invalidate();
  }
  document.querySelectorAll('#season button').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('#season button').forEach((x) => x.classList.toggle('on', x === b));
    terrain.set({ season: b.dataset.season });
    refreshS2(); invalidate();
  }));
  $('imagery').addEventListener('change', () => {
    const v = $('imagery').value;
    terrain.set(v === 's2' ? { satellite: true } : { satellite: false, imagery: v });
    refreshS2(); invalidate();
  });
  $('l-routes').addEventListener('change', () => { routes.visible = $('l-routes').checked; invalidate(); });
  $('l-slope').addEventListener('change', () => { terrain.set({ slope: $('l-slope').checked ? 0.6 : 0 }); $('slope-legend').hidden = !$('l-slope').checked; invalidate(); });
  $('l-contours').addEventListener('change', () => { terrain.set({ contours: $('l-contours').checked ? 0.8 : 0 }); invalidate(); });
  document.querySelectorAll('[data-tiris]').forEach((c) => c.addEventListener('change', () => {
    terrain.set({ tiris: [...document.querySelectorAll('[data-tiris]:checked')].map((x) => x.dataset.tiris) }); invalidate();
  }));
  $('sun').addEventListener('input', () => app.setSun($('sun').value / 100));

  const headingNow = () => { const d = new THREE.Vector3().subVectors(controls.target, camera.position); return (Math.atan2(d.x, -d.z) * 180) / Math.PI; };
  $('compass').addEventListener('click', () => {
    const d = camera.position.distanceTo(controls.target), pitch = Math.asin((camera.position.y - controls.target.y) / d) * 180 / Math.PI;
    const [lon, lat] = frame.toLonLat(controls.target.x, controls.target.z);
    app.flyTo(app.lookAt(lon, lat, { dist: d, pitch, heading: 0 }), 900);
  });

  // ------------------------------------------------------------ map pointer
  const tip = $('tooltip');
  let down = null, pending = null;
  const canvas = app.renderer.domElement;
  canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
  canvas.addEventListener('pointerup', (e) => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5 || performance.now() - down.t > 500) return;
    const p = app.pickAt(e.clientX, e.clientY);
    if (p?.route) { select(p.route, { fly: false }); }
  });
  canvas.addEventListener('pointermove', (e) => { pending = e; if (e.buttons) tip.hidden = true; });
  canvas.addEventListener('pointerleave', () => { pending = null; tip.hidden = true; });

  function updateCursor() {
    const e = pending; pending = null;
    if (!e || e.buttons) return;
    const p = app.pickAt(e.clientX, e.clientY);
    if (!p) { $('cursor').textContent = ''; tip.hidden = true; return; }
    const { slope, aspect } = terrain.slopeAt(p.hit.x, p.hit.z);
    $('cursor').textContent = `${p.lat.toFixed(5)} N  ${p.lon.toFixed(5)} E  ·  ${Math.round(p.hit.y)} m  ·  ${slope.toFixed(0)}° ${DIRS[Math.round(aspect / 45) % 8]}`;
    if (p.route !== routes.hovered) { routes.hover(p.route); invalidate(); }
    tip.hidden = !p.route;
    if (p.route) { tip.textContent = `${p.route.name} · ${KIND_LABEL[p.route.kind] || ''}`; tip.style.left = `${e.clientX}px`; tip.style.top = `${e.clientY}px`; }
    canvas.style.cursor = p.route ? 'pointer' : '';
  }
  setInterval(updateCursor, 60);

  // ------------------------------------------------------------ per frame
  const v = new THREE.Vector3();
  function frameUpdate() {
    const d = new THREE.Vector3().subVectors(controls.target, camera.position);
    $('compass').firstElementChild.style.transform = `rotate(${-Math.atan2(d.x, -d.z) * 180 / Math.PI}deg)`;
    const n = terrain.loading + Object.values(terrain.active || {}).reduce((a, b) => a + b, 0);
    $('loading').textContent = n ? `Loading terrain… ${n}` : '';
    if (markerPos) {
      v.copy(markerPos).project(camera);
      const r = canvas.getBoundingClientRect();
      marker.style.display = v.z < 1 ? 'block' : 'none';
      marker.style.left = `${r.left + (v.x * 0.5 + 0.5) * r.width}px`; marker.style.top = `${r.top + (-v.y * 0.5 + 0.5) * r.height}px`;
    }
  }

  goRegion('Zillertal', false);
  return { frame: frameUpdate, busy: () => false };
}
