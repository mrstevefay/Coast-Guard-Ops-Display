import fs from 'node:fs';
import path from 'node:path';

/** Grid in ITM metres. (x0, y0) is the top-left corner; rows run southwards. */
export interface GridSpec {
  x0: number;
  y0: number;
  cellM: number;
  cols: number;
  rows: number;
}

export interface TerrainMeta extends GridSpec {
  version: 1;
  crs: 'EPSG:2157';
  /** lonMin, latMin, lonMax, latMax the grid was built for. */
  bbox: [number, number, number, number];
  builtAt: string;
  coverage: { lidarPct: number; copernicusPct: number; nonePct: number; seaPct: number };
  sources: { lidarTiles: string[]; copernicusTiles: string[]; osmTiles: number; osmFetchedAt?: string; overpass?: string };
  attribution: string[];
}

/** DEM stored as decimetres in Int16; this marks "no height". */
export const DEM_NODATA = -32768;
export const SRC = { NONE: 0, COPERNICUS: 1, LIDAR: 2 } as const;

export interface TerrainData {
  meta: TerrainMeta;
  /** Height, decimetres. */
  dem: Int16Array;
  cls: Uint8Array;
  flags: Uint8Array;
  src: Uint8Array;
}

const FILES = { dem: 'dem.i16', cls: 'class.u8', flags: 'flags.u8', src: 'src.u8', meta: 'meta.json' } as const;

export function terrainFilesExist(dir: string): boolean {
  return Object.values(FILES).every((f) => fs.existsSync(path.join(dir, f)));
}

export function writeTerrain(dir: string, t: TerrainData): void {
  fs.mkdirSync(dir, { recursive: true });
  // write to temp names then rename, so a crashed build never leaves a half-written set
  const tmp = (f: string) => path.join(dir, `${f}.tmp`);
  fs.writeFileSync(tmp(FILES.dem), Buffer.from(t.dem.buffer, t.dem.byteOffset, t.dem.byteLength));
  fs.writeFileSync(tmp(FILES.cls), t.cls);
  fs.writeFileSync(tmp(FILES.flags), t.flags);
  fs.writeFileSync(tmp(FILES.src), t.src);
  fs.writeFileSync(tmp(FILES.meta), JSON.stringify(t.meta, null, 2));
  for (const f of Object.values(FILES)) fs.renameSync(tmp(f), path.join(dir, f));
}

export function readTerrain(dir: string): TerrainData {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, FILES.meta), 'utf8')) as TerrainMeta;
  const n = meta.cols * meta.rows;
  const buf = (f: string) => fs.readFileSync(path.join(dir, f));
  const demBuf = buf(FILES.dem);
  const dem = new Int16Array(demBuf.buffer.slice(demBuf.byteOffset, demBuf.byteOffset + demBuf.byteLength));
  const cls = new Uint8Array(buf(FILES.cls));
  const flags = new Uint8Array(buf(FILES.flags));
  const src = new Uint8Array(buf(FILES.src));
  if (dem.length !== n || cls.length !== n || flags.length !== n || src.length !== n) throw new Error('terrain files do not match meta.json; rebuild the terrain data');
  return { meta, dem, cls, flags, src };
}

/** Cell index containing an ITM point, or -1 outside the grid. */
export function cellAt(g: GridSpec, x: number, y: number): number {
  const c = Math.floor((x - g.x0) / g.cellM), r = Math.floor((g.y0 - y) / g.cellM);
  if (c < 0 || r < 0 || c >= g.cols || r >= g.rows) return -1;
  return r * g.cols + c;
}
