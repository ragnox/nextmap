// Lines and elevation profiles on the server: the shared geometry, sampled on the server's DEM tiles.
import { buildProfile } from '../shared/geo.js';
import { sampleElevations } from './dem.js';

export { haversine, lineLength, densify, simplify, climb } from '../shared/geo.js';

export function profile(lines, { z = 14, step = 15, maxPts = 4000 } = {}) {
  return buildProfile(lines, (pts) => sampleElevations(z, pts), { step, maxPts });
}
