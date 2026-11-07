import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { readPbf, type PbfRelation, type PbfWay } from '../src/terrain/pbf.js';

// ---- a minimal protobuf / OSM PBF writer, just for the test
const varint = (n: number): number[] => { const out: number[] = []; do { let b = n % 128; n = Math.floor(n / 128); if (n > 0) b |= 0x80; out.push(b); } while (n > 0); return out; };
const zig = (n: number) => (n >= 0 ? 2 * n : -2 * n - 1);
const field = (num: number, wire: number, payload: number[]): number[] => [...varint(num * 8 + wire), ...(wire === 2 ? varint(payload.length) : []), ...payload];
const bytesField = (num: number, b: number[] | Uint8Array) => field(num, 2, Array.from(b));
const str = (s: string) => Array.from(Buffer.from(s, 'utf8'));
const packed = (vals: number[], signed: boolean) => vals.flatMap((v) => varint(signed ? zig(v) : v));
const deltas = (vals: number[]) => vals.map((v, i) => (i ? v - vals[i - 1] : v));

function blob(type: string, data: number[]): Buffer {
  const z = deflateSync(Buffer.from(data));
  const b = [...field(2, 0, varint(data.length)), ...bytesField(3, z)];
  const h = [...bytesField(1, str(type)), ...field(3, 0, varint(b.length))];
  const len = Buffer.alloc(4);
  len.writeUInt32BE(h.length);
  return Buffer.concat([len, Buffer.from(h), Buffer.from(b)]);
}

function samplePbf(): Buffer {
  const strings = ['', 'highway', 'footway', 'type', 'multipolygon', 'natural', 'water', 'outer'];
  const st = strings.flatMap((s) => bytesField(1, str(s)));
  // five nodes round Howth, as 1e-7 degree integers (granularity 100 × 1e-9)
  const pts = [[53.38, -6.06], [53.381, -6.059], [53.382, -6.058], [53.383, -6.06], [53.384, -6.061]];
  const ids = [1, 2, 3, 4, 5];
  const lat = pts.map((p) => Math.round(p[0] * 1e7)), lon = pts.map((p) => Math.round(p[1] * 1e7));
  const dense = [...bytesField(1, packed(deltas(ids), true)), ...bytesField(5, [...bytesField(1, packed([1, 1, 1, 1, 1], false))]), ...bytesField(8, packed(deltas(lat), true)), ...bytesField(9, packed(deltas(lon), true))];
  const g1 = bytesField(2, dense);
  const info = bytesField(4, [...field(1, 0, varint(3)), ...field(2, 0, varint(1700000000))]); // version, timestamp: must be skipped
  const way10 = [...field(1, 0, varint(10)), ...info, ...bytesField(2, packed([1], false)), ...bytesField(3, packed([2], false)), ...bytesField(8, packed(deltas([1, 2, 3]), true))];
  const way11 = [...field(1, 0, varint(11)), ...bytesField(8, packed(deltas([3, 4, 5, 3]), true))];
  const g2 = [...bytesField(3, way10), ...bytesField(3, way11)];
  const rel = [...field(1, 0, varint(20)), ...bytesField(2, packed([3, 5], false)), ...bytesField(3, packed([4, 6], false)), ...info, ...bytesField(8, packed([7], false)), ...bytesField(9, packed([11], true)), ...bytesField(10, packed([1], false))];
  const g3 = bytesField(4, rel);
  const block = [...bytesField(1, st), ...bytesField(2, g1), ...bytesField(2, g2), ...bytesField(2, g3)];
  return Buffer.concat([blob('OSMHeader', []), blob('OSMData', block)]);
}

describe('OSM PBF reader', () => {
  it('returns tagged ways and multipolygons with geometry, skipping untagged member ways', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-pbf-')), 'sample.osm.pbf');
    fs.writeFileSync(file, samplePbf());
    const ways: PbfWay[] = [], rels: PbfRelation[] = [];
    const res = readPbf(file, {
      bbox: [-6.1, 53.37, -6.0, 53.4],
      wantWay: (t) => Boolean(t.highway),
      wantRelation: (t) => t.natural === 'water',
      onWay: (w) => ways.push(w),
      onRelation: (r) => rels.push(r),
    });
    expect(res).toEqual({ nodes: 5, ways: 1, relations: 1 });
    expect(ways[0]).toMatchObject({ id: 10, tags: { highway: 'footway' } });
    expect(ways[0].geometry).toHaveLength(3);
    expect(ways[0].geometry[2].lat).toBeCloseTo(53.382, 6);
    expect(ways[0].geometry[2].lon).toBeCloseTo(-6.058, 6);
    expect(rels[0]).toMatchObject({ id: 20, tags: { type: 'multipolygon', natural: 'water' } });
    expect(rels[0].members[0].role).toBe('outer');
    expect(rels[0].members[0].geometry).toHaveLength(4);
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it('drops nodes outside the box (plus margin)', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-pbf-')), 'sample.osm.pbf');
    fs.writeFileSync(file, samplePbf());
    const res = readPbf(file, { bbox: [-5.5, 52.0, -5.4, 52.1], margin: 0.01, wantWay: () => true, wantRelation: () => true, onWay: () => {}, onRelation: () => {} });
    expect(res.nodes).toBe(0);
    expect(res.ways).toBe(0);
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });
});
