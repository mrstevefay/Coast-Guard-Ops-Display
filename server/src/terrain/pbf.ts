/**
 * Streaming reader for OpenStreetMap PBF extracts (https://wiki.openstreetmap.org/wiki/PBF_Format),
 * just enough to pull the ways and multipolygon relations inside a box without Overpass.
 *
 * Two passes over the file, one blob in memory at a time:
 *   1. relations: which ways are members of a wanted multipolygon;
 *   2. nodes inside the box (plus a margin, so lines run past the grid edge), then ways (wanted,
 *      or relation members) and relations, each handed to `onWay` / `onRelation` as it is built.
 */
import fs from 'node:fs';
import { inflateSync } from 'node:zlib';

export interface LatLon { lat: number; lon: number }
export interface PbfWay { id: number; tags: Record<string, string>; geometry: LatLon[] }
export interface PbfRelation { id: number; tags: Record<string, string>; members: { type: 'way'; role: string; geometry: LatLon[] }[] }

export interface PbfOptions {
  bbox: [number, number, number, number];
  /** Degrees added round the box for node collection. */
  margin?: number;
  wantWay: (tags: Record<string, string>) => boolean;
  wantRelation: (tags: Record<string, string>) => boolean;
  onWay: (w: PbfWay) => void;
  onRelation: (r: PbfRelation) => void;
  onProgress?: (pass: 1 | 2, fraction: number) => void;
}

class Reader {
  pos = 0;
  constructor(readonly buf: Uint8Array, start = 0, readonly end = buf.length) { this.pos = start; }
  get done(): boolean { return this.pos >= this.end; }
  varint(): number {
    let result = 0, mul = 1, b: number;
    do {
      b = this.buf[this.pos++];
      result += (b & 0x7f) * mul;
      mul *= 128;
    } while (b & 0x80);
    return result;
  }
  svarint(): number {
    const n = this.varint();
    return n % 2 === 1 ? -(n + 1) / 2 : n / 2;
  }
  /** Returns [field, wireType]. */
  key(): [number, number] {
    const k = this.varint();
    return [Math.floor(k / 8), k & 7];
  }
  bytes(): [number, number] {
    const len = this.varint();
    const s = this.pos;
    this.pos += len;
    return [s, this.pos];
  }
  skip(wire: number): void {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) { const len = this.varint(); this.pos += len; } // not `pos += varint()`: that reads pos before the length is consumed
    else if (wire === 5) this.pos += 4;
    else throw new Error(`unsupported wire type ${wire}`);
  }
  packed(signed: boolean, [s, e]: [number, number]): number[] {
    const r = new Reader(this.buf, s, e);
    const out: number[] = [];
    while (!r.done) out.push(signed ? r.svarint() : r.varint());
    return out;
  }
}

const utf8 = new TextDecoder();

/** Iterate decompressed OSMData blobs. */
function* blobs(file: string, onFraction?: (f: number) => void): Generator<Uint8Array> {
  const fd = fs.openSync(file, 'r');
  const size = fs.fstatSync(fd).size;
  let off = 0;
  const lenBuf = Buffer.alloc(4);
  try {
    while (off < size) {
      fs.readSync(fd, lenBuf, 0, 4, off);
      const hlen = lenBuf.readUInt32BE(0);
      off += 4;
      const hb = Buffer.alloc(hlen);
      fs.readSync(fd, hb, 0, hlen, off);
      off += hlen;
      const h = new Reader(hb);
      let type = '', datasize = 0;
      while (!h.done) {
        const [f, w] = h.key();
        if (f === 1) { const [s, e] = h.bytes(); type = utf8.decode(hb.subarray(s, e)); }
        else if (f === 3) datasize = h.varint();
        else h.skip(w);
      }
      const bb = Buffer.alloc(datasize);
      fs.readSync(fd, bb, 0, datasize, off);
      off += datasize;
      onFraction?.(off / size);
      if (type !== 'OSMData') continue;
      const b = new Reader(bb);
      let raw: Uint8Array | undefined, zlib: Uint8Array | undefined;
      while (!b.done) {
        const [f, w] = b.key();
        if (f === 1) { const [s, e] = b.bytes(); raw = bb.subarray(s, e); }
        else if (f === 3) { const [s, e] = b.bytes(); zlib = bb.subarray(s, e); }
        else if (f === 4 || f === 7) throw new Error('this PBF uses LZMA/ZSTD blobs; use a zlib-compressed extract');
        else b.skip(w);
      }
      yield raw ?? inflateSync(zlib!);
    }
  } finally {
    fs.closeSync(fd);
  }
}

