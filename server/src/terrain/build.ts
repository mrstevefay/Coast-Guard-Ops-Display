/**
 * Builds the station terrain grid once (and on demand from Settings → Terrain):
 *
 *   1. Copernicus GLO-30 (30 m, everywhere), read by HTTP range from the AWS open-data COGs.
 *   2. GSI / OPW open LiDAR DTM tiles (2 m bare earth, coastal and flood-risk strips) where
 *      they exist, averaged into the 10 m grid; they override Copernicus.
 *   3. OpenStreetMap via Overpass: coastline, cliffs, water, roads and paths, railways,
 *      rivers, land use. Rasterised into a land-class byte and a linear-feature flag byte.
 *   4. Sea: flood fill from the east edge, stopped by the coastline.
 *
 * Output: data/terrain/{dem.i16,class.u8,flags.u8,src.u8,meta.json}; downloads are cached
 * in data/terrain/cache so a rebuild only refetches what it is told to.
 */
import fs from 'node:fs';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { fromArrayBuffer, fromUrl } from 'geotiff';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { readPbf } from './pbf.js';
import { PlaceCollector, placeKind, writePlaces } from './places.js';
import { CLASS, FLAG } from './classes.js';
import { fromItm, toItm } from './itm.js';
import { DEM_NODATA, SRC, writeTerrain, type GridSpec, type TerrainMeta } from './raster.js';
import { drawLine, fillRings, toGrid, type XY } from './rasterise.js';

export interface TerrainConfig {
  /** lonMin, latMin, lonMax, latMax. */
  bbox: [number, number, number, number];
  cellM: number;
  overpassUrls: string[];
  /** ArcGIS FeatureServer layer URLs whose features carry DATA_URL links to zipped *_DTM.tif tiles. */
  lidarLayers: string[];
  copernicusBase: string;
  /** OSM is fetched in osmTiles × osmTiles pieces to stay inside Overpass limits. */
  osmTiles: number;
  /** 'auto': Overpass, falling back to the extract if Overpass fails; or force one. */
  osmSource: 'auto' | 'overpass' | 'extract';
  /** In 'auto', total seconds of failed Overpass requests before giving up and using the extract. */
  overpassBudgetS: number;
  /** A zlib PBF extract covering the bbox (Ireland: ~380 MB, cached after the first download). */
  osmExtractUrl: string;
}

/** Dublin city centre to Skerries, Howth and Lambay included. */
export const DEFAULT_TERRAIN: TerrainConfig = {
  bbox: [-6.35, 53.33, -5.95, 53.6],
  cellM: 10,
  overpassUrls: ['https://overpass-api.de/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'],
  lidarLayers: [
    'https://gsi.geodata.gov.ie/server/rest/services/Lidar/IE_GSI_LiDAR_Coverage_OPW_NASC_IE26_ITM/FeatureServer/3',
    'https://gsi.geodata.gov.ie/server/rest/services/Lidar/IE_GSI_LiDAR_Coverage_TII_IE26_ITM/FeatureServer/0',
  ],
  copernicusBase: 'https://copernicus-dem-30m.s3.amazonaws.com',
  osmTiles: 4,
  osmSource: 'auto',
  overpassBudgetS: 300,
  osmExtractUrl: 'https://download.openstreetmap.fr/extracts/europe/ireland.osm.pbf',
};

export function terrainConfig(partial?: Partial<TerrainConfig>): TerrainConfig {
  return { ...DEFAULT_TERRAIN, ...(partial ?? {}) };
}

export interface BuildProgress {
  stage: string;
  pct: number;
  message: string;
  log: string[];
}

export interface BuildOptions {
  refreshOsm?: boolean;
  refreshLidar?: boolean;
  onProgress?: (p: BuildProgress) => void;
  fetchImpl?: typeof fetch;
}

const UA = 'howth-cg-ops-terrain/1 (+https://github.com/mrstevefay/Coast-Guard-Ops-Display)';

export function gridFor(bbox: [number, number, number, number], cellM: number): GridSpec {
  const [lonMin, latMin, lonMax, latMax] = bbox;
  const corners = [toItm(latMin, lonMin), toItm(latMin, lonMax), toItm(latMax, lonMin), toItm(latMax, lonMax)];
  const xs = corners.map((c) => c[0]), ys = corners.map((c) => c[1]);
  const x0 = Math.floor(Math.min(...xs) / cellM) * cellM, x1 = Math.ceil(Math.max(...xs) / cellM) * cellM;
  const y1 = Math.floor(Math.min(...ys) / cellM) * cellM, y0 = Math.ceil(Math.max(...ys) / cellM) * cellM;
  return { x0, y0, cellM, cols: Math.round((x1 - x0) / cellM), rows: Math.round((y0 - y1) / cellM) };
}

