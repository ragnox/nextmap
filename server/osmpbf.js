// A small reader for OpenStreetMap PBF files (the Geofabrik extracts): the header, nodes (dense or plain) and ways,
// without relations. Blobs are inflated a few at a time on libuv's threads while the previous ones are parsed, and
// handed over in file order, so a sorted extract arrives sorted (all nodes by id, then all ways).
//   await readPbf(file, { header(h), nodes(ids, lons, lats, n), way(id, refs, tags), wayKey })
// Coordinates come in 1e-7 degrees (Int32Array), ids as plain numbers (exact up to 2^53). With `wayKey`, only ways
// that carry that key are decoded, and blocks whose string table lacks it are skipped whole.
import fs from 'node:fs/promises';
import zlib from 'node:zlib';
import { promisify } from 'node:util';

const inflate = promisify(zlib.inflate);
const AHEAD = 6;

// ---------------------------------------------------------------- protobuf basics
class Reader {
  constructor(buf, pos = 0, end = buf.length) { this.buf = buf; this.pos = pos; this.end = end; }
  more() { return this.pos < this.end; }
  varint() {
    const buf = this.buf;
    let b = buf[this.pos++], v = b & 0x7f;
    if (b < 0x80) return v;
    b = buf[this.pos++]; v |= (b & 0x7f) << 7; if (b < 0x80) return v;
    b = buf[this.pos++]; v |= (b & 0x7f) << 14; if (b < 0x80) return v;
    b = buf[this.pos++]; v |= (b & 0x7f) << 21; if (b < 0x80) return v;
    // past 28 bits: plain arithmetic (int64 values up to 2^53; negative int64 is not used by these fields)
    let m = 268435456;
    do { b = buf[this.pos++]; v += (b & 0x7f) * m; m *= 128; } while (b >= 0x80);
    return v;
  }
  svarint() { const n = this.varint(); return n <= 0x7fffffff ? (n >>> 1) ^ -(n & 1) : n % 2 ? -(n + 1) / 2 : n / 2; }
  // [field, wire type]
  tag() { const t = this.varint(); return [t >>> 3, t & 7]; }
  bytes() { const n = this.varint(), at = this.pos; this.pos += n; return [at, this.pos]; }
  string() { const [a, b] = this.bytes(); return Buffer.from(this.buf.buffer, this.buf.byteOffset + a, b - a).toString('utf8'); }
  skip(wire) {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) { const n = this.varint(); this.pos += n; }   // not pos += varint(): that reads pos first
    else if (wire === 5) this.pos += 4;
    else throw new Error(`pbf: wire type ${wire}`);
  }
  // a packed field read into `into` (grown when needed); returns [array, count]
  packed(into, signed, delta) {
    const [a, b] = this.bytes(), r = new Reader(this.buf, a, b);
    let n = 0, acc = 0;
    while (r.more()) {
      const v = signed ? r.svarint() : r.varint();
      if (n === into.length) { const g = new into.constructor(into.length * 2 || 1024); g.set(into); into = g; }
      into[n++] = delta ? (acc += v) : v;
    }
    return [into, n];
  }
}

// ---------------------------------------------------------------- blocks
function parseHeader(buf) {
  const r = new Reader(buf), h = { required: [], optional: [], bbox: null, timestamp: null, writer: null };
  while (r.more()) {
    const [f, w] = r.tag();
    if (f === 4) h.required.push(r.string());
    else if (f === 5) h.optional.push(r.string());
    else if (f === 16) h.writer = r.string();
    else if (f === 32) h.timestamp = new Date(r.varint() * 1000).toISOString();
    else if (f === 1) {
      const [a, b] = r.bytes(), q = new Reader(buf, a, b), v = {};
      while (q.more()) { const [g] = q.tag(); v[g] = q.svarint() / 1e9; }
      h.bbox = [v[1], v[4], v[2], v[3]];                    // left, bottom, right, top
    } else r.skip(w);
  }
  return h;
}

// scratch arrays reused from block to block
let ids = new Float64Array(8192), lats = new Int32Array(8192), lons = new Int32Array(8192), refs = new Float64Array(2048);
let keys = new Uint32Array(64), vals = new Uint32Array(64), kv = new Int32Array(1024);

function parseBlock(buf, opt) {
  const r = new Reader(buf), groups = [];
  let strings = [], gran = 100, latOff = 0, lonOff = 0;
  while (r.more()) {
    const [f, w] = r.tag();
    if (f === 1) {
      const [a, b] = r.bytes(), q = new Reader(buf, a, b);
      while (q.more()) { const [g, gw] = q.tag(); if (g === 1) strings.push(q.string()); else q.skip(gw); }
    } else if (f === 2) groups.push(r.bytes());
    else if (f === 17) gran = r.varint();
    else if (f === 19) latOff = r.varint();
    else if (f === 20) lonOff = r.varint();
    else r.skip(w);
  }
  // 1e-9 degrees = offset + granularity * value; the callers get 1e-7
  const deg7 = gran === 100 && !latOff && !lonOff ? null : (v, off) => Math.round((off + gran * v) / 100);
  const wayKey = opt.wayKey ? strings.indexOf(opt.wayKey) : -1;
  for (const [a, b] of groups) {
    const g = new Reader(buf, a, b);
    while (g.more()) {
      const [f, w] = g.tag();
      if (f === 2 && opt.nodes) dense(buf, g.bytes(), deg7, latOff, lonOff, opt.nodes);
      else if (f === 1 && opt.nodes) plainNode(buf, g.bytes(), deg7, latOff, lonOff, opt.nodes);
      else if (f === 3 && opt.way && !(opt.wayKey && wayKey < 0)) way(buf, g.bytes(), strings, wayKey, opt.way);
      else g.skip(w);
    }
  }
}