interface Block { strings: string[]; gran: number; latOff: number; lonOff: number; groups: [number, number][]; buf: Uint8Array }

function parseBlock(buf: Uint8Array): Block {
  const r = new Reader(buf);
  const strings: string[] = [];
  const groups: [number, number][] = [];
  let gran = 100, latOff = 0, lonOff = 0;
  while (!r.done) {
    const [f, w] = r.key();
    if (f === 1) {
      const [s, e] = r.bytes();
      const st = new Reader(buf, s, e);
      while (!st.done) {
        const [sf, sw] = st.key();
        if (sf === 1) { const [a, z] = st.bytes(); strings.push(utf8.decode(buf.subarray(a, z))); } else st.skip(sw);
      }
    } else if (f === 2) groups.push(r.bytes());
    else if (f === 17) gran = r.varint();
    else if (f === 19) latOff = r.varint();
    else if (f === 20) lonOff = r.varint();
    else r.skip(w);
  }
  return { strings, gran, latOff, lonOff, groups, buf };
}

/** Fields of each primitive group: [field number, start, end]. */
function groupItems(b: Block, g: [number, number]): [number, number, number][] {
  const r = new Reader(b.buf, g[0], g[1]);
  const out: [number, number, number][] = [];
  while (!r.done) {
    const [f, w] = r.key();
    if (w === 2) { const [s, e] = r.bytes(); out.push([f, s, e]); } else r.skip(w);
  }
  return out;
}

function tagsOf(b: Block, keys: number[], vals: number[]): Record<string, string> {
  const t: Record<string, string> = {};
  for (let i = 0; i < keys.length; i++) t[b.strings[keys[i]]] = b.strings[vals[i]];
  return t;
}

function parseRelation(b: Block, s: number, e: number): { id: number; tags: Record<string, string>; roles: number[]; memids: number[]; types: number[] } {
  const r = new Reader(b.buf, s, e);
  let id = 0, keys: number[] = [], vals: number[] = [], roles: number[] = [], memids: number[] = [], types: number[] = [];
  while (!r.done) {
    const [f, w] = r.key();
    if (f === 1) id = r.varint();
    else if (f === 2) keys = r.packed(false, r.bytes());
    else if (f === 3) vals = r.packed(false, r.bytes());
    else if (f === 8) roles = r.packed(false, r.bytes());
    else if (f === 9) { memids = r.packed(true, r.bytes()); for (let i = 1; i < memids.length; i++) memids[i] += memids[i - 1]; }
    else if (f === 10) types = r.packed(false, r.bytes());
    else r.skip(w);
  }
  return { id, tags: tagsOf(b, keys, vals), roles, memids, types };
}

/** Sorted node store: ids ascending (PBF extracts are sorted), coordinates as 1e-7 degree ints. */
class NodeStore {
  private ids = new Float64Array(1 << 20);
  private lat = new Int32Array(1 << 20);
  private lon = new Int32Array(1 << 20);
  n = 0;
  private sorted = true;
  add(id: number, lat: number, lon: number): void {
    if (this.n === this.ids.length) {
      const grow = <T extends Float64Array | Int32Array>(a: T, C: new (n: number) => T): T => { const b = new C(a.length * 2); b.set(a); return b; };
      this.ids = grow(this.ids, Float64Array); this.lat = grow(this.lat, Int32Array); this.lon = grow(this.lon, Int32Array);
    }
    if (this.n && id <= this.ids[this.n - 1]) this.sorted = false;
    this.ids[this.n] = id; this.lat[this.n] = Math.round(lat * 1e7); this.lon[this.n] = Math.round(lon * 1e7); this.n++;
  }
  finish(): void {
    if (this.sorted) return;
    const order = Array.from({ length: this.n }, (_, i) => i).sort((a, b) => this.ids[a] - this.ids[b]);
    const ids = new Float64Array(this.n), lat = new Int32Array(this.n), lon = new Int32Array(this.n);
    order.forEach((o, i) => { ids[i] = this.ids[o]; lat[i] = this.lat[o]; lon[i] = this.lon[o]; });
    this.ids = ids; this.lat = lat; this.lon = lon; this.sorted = true;
  }
  get(id: number): LatLon | undefined {
    let lo = 0, hi = this.n - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1, v = this.ids[mid];
      if (v === id) return { lat: this.lat[mid] / 1e7, lon: this.lon[mid] / 1e7 };
      if (v < id) lo = mid + 1; else hi = mid - 1;
    }
    return undefined;
  }
}