/** lat/lon for every cell centre, via a coarse exact lattice and bilinear interpolation (TM is smooth). */
function cellLatLon(g: GridSpec): { lat: Float64Array; lon: Float64Array } {
  const step = 32;
  const lc = Math.ceil(g.cols / step) + 1, lr = Math.ceil(g.rows / step) + 1;
  const la = new Float64Array(lc * lr), lo = new Float64Array(lc * lr);
  for (let r = 0; r < lr; r++) for (let c = 0; c < lc; c++) {
    const [lat, lon] = fromItm(g.x0 + (c * step + 0.5) * g.cellM, g.y0 - (r * step + 0.5) * g.cellM);
    la[r * lc + c] = lat; lo[r * lc + c] = lon;
  }
  const n = g.cols * g.rows;
  const lat = new Float64Array(n), lon = new Float64Array(n);
  for (let r = 0; r < g.rows; r++) {
    const fr = r / step, r0 = Math.min(Math.floor(fr), lr - 2), tr = fr - r0;
    for (let c = 0; c < g.cols; c++) {
      const fc = c / step, c0 = Math.min(Math.floor(fc), lc - 2), tc = fc - c0;
      const i00 = r0 * lc + c0, i01 = i00 + 1, i10 = i00 + lc, i11 = i10 + 1;
      const i = r * g.cols + c;
      lat[i] = (la[i00] * (1 - tc) + la[i01] * tc) * (1 - tr) + (la[i10] * (1 - tc) + la[i11] * tc) * tr;
      lon[i] = (lo[i00] * (1 - tc) + lo[i01] * tc) * (1 - tr) + (lo[i10] * (1 - tc) + lo[i11] * tc) * tr;
    }
  }
  return { lat, lon };
}

const tileName = (lat: number, lon: number) => {
  const ns = lat >= 0 ? 'N' : 'S', ew = lon >= 0 ? 'E' : 'W';
  const la = String(Math.abs(lat)).padStart(2, '0'), lo = String(Math.abs(lon)).padStart(3, '0');
  return `Copernicus_DSM_COG_10_${ns}${la}_00_${ew}${lo}_00_DEM`;
};

async function withRetry<T>(what: string, fn: () => Promise<T>, tries = 3, log?: (m: string) => void): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      log?.(`${what}: attempt ${i + 1} failed (${e instanceof Error ? e.message : String(e)})`);
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

/** Thrown when failed Overpass requests have used up the time budget ('auto' then switches to the extract). */
export class OverpassGaveUp extends Error {}

export interface OverpassFetchCtx {
  fetchImpl: typeof fetch;
  log: (m: string) => void;
  /** Milliseconds of failed requests still allowed; shared across boxes. Undefined: no limit. */
  budget?: { leftMs: number };
  timeoutMs?: number;
  retryDelayMs?: number;
  now?: () => number;
}

/**
 * POST one Overpass query to each server in turn, twice each. Returns the first good answer,
 * or undefined if every server failed. Time spent on failed requests is charged to the
 * budget, and no request may outlast what is left of it; once it is spent, throws
 * OverpassGaveUp instead of trying further.
 */
