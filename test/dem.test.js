import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTiff, decodeTerrarium } from '../shared/dem.js';

// a little-endian tiled float32 GeoTIFF of 4 x 2 pixels in two 2 x 2 tiles, the second one empty (no bytes)
function tinyTiff() {
  const entries = [[256, 3, 1, 4], [257, 3, 1, 2], [258, 3, 1, 32], [259, 3, 1, 1], [277, 3, 1, 1], [339, 3, 1, 3],
    [322, 3, 1, 2], [323, 3, 1, 2], [324, 4, 2, 'offs'], [325, 4, 2, 'counts'], [33550, 12, 3, 'scale'], [33922, 12, 6, 'tie']];
  const ifdAt = 8, dataAt = ifdAt + 2 + entries.length * 12 + 4;
  const extra = { offs: dataAt, counts: dataAt + 8, scale: dataAt + 16, tie: dataAt + 40, pixels: dataAt + 88 };
  const buf = new ArrayBuffer(extra.pixels + 16), dv = new DataView(buf);
  dv.setUint16(0, 0x4949); dv.setUint16(2, 42, true); dv.setUint32(4, ifdAt, true); dv.setUint16(ifdAt, entries.length, true);
  entries.forEach(([tag, type, n, v], i) => {
    const o = ifdAt + 2 + i * 12;
    dv.setUint16(o, tag, true); dv.setUint16(o + 2, type, true); dv.setUint32(o + 4, n, true);
    if (typeof v === 'number') type === 3 ? dv.setUint16(o + 8, v, true) : dv.setUint32(o + 8, v, true); else dv.setUint32(o + 8, extra[v], true);
  });
  dv.setUint32(extra.offs, extra.pixels, true); dv.setUint32(extra.offs + 4, 0, true);
  dv.setUint32(extra.counts, 16, true); dv.setUint32(extra.counts + 4, 0, true);
  [0.5, 0.25, 0].forEach((v, k) => dv.setFloat64(extra.scale + k * 8, v, true));
  [0, 0, 0, 11.8, 47.2, 0].forEach((v, k) => dv.setFloat64(extra.tie + k * 8, v, true));
  [1000, 1001, 1002, 1003].forEach((v, k) => dv.setFloat32(extra.pixels + k * 4, v, true));
  return buf;
}

test('TIFF reader: georeferencing, tiles, empty blocks', () => {
  const g = parseTiff(tinyTiff());
  assert.deepEqual([g.W, g.H, g.ox, g.oy, g.rx, g.ry], [4, 2, 11.8, 47.2, 0.5, -0.25]);
  assert.deepEqual([...g.data.slice(0, 2), ...g.data.slice(4, 6)], [1000, 1001, 1002, 1003]);
  assert.ok(Number.isNaN(g.data[2]) && Number.isNaN(g.data[7]), 'the empty block reads as no data');
  const notFloat = tinyTiff(); new DataView(notFloat).setUint16(8 + 2 + 5 * 12 + 8, 1, true);   // SampleFormat: integer
  assert.equal(parseTiff(notFloat), null);
});

test('Terrarium pixels to metres', () => {
  const px = new Uint8Array(256 * 256 * 4);
  px.set([128, 0, 0, 255], 0);          // 0 m
  px.set([130, 140, 128, 255], 4);      // 512 + 140 + 0.5 = 652.5 m
  const h = decodeTerrarium(px);
  assert.equal(h[0], 0); assert.equal(h[1], 652.5);
});
