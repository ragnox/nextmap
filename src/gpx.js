// GPX in and out: a track as nextmap writes it, the points of any GPX file, and saving a file from the browser.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// lines of [lon, lat, ele or null], one track segment each
export function gpxText(name, lines, url) {
  const seg = (l) => `<trkseg>${l.map(([lon, lat, e]) => `<trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}">${e != null ? `<ele>${e}</ele>` : ''}</trkpt>`).join('')}</trkseg>`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="nextmap" xmlns="http://www.topografix.com/GPX/1/1"><metadata><name>${esc(name)}</name>${url ? `<link href="${esc(url)}"/>` : ''}</metadata><trk><name>${esc(name)}</name>${lines.map(seg).join('')}</trk></gpx>`;
}

// every track or route point of a GPX file, in order, as [lon, lat]; and the file's name for it
export function gpxPoints(text) {
  return [...text.matchAll(/<(?:trkpt|rtept)\b[^>]*>/g)]
    .map(([t]) => [Number(t.match(/lon=["']([-\d.]+)["']/)?.[1]), Number(t.match(/lat=["']([-\d.]+)["']/)?.[1])])
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && (a || b));
}
const ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unesc = (s) => s.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITY[e] ?? m));
export const gpxName = (text) => unesc((text.match(/<(?:trk|rte|metadata)>\s*<name>([^<]*)<\/name>/)?.[1] || '').trim());

export const fileName = (name) => `${String(name).replace(/[^\w\-äöüÄÖÜß ]+/g, '').trim() || 'route'}.gpx`;
export function saveFile(name, text, type = 'application/gpx+xml') {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