export async function overpassFetch(urls: string[], query: string, label: string, ctx: OverpassFetchCtx): Promise<{ text: string; host: string } | undefined> {
  const now = ctx.now ?? Date.now;
  const timeoutMs = ctx.timeoutMs ?? 150_000, delay = ctx.retryDelayMs ?? 2000;
  const body = new URLSearchParams({ data: query });
  for (const url of urls) {
    const host = new URL(url).host;
    for (let i = 0; i < 2; i++) {
      const t0 = now();
      const limit = ctx.budget ? Math.max(1000, Math.min(timeoutMs, ctx.budget.leftMs)) : timeoutMs;
      try {
        const r = await ctx.fetchImpl(url, { method: 'POST', body, headers: { 'user-agent': UA, 'content-type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(limit) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const text = await r.text();
        if (!text.startsWith('{')) throw new Error('not JSON');
        if (/"remark":\s*"runtime error/.test(text.slice(0, 4000))) throw new Error('Overpass runtime error (too much data)');
        return { text, host };
      } catch (e) {
        ctx.log(`Overpass ${host} box ${label}: attempt ${i + 1} failed (${e instanceof Error ? e.message : String(e)})`);
        if (ctx.budget) {
          ctx.budget.leftMs -= now() - t0;
          if (ctx.budget.leftMs <= 0) throw new OverpassGaveUp('the servers kept failing and the time allowed for failed requests ran out');
        }
        if (delay) await new Promise((res) => setTimeout(res, delay * (i + 1)));
      }
    }
  }
  return undefined;
}

interface OsmElement { type: 'node' | 'way' | 'relation'; id: number; tags?: Record<string, string>; lat?: number; lon?: number; geometry?: { lat: number; lon: number }[]; members?: { type: string; role: string; geometry?: { lat: number; lon: number }[] }[] }

const URBAN_LANDUSE = new Set(['residential', 'commercial', 'retail', 'industrial', 'construction', 'railway', 'garages', 'education', 'institutional', 'religious', 'military', 'port', 'depot', 'brownfield', 'landfill', 'farmyard']);
const GRASS_LANDUSE = new Set(['farmland', 'meadow', 'grass', 'recreation_ground', 'village_green', 'cemetery', 'allotments', 'orchard', 'plant_nursery', 'greenfield', 'flowerbed']);
const GRASS_LEISURE = new Set(['park', 'golf_course', 'garden', 'pitch', 'recreation_ground', 'common']);

/** Land class for an area feature, or undefined if it is not one we paint. */
export function areaClass(tags: Record<string, string>): number | undefined {
  const lu = tags.landuse, nat = tags.natural, lei = tags.leisure;
  if (nat === 'water' || tags.waterway === 'riverbank' || lu === 'reservoir' || lu === 'basin') return CLASS.WATER;
  if (nat === 'wood' || lu === 'forest') return CLASS.WOOD;
  if (nat === 'scrub') return CLASS.SCRUB;
  if (nat === 'heath') return CLASS.HEATH;
  if (nat === 'wetland') return CLASS.WETLAND;
  if (nat === 'beach' || nat === 'sand' || nat === 'shingle') return CLASS.BEACH;
  if (nat === 'bare_rock' || nat === 'scree' || lu === 'quarry') return CLASS.ROCK;
  if (nat === 'grassland' || (lu && GRASS_LANDUSE.has(lu)) || (lei && GRASS_LEISURE.has(lei))) return CLASS.GRASS;
  if (lu && URBAN_LANDUSE.has(lu)) return CLASS.URBAN;
  return undefined;
}

/** Paint order: later wins where polygons overlap (a wood inside a park, a pond inside a wood). */
const PAINT_ORDER = [CLASS.URBAN, CLASS.GRASS, CLASS.HEATH, CLASS.SCRUB, CLASS.WOOD, CLASS.BEACH, CLASS.WETLAND, CLASS.ROCK, CLASS.WATER];

/** Linear-feature flag for a way, or 0. */
export function lineFlag(tags: Record<string, string>): number {
  if (tags.tunnel && tags.tunnel !== 'no') return 0;
  if (tags.layer && Number(tags.layer) < 0) return 0;
  const hw = tags.highway;
  if (hw) {
    if (hw === 'motorway' || hw === 'motorway_link') return FLAG.MOTORWAY;
    if (hw === 'construction' || hw === 'proposed' || hw === 'abandoned' || hw === 'razed') return 0;
    if (tags.access === 'no' && !tags.foot) return 0;
    return FLAG.TRAVEL;
  }
  if (tags.man_made === 'pier' || tags.man_made === 'breakwater' || tags.man_made === 'groyne') return FLAG.TRAVEL;
  if (tags.railway) return FLAG.RAIL;
  if (tags.natural === 'cliff') return FLAG.CLIFF;
  if (tags.natural === 'coastline') return FLAG.COAST;
  const ww = tags.waterway;
  if (ww === 'river' || ww === 'canal') return FLAG.RIVER;
  if (ww === 'stream' || ww === 'ditch' || ww === 'drain') return FLAG.STREAM;
  return 0;
}

export function overpassQuery(s: number, w: number, n: number, e: number): string {
  const bb = `(${s},${w},${n},${e})`;
  return `[out:json][timeout:300][maxsize:1073741824];
(
  way["highway"]${bb};
  way["railway"~"^(rail|light_rail|narrow_gauge|tram|subway)$"]${bb};
  way["natural"~"^(coastline|cliff|water|wood|scrub|heath|grassland|wetland|beach|sand|shingle|bare_rock|scree)$"]${bb};
  way["landuse"]${bb};
  way["leisure"~"^(park|golf_course|garden|pitch|recreation_ground|common)$"]${bb};
  way["waterway"~"^(river|canal|stream|ditch|drain|riverbank)$"]${bb};
  way["man_made"~"^(pier|breakwater|groyne)$"]${bb};
  node["name"]["place"]${bb};
  node["name"]["natural"]${bb};
  node["name"]["tourism"]${bb};
  node["name"]["historic"]${bb};
  node["name"]["leisure"]${bb};
  node["name"]["man_made"~"^(lighthouse|pier|tower|water_tower|mast)$"]${bb};
  node["name"]["amenity"~"^(parking|pub|bar|cafe|restaurant|school|place_of_worship|hospital|clinic|fuel|community_centre|library|police|fire_station|shelter)$"]${bb};
  node["name"]["railway"~"^(station|halt)$"]${bb};
  way["name"]["amenity"~"^(parking|school|place_of_worship|hospital)$"]${bb};
  way["name"]["tourism"]${bb};
  way["name"]["historic"]${bb};
  relation["type"="multipolygon"]["natural"~"^(water|wood|scrub|heath|grassland|wetland|beach|sand|bare_rock|scree)$"]${bb};
  relation["type"="multipolygon"]["landuse"]${bb};
  relation["type"="multipolygon"]["leisure"~"^(park|golf_course|garden|common)$"]${bb};
);
out geom;`;
}

/**
 * Mark the sea: 4-connected flood from the east edge of the grid (open sea for the station
 * bbox), through cells that are low (≤ 5 m, ≤ 2 m on LiDAR) and not on a coastline line. A
 * 4-connected coastline is a closed wall for a 4-connected flood, so land is never flooded
 * unless the coastline itself has a gap; the height test is a second guard.
 */
export function floodSea(g: GridSpec, cls: Uint8Array, flags: Uint8Array, dem: Int16Array, src: Uint8Array): number {
  const n = g.cols * g.rows;
  const queue = new Int32Array(n);
  let qh = 0, qt = 0;
  const ok = (i: number) => cls[i] !== CLASS.SEA && !(flags[i] & FLAG.COAST) && (dem[i] === DEM_NODATA || dem[i] <= 50) && (src[i] !== SRC.LIDAR || dem[i] <= 20);
  for (let r = 0; r < g.rows; r++) {
    const i = r * g.cols + (g.cols - 1);
    if (ok(i)) { cls[i] = CLASS.SEA; queue[qt++] = i; }
  }
  while (qh < qt) {
    const i = queue[qh++];
    const c = i % g.cols, r = (i - c) / g.cols;
    if (c > 0 && ok(i - 1)) { cls[i - 1] = CLASS.SEA; queue[qt++] = i - 1; }
    if (c < g.cols - 1 && ok(i + 1)) { cls[i + 1] = CLASS.SEA; queue[qt++] = i + 1; }
    if (r > 0 && ok(i - g.cols)) { cls[i - g.cols] = CLASS.SEA; queue[qt++] = i - g.cols; }
    if (r < g.rows - 1 && ok(i + g.cols)) { cls[i + g.cols] = CLASS.SEA; queue[qt++] = i + g.cols; }
  }
  return qt;
}

export async function buildTerrain(dir: string, cfg: TerrainConfig, opts: BuildOptions = {}): Promise<TerrainMeta> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const progress: BuildProgress = { stage: 'grid', pct: 0, message: 'Preparing grid', log: [] };
  const report = (stage: string, pct: number, message: string) => {
    Object.assign(progress, { stage, pct: Math.round(pct), message });
    opts.onProgress?.({ ...progress, log: progress.log.slice(-40) });
  };
  const log = (m: string) => { progress.log.push(`${new Date().toISOString().slice(11, 19)} ${m}`); opts.onProgress?.({ ...progress, log: progress.log.slice(-40) }); };
  const cache = path.join(dir, 'cache');
  fs.mkdirSync(path.join(cache, 'osm'), { recursive: true });
  fs.mkdirSync(path.join(cache, 'lidar'), { recursive: true });

  const g = gridFor(cfg.bbox, cfg.cellM);
  const n = g.cols * g.rows;
  log(`grid ${g.cols} × ${g.rows} at ${g.cellM} m (${(n / 1e6).toFixed(1)} M cells), ITM ${g.x0}–${g.x0 + g.cols * g.cellM} E, ${g.y0 - g.rows * g.cellM}–${g.y0} N`);
  const dem = new Int16Array(n).fill(DEM_NODATA);
  const cls = new Uint8Array(n);
  const flags = new Uint8Array(n);
  const src = new Uint8Array(n);
  const { lat, lon } = cellLatLon(g);

  // ---- 1. Copernicus
  const [lonMin, latMin, lonMax, latMax] = cfg.bbox;
  const copTiles: string[] = [];
  for (let la = Math.floor(latMin); la <= Math.floor(latMax); la++) {
    for (let lo = Math.floor(lonMin); lo <= Math.floor(lonMax); lo++) {
      const name = tileName(la, lo);
      report('copernicus', 5, `Copernicus tile ${name}`);
      const tif = await withRetry(`Copernicus ${name}`, () => fromUrl(`${cfg.copernicusBase}/${name}/${name}.tif`), 3, log);
      const img = await tif.getImage();
      const [bx0, , , by1] = img.getBoundingBox();
      const [rx, ry] = img.getResolution();
      const W = img.getWidth(), H = img.getHeight();
      const wl = Math.max(0, Math.floor((Math.max(lonMin, lo) - bx0) / rx) - 2), wr = Math.min(W, Math.ceil((Math.min(lonMax, lo + 1) - bx0) / rx) + 2);
      const wt = Math.max(0, Math.floor((Math.min(latMax, la + 1) - by1) / ry) - 2), wb = Math.min(H, Math.ceil((Math.max(latMin, la) - by1) / ry) + 2);
      if (wr <= wl || wb <= wt) continue;
      const [raster] = (await withRetry(`Copernicus ${name} window`, () => img.readRasters({ window: [wl, wt, wr, wb] }), 3, log)) as unknown as Float32Array[];
      const ww = wr - wl, wh = wb - wt;
      const lonL = bx0 + wl * rx, latT = by1 + wt * ry;
      let filled = 0;
      for (let i = 0; i < n; i++) {
        if (lat[i] < la || lat[i] >= la + 1 || lon[i] < lo || lon[i] >= lo + 1) continue;
        const fx = (lon[i] - lonL) / rx - 0.5, fy = (lat[i] - latT) / ry - 0.5;
        const x0 = Math.floor(fx), y0 = Math.floor(fy);
        if (x0 < 0 || y0 < 0 || x0 + 1 >= ww || y0 + 1 >= wh) continue;
        const tx = fx - x0, ty = fy - y0;
        const v = (raster[y0 * ww + x0] * (1 - tx) + raster[y0 * ww + x0 + 1] * tx) * (1 - ty) + (raster[(y0 + 1) * ww + x0] * (1 - tx) + raster[(y0 + 1) * ww + x0 + 1] * tx) * ty;
        if (!Number.isFinite(v) || v < -500) continue;
        dem[i] = Math.round(v * 10);
        src[i] = SRC.COPERNICUS;
        filled++;
      }
      copTiles.push(name);
      log(`Copernicus ${name}: window ${ww}×${wh} px, ${filled} cells`);
    }
  }

  // ---- 2. LiDAR tiles
  const lidarTiles: string[] = [];
  for (const layer of cfg.lidarLayers) {
    report('lidar', 15, `LiDAR index ${layer.split('/services/')[1] ?? layer}`);
    const feats: { url: string; name: string }[] = [];
    let offset = 0;
    for (;;) {
      const q = `${layer}/query?geometry=${lonMin},${latMin},${lonMax},${latMax}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=DATA_URL,DATA_NAME&returnGeometry=false&resultOffset=${offset}&resultRecordCount=500&f=json`;
      const res = (await withRetry('LiDAR index', async () => {
        const r = await fetchImpl(q, { headers: { 'user-agent': UA } });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      }, 3, log)) as { features?: { attributes: { DATA_URL?: string; DATA_NAME?: string } }[]; exceededTransferLimit?: boolean; error?: { message: string } };
      if (res.error) throw new Error(`LiDAR index: ${res.error.message}`);
      for (const f of res.features ?? []) if (f.attributes.DATA_URL) feats.push({ url: f.attributes.DATA_URL, name: f.attributes.DATA_NAME ?? path.basename(f.attributes.DATA_URL, '.zip') });
      if (!res.exceededTransferLimit || !res.features?.length) break;
      offset += res.features.length;
    }
    log(`LiDAR ${layer.split('/').slice(-3, -2)[0]}: ${feats.length} tiles`);
    let k = 0;
    for (const t of feats) {
      k++;
      report('lidar', 15 + (25 * k) / Math.max(1, feats.length), `LiDAR tile ${t.name} (${k}/${feats.length})`);
      const zipPath = path.join(cache, 'lidar', `${t.name}.zip`);
      let zip: Uint8Array;
      if (!opts.refreshLidar && fs.existsSync(zipPath)) zip = new Uint8Array(fs.readFileSync(zipPath));
      else {
        try {
          zip = await withRetry(`LiDAR ${t.name}`, async () => {
            const r = await fetchImpl(t.url, { headers: { 'user-agent': UA } });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return new Uint8Array(await r.arrayBuffer());
          }, 2, log);
          fs.writeFileSync(zipPath, zip);
        } catch (e) {
          log(`LiDAR ${t.name}: skipped (${e instanceof Error ? e.message : String(e)})`);
          continue;
        }
      }
      let files: Record<string, Uint8Array>;
      try {
        files = unzipSync(zip, { filter: (f) => /\.tiff?$/i.test(f.name) && !/_DSM\.tiff?$/i.test(f.name) });
      } catch {
        log(`LiDAR ${t.name}: not a readable zip, skipped`);
        continue;
      }
      // OPW zips hold NAME_DTM.tif and NAME_DSM.tif; TII zips hold one NAME.tif, which is the DTM.
      const entry = Object.entries(files).find(([k]) => /_DTM\.tiff?$/i.test(k)) ?? (Object.keys(files).length === 1 ? Object.entries(files)[0] : undefined);
      if (!entry) { log(`LiDAR ${t.name}: no DTM in zip, skipped`); continue; }
      const tif = await fromArrayBuffer(entry[1].buffer.slice(entry[1].byteOffset, entry[1].byteOffset + entry[1].byteLength) as ArrayBuffer);
      const img = await tif.getImage();
      const [tx0, ty0, tx1, ty1] = img.getBoundingBox();
      const [prx] = img.getResolution();
      const W = img.getWidth(), H = img.getHeight();
      const nodata = img.getGDALNoData() ?? -9999;
      const [px] = (await img.readRasters()) as unknown as Float32Array[];
      const per = Math.max(1, Math.round(g.cellM / Math.abs(prx)));
      let set = 0;
      const c0 = Math.max(0, Math.floor((tx0 - g.x0) / g.cellM)), c1 = Math.min(g.cols - 1, Math.floor((tx1 - g.x0) / g.cellM));
      const r0 = Math.max(0, Math.floor((g.y0 - ty1) / g.cellM)), r1 = Math.min(g.rows - 1, Math.floor((g.y0 - ty0) / g.cellM));
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
        const cx = g.x0 + c * g.cellM, cy = g.y0 - r * g.cellM; // cell top-left
        const pc0 = Math.floor((cx - tx0) / Math.abs(prx)), pr0 = Math.floor((ty1 - cy) / Math.abs(prx));
        let sum = 0, cnt = 0;
        for (let dr = 0; dr < per; dr++) for (let dc = 0; dc < per; dc++) {
          const pr = pr0 + dr, pc = pc0 + dc;
          if (pr < 0 || pc < 0 || pr >= H || pc >= W) continue;
          const v = px[pr * W + pc];
          if (v === nodata || !Number.isFinite(v) || v <= -50) continue; // OPW uses -9999, TII -99 for "no data"
          sum += v; cnt++;
        }
        if (cnt * 2 >= per * per) {
          const i = r * g.cols + c;
          dem[i] = Math.round((sum / cnt) * 10);
          src[i] = SRC.LIDAR;
          set++;
        }
      }
      if (set) lidarTiles.push(t.name);
    }
  }
  log(`LiDAR: ${lidarTiles.length} tiles contributed`);

  // ---- 3. OSM
  const T = Math.max(1, cfg.osmTiles);
  const seenWays = new Set<number>(), seenRels = new Set<number>();
  const polys = new Map<number, XY[][][]>(); // class → list of ring sets
  for (const k of PAINT_ORDER) polys.set(k, []);
  const grid = (p: { lat: number; lon: number }): XY => { const [x, y] = toItm(p.lat, p.lon); return toGrid(g, x, y); };
  let overpassUsed: string | undefined;
  // In 'auto' a few minutes of failures is enough: the extract is the better bet by then.
  const budget = cfg.osmSource === 'auto' ? { leftMs: cfg.overpassBudgetS * 1000 } : undefined;
  let lines = 0, areas = 0;
  const places = new PlaceCollector();
  const seenNodes = new Set<number>();
  const handle = (els: OsmElement[]) => {
    for (const el of els) {
      const tags = el.tags ?? {};
      if (el.type === 'node') {
        if (seenNodes.has(el.id) || el.lat === undefined || el.lon === undefined) continue;
        seenNodes.add(el.id);
        places.add(tags, el.lat, el.lon);
      } else if (el.type === 'way') {
        if (seenWays.has(el.id) || !el.geometry || el.geometry.length < 2) continue;
        seenWays.add(el.id);
        places.addLine(tags, el.geometry);
        const pts = el.geometry.map(grid);
        const fl = lineFlag(tags);
        if (fl) {
          drawLine(g, pts, (i) => { flags[i] |= fl; });
          lines++;
        }
        const closed = el.geometry.length >= 4 && el.geometry[0].lat === el.geometry[el.geometry.length - 1].lat && el.geometry[0].lon === el.geometry[el.geometry.length - 1].lon;
        const ac = closed && tags.natural !== 'coastline' && tags.natural !== 'cliff' ? areaClass(tags) : undefined;
        if (ac !== undefined) { polys.get(ac)!.push([pts]); areas++; }
      } else if (el.type === 'relation') {
        if (seenRels.has(el.id)) continue;
        seenRels.add(el.id);
        const outer = (el.members ?? []).find((m) => m.role === 'outer' && m.geometry?.length);
        if (outer) places.addLine(tags, outer.geometry!);
        const ac = areaClass(tags);
        if (ac === undefined) continue;
        const rings = (el.members ?? []).filter((m) => m.type === 'way' && m.geometry && m.geometry.length >= 2).map((m) => m.geometry!.map(grid));
        if (rings.length) { polys.get(ac)!.push(rings); areas++; }
      }
    }
  };
  /** Fetch one box (cached); if every server fails on it, split it in four and try again, twice at most. */
  const fetchBox = async (id: string, s: number, w: number, nn: number, e: number, depth: number): Promise<void> => {
    const file = path.join(cache, 'osm', `tile_${id}.json`);
    let text: string | undefined;
    if (!opts.refreshOsm && fs.existsSync(file)) text = fs.readFileSync(file, 'utf8');
    else {
      const got = await overpassFetch(cfg.overpassUrls, overpassQuery(s, w, nn, e), id, { fetchImpl, log, budget });
      if (got) {
        text = got.text;
        overpassUsed = got.host;
        fs.writeFileSync(file, text);
      }
      if (!text) {
        if (depth >= 2) throw new Error(`OpenStreetMap: every Overpass server failed for box ${id}. Check network access to ${cfg.overpassUrls.map((u) => new URL(u).host).join(', ')}.`);
        log(`OSM box ${id} too big or servers busy: splitting in four`);
        const ms = (s + nn) / 2, mw = (w + e) / 2;
        await fetchBox(`${id}a`, s, w, ms, mw, depth + 1);
        await fetchBox(`${id}b`, s, mw, ms, e, depth + 1);
        await fetchBox(`${id}c`, ms, w, nn, mw, depth + 1);
        await fetchBox(`${id}d`, ms, mw, nn, e, depth + 1);
        return;
      }
      await new Promise((r) => setTimeout(r, 1500)); // be polite to the public servers
    }
    handle((JSON.parse(text) as { elements: OsmElement[] }).elements);
  };
  let osmFrom = '';
  const fromExtract = async () => {
    const file = path.join(cache, 'osm', 'extract.osm.pbf');
    if (opts.refreshOsm || !fs.existsSync(file)) {
      report('osm', 42, `Downloading the OpenStreetMap extract (${cfg.osmExtractUrl.split('/').pop()})`);
      log(`OSM: downloading ${cfg.osmExtractUrl}`);
      const r = await fetchImpl(cfg.osmExtractUrl, { headers: { 'user-agent': UA } });
      if (!r.ok || !r.body) throw new Error(`OSM extract: HTTP ${r.status}`);
      await pipeline(Readable.fromWeb(r.body as unknown as import('node:stream/web').ReadableStream), fs.createWriteStream(`${file}.part`));
      fs.renameSync(`${file}.part`, file);
      log(`OSM: extract saved (${Math.round(fs.statSync(file).size / 1e6)} MB)`);
    }
    const res = readPbf(file, {
      bbox: cfg.bbox,
      wantWay: (t) => lineFlag(t) !== 0 || areaClass(t) !== undefined || placeKind(t) !== undefined,
      wantRelation: (t) => areaClass(t) !== undefined || placeKind(t) !== undefined,
      wantNode: (t) => placeKind(t) !== undefined && !t.highway,
      onNode: (nd) => handle([{ type: 'node', id: nd.id, tags: nd.tags, lat: nd.lat, lon: nd.lon }]),
      onWay: (w) => handle([{ type: 'way', id: w.id, tags: w.tags, geometry: w.geometry }]),
      onRelation: (rel) => handle([{ type: 'relation', id: rel.id, tags: rel.tags, members: rel.members }]),
      onProgress: (pass, f) => report('osm', 45 + (pass - 1) * 18 + f * 18, `Reading the OpenStreetMap extract (pass ${pass} of 2, ${Math.round(f * 100)} %)`),
    });
    log(`OSM extract: ${res.nodes} nodes in the box, ${res.ways} ways, ${res.relations} relations`);
    osmFrom = `extract ${cfg.osmExtractUrl.split('/').pop()}`;
  };
  const fromOverpass = async () => {
  for (let ti = 0; ti < T; ti++) for (let tj = 0; tj < T; tj++) {
    const s = latMin + ((latMax - latMin) * ti) / T, nn = latMin + ((latMax - latMin) * (ti + 1)) / T;
    const w = lonMin + ((lonMax - lonMin) * tj) / T, e = lonMin + ((lonMax - lonMin) * (tj + 1)) / T;
    report('osm', 40 + (40 * (ti * T + tj)) / (T * T), `OpenStreetMap tile ${ti * T + tj + 1}/${T * T}`);
    // a box cached from an earlier split is reused as its four parts
    const id = `${ti}_${tj}`;
    if (!opts.refreshOsm && !fs.existsSync(path.join(cache, 'osm', `tile_${id}.json`)) && fs.existsSync(path.join(cache, 'osm', `tile_${id}a.json`))) {
      const ms = (s + nn) / 2, mw = (w + e) / 2;
      await fetchBox(`${id}a`, s, w, ms, mw, 1); await fetchBox(`${id}b`, s, mw, ms, e, 1); await fetchBox(`${id}c`, ms, w, nn, mw, 1); await fetchBox(`${id}d`, ms, mw, nn, e, 1);
    } else await fetchBox(id, s, w, nn, e, 0);
  }
  osmFrom = overpassUsed ? `Overpass ${overpassUsed}` : 'Overpass (cached)';
  };
  if (cfg.osmSource === 'extract') await fromExtract();
  else {
    try {
      await fromOverpass();
    } catch (e) {
      if (cfg.osmSource === 'overpass') throw e;
      log(`Overpass failed (${e instanceof Error ? e.message : String(e)}); using the extract instead`);
      await fromExtract();
    }
  }
  log(`OSM: ${seenWays.size} ways, ${seenRels.size} relations; ${lines} lines and ${areas} areas drawn (${osmFrom})`);

  report('rasterise', 82, 'Painting land use');
  for (const k of PAINT_ORDER) for (const rings of polys.get(k)!) fillRings(g, rings, (i) => { cls[i] = k; });

  // ---- 4. Sea: flood fill from the east edge (open sea along the whole bbox), stopped by the coastline.
  report('sea', 90, 'Marking the sea');
  floodSea(g, cls, flags, dem, src);

  // ---- stats, write
  let lid = 0, cop = 0, none = 0, sea = 0;
  for (let i = 0; i < n; i++) {
    if (cls[i] === CLASS.SEA) { sea++; continue; }
    if (src[i] === SRC.LIDAR) lid++; else if (src[i] === SRC.COPERNICUS) cop++; else none++;
  }
  const land = Math.max(1, n - sea);
  const meta: TerrainMeta = {
    version: 1,
    crs: 'EPSG:2157',
    ...g,
    bbox: cfg.bbox,
    builtAt: new Date().toISOString(),
    coverage: { lidarPct: Math.round((lid / land) * 1000) / 10, copernicusPct: Math.round((cop / land) * 1000) / 10, nonePct: Math.round((none / land) * 1000) / 10, seaPct: Math.round((sea / n) * 1000) / 10 },
    sources: { lidarTiles, copernicusTiles: copTiles, osmTiles: T * T, osmFetchedAt: new Date().toISOString(), overpass: osmFrom },
    attribution: [
      'Contains Irish Public Sector Data (Geological Survey Ireland & the Office of Public Works) licensed under a Creative Commons Attribution 4.0 International (CC BY 4.0) licence.',
      'LiDAR © Government of Ireland, Transport Infrastructure Ireland, licensed under CC BY 4.0.',
      'Copernicus DEM GLO-30 © DLR e.V. 2010–2014 and © Airbus Defence and Space GmbH 2014–2018, provided under COPERNICUS by the European Union and ESA.',
      'Map data © OpenStreetMap contributors (ODbL).',
    ],
  };
  report('write', 96, 'Writing rasters');
  writeTerrain(dir, { meta, dem, cls, flags, src });
  writePlaces(dir, places.places);
  log(`places: ${places.places.length} named places, roads and paths for search`);
  log(`done: land ${lid ? `${meta.coverage.lidarPct}% LiDAR, ` : ''}${meta.coverage.copernicusPct}% Copernicus, ${meta.coverage.nonePct}% no height; sea ${meta.coverage.seaPct}% of grid`);
  report('done', 100, 'Terrain data built');
  return meta;
}
