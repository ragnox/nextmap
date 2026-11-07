// The map's state in the address bar, so every view is a link:
//   ?region=Zillertal&camera=47.16300,11.86400,2350,200,-42&season=winter&imagery=tiris&style=hybrid
//    &layers=slope,contours,bergwege&kind=skitour&route=osm-r123&sun=60
// camera is where the camera stands: latitude, longitude, altitude (m), heading and pitch (degrees).
// A route being planned comes as plan=<points> (shared/plan.js) and pname=<its name>.
// Defaults (summer, basemap.at, satellite, routes on, all kinds, sun 45) are left out.
export const LAYERS = ['slope', 'contours', 'bergwege', 'wildschutz', 'lifte'];

export function parseState(search) {
  const q = new URLSearchParams(search);
  const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  const cam = (q.get('camera') || '').split(',').map(num);
  const layers = (q.get('layers') || '').split(',').filter(Boolean);
  return {
    region: q.get('region') || null,
    camera: cam.length === 5 && cam.every((v) => v !== null) ? { lat: cam[0], lon: cam[1], alt: cam[2], heading: cam[3], pitch: cam[4] } : null,
    season: q.get('season') === 'winter' ? 'winter' : 'summer',
    imagery: ['tiris', 's2'].includes(q.get('imagery')) ? q.get('imagery') : 'ortho',
    hybrid: q.get('style') === 'hybrid',
    layers: layers.filter((l) => LAYERS.includes(l)),
    routes: !layers.includes('noroutes'),
    kind: q.get('kind') || 'all',
    route: q.get('route') || null,
    sun: num(q.get('sun')) ?? 45,
    plan: q.get('plan') || null,
    pname: q.get('pname') || null,
  };
}

export function stateQuery(st) {
  const q = new URLSearchParams();
  if (st.region) q.set('region', st.region);
  if (st.camera) {
    const c = st.camera, h = ((c.heading % 360) + 360) % 360;
    q.set('camera', [c.lat.toFixed(5), c.lon.toFixed(5), Math.round(c.alt), h.toFixed(1), c.pitch.toFixed(1)].join(','));
  }
  if (st.season === 'winter') q.set('season', 'winter');
  if (st.imagery && st.imagery !== 'ortho') q.set('imagery', st.imagery);
  if (st.hybrid) q.set('style', 'hybrid');
  const layers = [...(st.layers || []), ...(st.routes === false ? ['noroutes'] : [])];
  if (layers.length) q.set('layers', layers.join(','));
  if (st.kind && st.kind !== 'all') q.set('kind', st.kind);
  if (st.route) q.set('route', st.route);
  if (st.sun != null && Math.round(st.sun) !== 45) q.set('sun', Math.round(st.sun));
  if (st.plan) { q.set('plan', st.plan); if (st.pname) q.set('pname', st.pname); }
  // keep commas readable
  return q.toString().replace(/%2C/g, ',');
}
