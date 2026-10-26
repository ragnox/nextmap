// Draws the app icons (the yellow mountain on dark) for the home screen: node scripts/icons.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
const BG = [18, 22, 27], MOUNTAIN = [255, 210, 63], SNOW = [255, 255, 255];
// in a unit square: the mountain (two peaks) and the snow on the higher one
const PEAKS = [[0.12, 0.78], [0.42, 0.26], [0.58, 0.5], [0.7, 0.38], [0.9, 0.78]];
const CAP = [[0.42, 0.26], [0.51, 0.42], [0.46, 0.39], [0.42, 0.44], [0.38, 0.39], [0.34, 0.39]];
const inside = (x, y, poly) => {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
};

function icon(size, { padding = 0, round = true } = {}) {
  const png = new PNG({ width: size, height: size });
  const ss = 4, r = size * 0.22;
  for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) {
    let acc = [0, 0, 0], alpha = 0;
    for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
      const x = px + (sx + 0.5) / ss, y = py + (sy + 0.5) / ss;
      // rounded square
      const dx = Math.max(r - x, 0, x - (size - r)), dy = Math.max(r - y, 0, y - (size - r));
      if (round && dx * dx + dy * dy > r * r) continue;
      const u = (x / size - padding) / (1 - 2 * padding), v = (y / size - padding) / (1 - 2 * padding);
      const col = inside(u, v, CAP) ? SNOW : inside(u, v, PEAKS) ? MOUNTAIN : BG;
      acc = acc.map((a, i) => a + col[i]); alpha++;
    }
    const o = (py * size + px) * 4, n = ss * ss;
    png.data[o] = alpha ? acc[0] / alpha : 0; png.data[o + 1] = alpha ? acc[1] / alpha : 0; png.data[o + 2] = alpha ? acc[2] / alpha : 0;
    png.data[o + 3] = Math.round((alpha / n) * 255);
  }
  return PNG.sync.write(png);
}

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'icon-192.png'), icon(192));
fs.writeFileSync(path.join(OUT, 'icon-512.png'), icon(512));
fs.writeFileSync(path.join(OUT, 'maskable-512.png'), icon(512, { padding: 0.12, round: false }));
fs.writeFileSync(path.join(OUT, 'apple-touch-icon.png'), icon(180, { round: false }));
console.log('icons in public/icons');