function dense(buf, [a, b], deg7, latOff, lonOff, cb) {
  const r = new Reader(buf, a, b);
  let n = 0;
  while (r.more()) {
    const [f, w] = r.tag();
    if (f === 1) [ids, n] = r.packed(ids, true, true);
    else if (f === 8) { let m; [lats, m] = r.packed(lats, true, true); }
    else if (f === 9) { let m; [lons, m] = r.packed(lons, true, true); }
    else r.skip(w);
  }
  if (deg7) for (let i = 0; i < n; i++) { lats[i] = deg7(lats[i], latOff); lons[i] = deg7(lons[i], lonOff); }
  cb(ids, lons, lats, n);
}

function plainNode(buf, [a, b], deg7, latOff, lonOff, cb) {
  const r = new Reader(buf, a, b);
  let id = 0, lat = 0, lon = 0;
  while (r.more()) {
    const [f, w] = r.tag();
    if (f === 1) id = r.svarint();
    else if (f === 8) lat = r.svarint();
    else if (f === 9) lon = r.svarint();
    else r.skip(w);
  }
  ids[0] = id; lats[0] = deg7 ? deg7(lat, latOff) : lat; lons[0] = deg7 ? deg7(lon, lonOff) : lon;
  cb(ids, lons, lats, 1);
}

function way(buf, [a, b], strings, wayKey, cb) {
  const r = new Reader(buf, a, b);
  let id = 0, nk = 0, nv = 0, nr = 0;
  while (r.more()) {
    const [f, w] = r.tag();
    if (f === 1) id = r.varint();
    else if (f === 2) [keys, nk] = r.packed(keys, false, false);
    else if (f === 3) [vals, nv] = r.packed(vals, false, false);
    else if (f === 8) [refs, nr] = r.packed(refs, true, true);
    else r.skip(w);
  }
  if (wayKey >= 0) { let has = false; for (let i = 0; i < nk; i++) if (keys[i] === wayKey) { has = true; break; } if (!has) return; }
  const tags = {};
  for (let i = 0; i < Math.min(nk, nv); i++) tags[strings[keys[i]]] = strings[vals[i]];
  cb(id, refs.subarray(0, nr), tags);
}

// ---------------------------------------------------------------- the file
async function* blobs(file) {
  const fh = await fs.open(file);
  try {
    const len = Buffer.alloc(4);
    for (let pos = 0; ;) {
      if ((await fh.read(len, 0, 4, pos)).bytesRead < 4) return;
      const hl = len.readUInt32BE(0), hb = Buffer.alloc(hl);
      await fh.read(hb, 0, hl, pos + 4);
      const hr = new Reader(hb);
      let type = '', size = 0;
      while (hr.more()) { const [f, w] = hr.tag(); if (f === 1) type = hr.string(); else if (f === 3) size = hr.varint(); else hr.skip(w); }
      const body = Buffer.alloc(size);
      await fh.read(body, 0, size, pos + 4 + hl);
      pos += 4 + hl + size;
      yield { type, body, pos };
    }
  } finally { await fh.close(); }
}

async function unpack(body) {
  const r = new Reader(body);
  while (r.more()) {
    const [f, w] = r.tag();
    if (f === 1) { const [a, b] = r.bytes(); return body.subarray(a, b); }
    if (f === 3) { const [a, b] = r.bytes(); return inflate(body.subarray(a, b)); }
    if (f === 4 || f === 6 || f === 7) throw new Error('pbf: only zlib-compressed blobs are supported');
    r.skip(w);
  }
  return Buffer.alloc(0);
}

export async function readPbf(file, opt = {}) {
  const queue = [];
  let header = null, bytes = 0;
  const take = async () => {
    const { type, data, pos } = queue.shift();
    const buf = await data;
    if (type === 'OSMHeader') {
      header = parseHeader(buf);
      const unknown = header.required.filter((f) => !['OsmSchema-V0.6', 'DenseNodes'].includes(f));
      if (unknown.length) throw new Error(`pbf: needs ${unknown.join(', ')}`);
      opt.header?.(header);
    } else if (type === 'OSMData') parseBlock(buf, opt);
    bytes = pos;
    opt.progress?.(bytes);
  };
  for await (const { type, body, pos } of blobs(file)) {
    queue.push({ type, data: unpack(body), pos });
    if (queue.length >= AHEAD) await take();
  }
  while (queue.length) await take();
  return header;
}
