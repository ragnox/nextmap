// Coordinates: lon/lat <-> Web Mercator metres <-> the local three.js world (metres, y up, north = -z), centred on
// an origin and scaled by cos(latitude) so distances and heights are true metres around the region.
export const R = 6378137;
export const HALF = Math.PI * R;
export const tileSize = (z) => (2 * HALF) / 2 ** z;
export const lonToX = (lon) => (lon * Math.PI / 180) * R;
export const latToY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI / 180) / 2)) * R;
export const xToLon = (x) => (x / R) * 180 / Math.PI;
export const yToLat = (y) => (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180 / Math.PI;

export class Frame {
  constructor(lon, lat) { this.set(lon, lat); }
  set(lon, lat) {
    this.lon0 = lon; this.lat0 = lat;
    this.ox = lonToX(lon); this.oy = latToY(lat);
    this.k = Math.cos(lat * Math.PI / 180);
  }
  // Mercator metres -> world x, z
  mx(mx) { return (mx - this.ox) * this.k; }
  mz(my) { return (this.oy - my) * this.k; }
  fromLonLat(lon, lat) { return [this.mx(lonToX(lon)), this.mz(latToY(lat))]; }
  toLonLat(x, z) { return [xToLon(x / this.k + this.ox), yToLat(this.oy - z / this.k)]; }
  // tile z/x/y -> world rectangle: west x, north z, size
  tileRect(z, x, y) {
    const s = tileSize(z);
    return [this.mx(-HALF + x * s), this.mz(HALF - y * s), s * this.k];
  }
  tileAt(z, wx, wz) {
    const s = tileSize(z), mx = wx / this.k + this.ox, my = this.oy - wz / this.k;
    return [Math.floor((mx + HALF) / s), Math.floor((HALF - my) / s)];
  }
}

export const EARTH_R = 6371000;
export const RAD = Math.PI / 180;
export function haversine(a, b) {
  const dLat = (b[1] - a[1]) * RAD, dLon = (b[0] - a[0]) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371008 * Math.asin(Math.sqrt(h));
}
