// The side panel (region, crawler, route list and details), the layer panel and the status line.
import * as THREE from 'three';
import { KIND_COLORS, routeBounds } from './routes.js';
import { haversine } from './geo.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const KIND_LABEL = { hike: 'Hiking', bikehike: 'Bike & Hike', mtb: 'Mountain bike', emtb: 'eMTB', skitour: 'Ski touring', freeride: 'Freeride', snowshoe: 'Snowshoe' };
const SOURCE_LABEL = { osm: 'OpenStreetMap', bergfex: 'bergfex', combined: 'combined' };
const km = (m) => (m == null ? '–' : m >= 10000 ? `${(m / 1000).toFixed(0)} km` : `${(m / 1000).toFixed(1)} km`);
const hm = (m) => (m == null ? '–' : `${Math.round(m).toLocaleString('de-AT')} m`);
const hours = (h) => (h == null ? null : `${Math.floor(h)}:${String(Math.round((h % 1) * 60)).padStart(2, '0')} h`);
const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const clock = (t) => new Date(t).toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' });


export function createUI(app) {
  const { terrain, routes, camera, controls, frame, invalidate, backend } = app;
  const local = backend.mode === 'server';            // crawler, bergfex and GPX uploads need the local server
  document.body.classList.toggle('static-site', !local);
  const state = { region: null, all: [], kind: 'all', q: '', sort: 'near', inView: false, selected: null, profile: null, crawling: false, s2: {} };
  const marker = Object.assign(document.createElement('div'), { id: 'marker' });
  Object.assign(marker.style, { position: 'fixed', width: '14px', height: '14px', margin: '-7px 0 0 -7px', borderRadius: '50%', background: '#ffd23f', border: '2px solid #141414', pointerEvents: 'none', zIndex: 6, display: 'none' });
  document.body.appendChild(marker);
  let markerPos = null;

  // ------------------------------------------------------------ regions
  backend.regions().then((list) => {
    $('region-list').innerHTML = list.map((r) => `<option value="${esc(r.name)}">`).join('');
  });
  $('region-form').addEventListener('submit', (e) => { e.preventDefault(); goRegion($('region').value, true); });

  async function goRegion(q, fly) {
    try {
      const region = await backend.region(q || 'Zillertal');
      state.region = region;
      $('region').value = region.name;
      app.setRegion(region, { fly });
      const data = await loadRoutes();
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
    const pts = [...text.matchAll(/<(?:trkpt|rtept)\b[^>]*>/g)].map(([t]) => [Number(t.match(/lon="([-\d.]+)"/)?.[1]), Number(t.match(/lat="([-\d.]+)"/)?.[1])]).filter(([a, b]) => a && b);
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
  $('side').addEventListener('dragover', (e) => { if (local && state.selected && e.dataTransfer.types.includes('Files')) { e.preventDefault(); $('detail').classList.add('drop'); } });
  $('side').addEventListener('dragleave', () => $('detail').classList.remove('drop'));
  $('side').addEventListener('drop', (e) => {
    $('detail').classList.remove('drop');
    if (!state.selected || !e.dataTransfer.files.length) return;
    e.preventDefault();
    attachFile(e.dataTransfer.files[0]);
  });

  function renderActions(r) {
    const acts = [`<button id="d-zoom">Zoom to route</button>`];
    if (r.kind === 'bikehike' && Array.isArray(r.parts)) for (const p of r.parts) acts.push(`<a href="${esc(p.url)}" target="_blank" rel="noopener" title="${esc(p.name)}">${p.role === 'bike' ? 'Bike route' : 'Hiking route'} on ${SOURCE_LABEL[p.source] || 'source'} ↗</a>`);
    else acts.push(`<a href="${esc(r.url)}" target="_blank" rel="noopener">Open on ${SOURCE_LABEL[r.source] || 'source'} ↗</a>`);
    if (r.website) acts.push(`<a href="${esc(r.website)}" target="_blank" rel="noopener">Website ↗</a>`);
    if (r.lines) acts.push(`<button id="d-gpx">GPX</button>`);
    const bf = r.id.match(/^bergfex-(\d+)$/);
    if (bf) acts.push(`<a href="https://www.bergfex.at/downloads/gps/?id=${bf[1]}&amp;fileType=gpx" target="_blank" rel="noopener">GPX on bergfex ↗</a>`);
    if (local && (!r.lines || r.source === 'bergfex')) acts.push(`<button id="d-attach" title="Use a GPX file you downloaded as this route's track (or drop it on this panel)">Attach GPX…</button>`);
    $('d-actions').innerHTML = acts.join('');
    $('d-attach')?.addEventListener('click', () => gpxInput.click());
    $('d-zoom').onclick = () => zoomTo(r);
    if (r.lines) $('d-gpx').onclick = () => downloadGpx(r);
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
  backend.sources().then((list) => {
    $('crawl-sources').innerHTML = list.map((s) => `<label><input type="checkbox" value="${s.id}" checked> ${esc(s.label)}</label>`).join('');
  });
  $('crawl-toggle').addEventListener('click', () => { $('crawl-more').hidden = !$('crawl-more').hidden; $('crawl-log').hidden = $('crawl-more').hidden; });
  async function startCrawl(sources) {
    state.crawling = true;
    await backend.startCrawl(state.region?.name || $('region').value, sources);
    pollCrawl();
  }
  $('crawl').addEventListener('click', () => startCrawl([...document.querySelectorAll('#crawl-sources input:checked')].map((i) => i.value)));
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

  // phones: the layer panel opens from a button, the side panel is a bottom sheet that expands from its header
  $('layers-btn').addEventListener('click', () => {
    const open = $('layers').classList.toggle('open');
    $('layers-btn').setAttribute('aria-expanded', open);
  });
  document.querySelector('#side > header').addEventListener('click', (e) => {
    if (window.innerWidth > 760 || e.target.closest('form')) return;
    $('side').classList.toggle('expanded');
  });
  $('side').addEventListener('transitionend', () => window.dispatchEvent(new Event('resize')));

  const headingNow = () => (controls.heading * 180) / Math.PI;

  // navigation buttons and the help card
  const nav = { 'zoom-in': () => controls.zoomStep(1), 'zoom-out': () => controls.zoomStep(-1), tilt: () => controls.toggleTilt(), compass: () => controls.northUp(), 'help-btn': () => toggleHelp() };
  for (const [id, fn] of Object.entries(nav)) $(id).addEventListener('click', () => { fn(); invalidate(); });
  const toggleHelp = (show = $('help').hidden) => { $('help').hidden = !show; };
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

  goRegion('Zillertal', false);
  return { frame: frameUpdate, busy: () => false };
}