export function readPbf(file: string, opts: PbfOptions): { nodes: number; ways: number; relations: number } {
  const m = opts.margin ?? 0.05;
  const [lonMin, latMin, lonMax, latMax] = opts.bbox;
  const inBox = (la: number, lo: number) => la >= latMin - m && la <= latMax + m && lo >= lonMin - m && lo <= lonMax + m;

  // ---- pass 1: wanted multipolygon relations → member way ids
  const memberWays = new Set<number>();
  for (const data of blobs(file, (f) => opts.onProgress?.(1, f))) {
    const b = parseBlock(data);
    for (const g of b.groups) for (const [f, s, e] of groupItems(b, g)) {
      if (f !== 4) continue;
      const rel = parseRelation(b, s, e);
      if (rel.tags.type !== 'multipolygon' || !opts.wantRelation(rel.tags)) continue;
      rel.memids.forEach((id, i) => { if (rel.types[i] === 1) memberWays.add(id); });
    }
  }

  // ---- pass 2: nodes in the box, then ways, then relations
  const nodes = new NodeStore();
  const memberGeom = new Map<number, LatLon[]>();
  let finished = false, nWays = 0, nRels = 0;
  for (const data of blobs(file, (f) => opts.onProgress?.(2, f))) {
    const b = parseBlock(data);
    const toLat = (v: number) => 1e-9 * (b.latOff + b.gran * v), toLon = (v: number) => 1e-9 * (b.lonOff + b.gran * v);
    for (const g of b.groups) for (const [f, s, e] of groupItems(b, g)) {
      if (f === 2) {
        // dense nodes
        const r = new Reader(b.buf, s, e);
        let ids: number[] = [], lats: number[] = [], lons: number[] = [];
        while (!r.done) {
          const [df, dw] = r.key();
          if (df === 1) ids = r.packed(true, r.bytes());
          else if (df === 8) lats = r.packed(true, r.bytes());
          else if (df === 9) lons = r.packed(true, r.bytes());
          else r.skip(dw);
        }
        let id = 0, la = 0, lo = 0;
        for (let i = 0; i < ids.length; i++) {
          id += ids[i]; la += lats[i]; lo += lons[i];
          const lat = toLat(la), lon = toLon(lo);
          if (inBox(lat, lon)) nodes.add(id, lat, lon);
        }
      } else if (f === 1) {
        const r = new Reader(b.buf, s, e);
        let id = 0, lat = 0, lon = 0;
        while (!r.done) {
          const [nf, nw] = r.key();
          if (nf === 1) id = r.svarint(); else if (nf === 8) lat = toLat(r.svarint()); else if (nf === 9) lon = toLon(r.svarint()); else r.skip(nw);
        }
        if (inBox(lat, lon)) nodes.add(id, lat, lon);
      } else if (f === 3) {
        if (!finished) { nodes.finish(); finished = true; }
        const r = new Reader(b.buf, s, e);
        let id = 0, keys: number[] = [], vals: number[] = [], refs: number[] = [];
        while (!r.done) {
          const [wf, ww] = r.key();
          if (wf === 1) id = r.varint();
          else if (wf === 2) keys = r.packed(false, r.bytes());
          else if (wf === 3) vals = r.packed(false, r.bytes());
          else if (wf === 8) { refs = r.packed(true, r.bytes()); for (let i = 1; i < refs.length; i++) refs[i] += refs[i - 1]; }
          else r.skip(ww);
        }
        const tags = tagsOf(b, keys, vals);
        const member = memberWays.has(id);
        if (!member && !opts.wantWay(tags)) continue;
        const geometry: LatLon[] = [];
        for (const ref of refs) { const p = nodes.get(ref); if (p) geometry.push(p); }
        if (geometry.length < 2) continue;
        if (member) memberGeom.set(id, geometry);
        if (opts.wantWay(tags)) { opts.onWay({ id, tags, geometry }); nWays++; }
      } else if (f === 4) {
        const rel = parseRelation(b, s, e);
        if (rel.tags.type !== 'multipolygon' || !opts.wantRelation(rel.tags)) continue;
        const members = rel.memids.map((mid, i) => ({ mid, i })).filter(({ i }) => rel.types[i] === 1).map(({ mid, i }) => ({ type: 'way' as const, role: b.strings[rel.roles[i]] ?? '', geometry: memberGeom.get(mid) ?? [] })).filter((mm) => mm.geometry.length >= 2);
        if (members.length) { opts.onRelation({ id: rel.id, tags: rel.tags, members }); nRels++; }
      }
    }
  }
  return { nodes: nodes.n, ways: nWays, relations: nRels };
}
