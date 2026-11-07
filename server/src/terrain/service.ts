import fs from 'node:fs';
import path from 'node:path';
import type { PlanningPointKind, SearchAreaRegion, SearchAreaResult, SearchSegment, TerrainStatus } from '../../../shared/types.js';
import { contours } from 'd3-contour';
import { encodePng } from './png.js';
import { bandsFor, computeWeights, LOC_NAME, type LocName } from './weights.js';
import { simplifyRing } from './contours.js';
import { buildTerrain, terrainConfig, type BuildOptions, type TerrainConfig } from './build.js';
import { CLASS } from './classes.js';
import { regionPolygons } from './contours.js';
import { costDistance, nearestPassable } from './dijkstra.js';
import { fromItm, toItm } from './itm.js';
import { readTerrain, SRC, terrainFilesExist, type TerrainData } from './raster.js';
import { cutWindow, type Window } from './window.js';

export interface Weighting {
  /** % of the category found at the point itself (0 km in the cumulative table). */
  zeroPct: number;
  /** Where the category is found, % by MISPER-UK location. */
  shares: Partial<Record<LocName, number>>;
  significant: { lat: number; lon: number; label?: string }[];
}

export interface RingSpec {
  pct: number;
  km: number;
  interpolated?: boolean;
}

interface Cached {
  key: string;
  window: Window;
  dist: Float32Array;
  maxM: number;
  startMovedM?: number;
}

/** Largest cost grid modelled at once (cells). 1.6 M ≈ 12.6 km square at 10 m. */
const MAX_CELLS = 1_600_000;

type Log = { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void };

/**
 * Station terrain: loads the prebuilt rasters lazily, runs builds in the background, and turns
 * a planning point plus ring distances into terrain-shaped regions. Effort fields are cached
 * per point so changing the subject's category only re-contours.
 */
export class TerrainService {
  readonly cfg: TerrainConfig;
  private data?: TerrainData;
  private loadedAt = 0;
  private cache: Cached[] = [];
  private job?: NonNullable<TerrainStatus['job']>;

  constructor(readonly dir: string, cfg: Partial<TerrainConfig> | undefined, private readonly log?: Log) {
    this.cfg = terrainConfig(cfg);
  }

  private load(): TerrainData | undefined {
    if (!terrainFilesExist(this.dir)) return undefined;
    const mtime = fs.statSync(path.join(this.dir, 'meta.json')).mtimeMs;
    if (!this.data || mtime > this.loadedAt) {
      this.data = readTerrain(this.dir);
      this.loadedAt = mtime;
      this.cache = [];
    }
    return this.data;
  }

  status(): TerrainStatus {
    let t: TerrainData | undefined;
    try {
      t = this.load();
    } catch (e) {
      return { built: false, job: this.job ?? { running: false, stage: 'error', pct: 0, message: e instanceof Error ? e.message : String(e), startedAt: '', log: [] } };
    }
    if (!t) return { built: false, job: this.job };
    const m = t.meta;
    return {
      built: true, builtAt: m.builtAt, bbox: m.bbox, cellM: m.cellM, size: { cols: m.cols, rows: m.rows }, coverage: m.coverage,
      sources: { lidarTiles: m.sources.lidarTiles.length, copernicusTiles: m.sources.copernicusTiles, osmTiles: m.sources.osmTiles, overpass: m.sources.overpass },
      attribution: m.attribution, job: this.job,
    };
  }

  /** Starts a background build. Returns false if one is already running. */
  startBuild(opts: Omit<BuildOptions, 'onProgress'> = {}): boolean {
    if (this.job?.running) return false;
    const job = { running: true, stage: 'start', pct: 0, message: 'Starting', startedAt: new Date().toISOString(), log: [] as string[] } as NonNullable<TerrainStatus['job']>;
    this.job = job;
    void buildTerrain(this.dir, this.cfg, { ...opts, onProgress: (p) => Object.assign(job, { stage: p.stage, pct: p.pct, message: p.message, log: p.log }) })
      .then((meta) => {
        Object.assign(job, { running: false, finishedAt: new Date().toISOString(), stage: 'done', pct: 100, message: 'Terrain data built' });
        this.data = undefined;
        this.log?.info({ coverage: meta.coverage }, 'terrain built');
      })
      .catch((e) => {
        Object.assign(job, { running: false, finishedAt: new Date().toISOString(), error: e instanceof Error ? e.message : String(e), message: 'Build failed' });
        this.log?.error({ err: e }, 'terrain build failed');
      });
    return true;
  }

  get built(): boolean {
    return terrainFilesExist(this.dir);
  }

  /** Effort field from the point over a window of `radiusM`, cached per point and resolution. */
  private async field(t: TerrainData, point: { lat: number; lon: number }, x: number, y: number, radiusM: number, maxM: number, coarse: boolean): Promise<Cached> {
    const key = `${point.lat.toFixed(5)},${point.lon.toFixed(5)}:${coarse ? 'c' : 'f'}`;
    const hit = this.cache.find((c) => c.key === key && c.maxM >= maxM);
    if (hit) return hit;
    const w = cutWindow(t, x, y, radiusM, MAX_CELLS);
    const c = Math.floor((x - w.x0) / w.cellM), r = Math.floor((w.y0 - y) / w.cellM);
    const startIdx = nearestPassable(w, c, r, Math.ceil(250 / w.cellM));
    if (startIdx < 0) throw Object.assign(new Error('no walkable ground within 250 m of the planning point (sea or cliff all round): check the point'), { code: 'NO_START' });
    let startMovedM: number | undefined;
    if (startIdx !== r * w.cols + c) {
      const sc = startIdx % w.cols, sr = (startIdx - sc) / w.cols;
      startMovedM = Math.round(Math.hypot(sc - c, sr - r) * w.cellM);
    }
    const dist = await costDistance(w, [startIdx], maxM * 1.001);
    const entry = { key, window: w, dist, maxM, startMovedM };
    this.cache.unshift(entry);
    this.cache = this.cache.slice(0, 6);
    return entry;
  }

  /** Heat overlay, ranked segments and corridors over the outermost region. */
  private weigh(hit: Cached, rings: RingSpec[], wt: Weighting, warnings: string[]): Pick<SearchAreaResult, 'heat' | 'segments' | 'corridors' | 'modelledPct' | 'atPointPct'> {
    const w = hit.window, dist = hit.dist;
    const outerM = rings[rings.length - 1].km * 1000;
    const bands = bandsFor(rings, wt.zeroPct);
    const ll = (c: number, r: number): [number, number] => { const [la, lo] = fromItm(w.x0 + c * w.cellM, w.y0 - r * w.cellM); return [Math.round(lo * 1e6) / 1e6, Math.round(la * 1e6) / 1e6]; };
    const destinations: number[] = [];
    const destLabels: string[] = [];
    for (const p of wt.significant) {
      const [x, y] = toItm(p.lat, p.lon);
      const c = Math.floor((x - w.x0) / w.cellM), r = Math.floor((w.y0 - y) / w.cellM);
      if (c < 0 || r < 0 || c >= w.cols || r >= w.rows) { warnings.push(`Significant place "${p.label ?? 'unnamed'}" is beyond the outer ring: no corridor drawn.`); continue; }
      const i = nearestPassable(w, c, r, Math.ceil(100 / w.cellM));
      if (i < 0 || !Number.isFinite(dist[i])) { warnings.push(`Significant place "${p.label ?? 'unnamed'}" cannot be reached on foot in the model (sea, cliff or too far): no corridor drawn.`); continue; }
      destinations.push(i);
      destLabels.push(p.label ?? 'Significant place');
    }
    const res = computeWeights(w, dist, { bands, shares: wt.shares, destinations });
    const n = w.cols * w.rows;

    // ---- heat: crop to the region, downsample to ≤ 640 px
    let c0 = w.cols, r0 = w.rows, c1 = -1, r1 = -1;
    for (let i = 0; i < n; i++) if (res.poa[i] > 0) { const c = i % w.cols, r = (i - c) / w.cols; if (c < c0) c0 = c; if (c > c1) c1 = c; if (r < r0) r0 = r; if (r > r1) r1 = r; }
    let heat: SearchAreaResult['heat'];
    if (c1 >= c0) {
      const f = Math.max(1, Math.ceil(Math.max(c1 - c0 + 1, r1 - r0 + 1) / 640));
      const W = Math.ceil((c1 - c0 + 1) / f), H = Math.ceil((r1 - r0 + 1) / f);
      const v = new Float64Array(W * H);
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) v[Math.floor((r - r0) / f) * W + Math.floor((c - c0) / f)] += res.poa[r * w.cols + c];
      const sorted = Array.from(v).filter((x) => x > 0).sort((a, b) => a - b);
      const top = sorted[Math.floor(sorted.length * 0.99)] || 1;
      const rgba = new Uint8Array(W * H * 4);
      for (let k = 0; k < W * H; k++) {
        const tval = Math.min(1, Math.sqrt(v[k] / top));
        if (tval < 0.03) continue;
        // yellow → orange → red
        const [rr, gg, bb] = tval < 0.5 ? [253, 224 - (tval / 0.5) * 109, 71 - (tval / 0.5) * 49] : [249 - ((tval - 0.5) / 0.5) * 29, 115 - ((tval - 0.5) / 0.5) * 77, 22 + ((tval - 0.5) / 0.5) * 16];
        rgba.set([rr, gg, bb, Math.round(50 + 170 * tval)], k * 4);
      }
      const png = encodePng(W, H, rgba);
      const cc1 = c0 + W * f, rr1 = r0 + H * f;
      heat = { url: `data:image/png;base64,${png.toString('base64')}`, coordinates: [ll(c0, r0), ll(cc1, r0), ll(cc1, rr1), ll(c0, rr1)] };
    }

    // ---- segments: squares sized to the search, clipped to the region, ranked by probability
    const outerKm = outerM / 1000;
    const segM = outerKm <= 2 ? 200 : outerKm <= 6 ? 400 : 800;
    const k = Math.max(1, Math.round(segM / w.cellM));
    const squares: { sc: number; sr: number; poa: number; cells: number; mix: Float64Array; band: Float64Array }[] = [];
    for (let sr = 0; sr * k < w.rows; sr++) for (let sc = 0; sc * k < w.cols; sc++) {
      let poa = 0, cells = 0;
      const mix = new Float64Array(LOC_NAME.length), band = new Float64Array(rings.length);
      for (let r = sr * k; r < Math.min(w.rows, (sr + 1) * k); r++) for (let c = sc * k; c < Math.min(w.cols, (sc + 1) * k); c++) {
        const i = r * w.cols + c;
        if (!(dist[i] <= outerM) || res.type[i] === 255) continue;
        poa += res.poa[i]; cells++; mix[res.type[i]]++;
        const bi = rings.findIndex((rg) => dist[i] <= rg.km * 1000);
        band[bi < 0 ? rings.length - 1 : bi]++;
      }
      if (cells >= k * k * 0.1 && poa > 0) squares.push({ sc, sr, poa, cells, mix, band });
    }
    squares.sort((a, b) => b.poa - a.poa);
    const gen = contours().smooth(false);
    const segments: SearchSegment[] = squares.slice(0, 12).map((q, idx) => {
      const cw = Math.min(k, w.cols - q.sc * k) + 2, ch = Math.min(k, w.rows - q.sr * k) + 2;
      const mask = new Array<number>(cw * ch).fill(0);
      for (let r = 0; r < ch - 2; r++) for (let c = 0; c < cw - 2; c++) {
        const i = (q.sr * k + r) * w.cols + (q.sc * k + c);
        if (dist[i] <= outerM && res.type[i] !== 255) mask[(r + 1) * cw + (c + 1)] = 1;
      }
      const mp = gen.size([cw, ch]).contour(mask, 0.5);
      const toLL = (ring: [number, number][]) => ring.map(([gx, gy]) => ll(q.sc * k + gx - 1, q.sr * k + gy - 1));
      const coordinates = mp.coordinates.map((poly) => poly.map((ring) => toLL(simplifyRing(ring as [number, number][], 0.5)))).filter((p) => p.length && p[0].length >= 4);
      const biggest = [...coordinates].sort((a, b) => b[0].length - a[0].length)[0]?.[0] ?? [];
      let target = biggest;
      for (let tol = 1; target.length > 400 && tol < 64; tol *= 2) target = simplifyRing(biggest, tol * 1e-5);
      const areaKm2 = (q.cells * w.cellM * w.cellM) / 1e6;
      const dom = LOC_NAME[q.mix.indexOf(Math.max(...q.mix))];
      const bi = q.band.indexOf(Math.max(...q.band));
      const poaPct = Math.round(q.poa * 1000) / 10;
      return { id: `S${idx + 1}`, rank: idx + 1, poaPct, areaKm2: Math.round(areaKm2 * 1000) / 1000, densityPerKm2: Math.round((poaPct / areaKm2) * 10) / 10, dominant: dom, band: `inside ${rings[bi].pct} %`, geometry: { type: 'MultiPolygon', coordinates }, targetRing: target };
    });

    // ---- corridors
    const corridors = res.corridors.map((p, i) => {
      const pts = simplifyRing(p.map((j) => { const c = j % w.cols, r = (j - c) / w.cols; return [c + 0.5, r + 0.5] as [number, number]; }), 0.8);
      const dest = p[p.length - 1], start = p[0];
      const dc = (dest % w.cols) - (start % w.cols), dr = Math.floor(dest / w.cols) - Math.floor(start / w.cols);
      return { label: destLabels[i], geometry: { type: 'LineString' as const, coordinates: pts.map(([gx, gy]) => ll(gx, gy)) }, effortKm: Math.round(dist[dest] / 10) / 100, straightKm: Math.round(Math.hypot(dc, dr) * w.cellM / 10) / 100 };
    });
    return { heat, segments, corridors, modelledPct: Math.round(res.total * 1000) / 10, atPointPct: wt.zeroPct };
  }

  async searchArea(point: { lat: number; lon: number; kind?: PlanningPointKind | 'ipp' }, rings: RingSpec[], weighting?: Weighting): Promise<SearchAreaResult> {
    const t = this.load();
    if (!t) throw Object.assign(new Error('terrain data has not been built: an admin can build it under Settings → Terrain'), { code: 'NOT_BUILT' });
    const started = Date.now();
    const usable = rings.filter((r) => r.km > 0).sort((a, b) => a.km - b.km);
    const warnings: string[] = [];
    if (!usable.length) return { point: { lat: point.lat, lon: point.lon, kind: point.kind ?? 'ipp' }, regions: [], cellM: t.meta.cellM, coverage: { lidarPct: 0, copernicusPct: 0, nonePct: 0 }, warnings: ['No distance above 0 km for this category: search the planning point itself.'], computedMs: 0, builtAt: t.meta.builtAt };
    const [x, y] = toItm(point.lat, point.lon);
    const g = t.meta;
    if (x < g.x0 || x > g.x0 + g.cols * g.cellM || y > g.y0 || y < g.y0 - g.rows * g.cellM) throw Object.assign(new Error('the planning point is outside the terrain data area'), { code: 'OUTSIDE' });
    // Rings that fit a full-resolution window are modelled on it; longer ones share one coarser window.
    const radiusFor = (km: number) => km * 1000 * 1.02 + 200;
    const fineMaxM = (Math.sqrt(MAX_CELLS) * g.cellM) / 2;
    const fine = usable.filter((r) => radiusFor(r.km) <= fineMaxM);
    const coarse = usable.filter((r) => radiusFor(r.km) > fineMaxM);
    const groups = [fine, coarse].filter((grp) => grp.length);
    const regions: SearchAreaRegion[] = [];
    let startMovedM: number | undefined;
    let cov = { lid: 0, cop: 0, none: 0 };
    let touches = 0, cellMin = Infinity, coarseCell = 0;
    let outerHit: Cached | undefined;
    for (const grp of groups) {
      const maxM = grp[grp.length - 1].km * 1000;
      const hit = await this.field(t, point, x, y, radiusFor(grp[grp.length - 1].km), maxM, grp === coarse);
      startMovedM ??= hit.startMovedM;
      const w = hit.window;
      cellMin = Math.min(cellMin, w.cellM);
      if (grp === coarse) coarseCell = w.cellM;
      const geo = regionPolygons(hit.dist, w, grp.map((r) => r.km * 1000));
      grp.forEach((r, i) => {
        const areaKm2 = geo[i].areaM2 / 1e6, circleKm2 = Math.PI * r.km * r.km;
        regions.push({ pct: r.pct, km: r.km, interpolated: Boolean(r.interpolated), cellM: w.cellM, areaKm2: Math.round(areaKm2 * 1000) / 1000, circleKm2: Math.round(circleKm2 * 1000) / 1000, ratio: Math.round((areaKm2 / circleKm2) * 100) / 100, geometry: geo[i].geometry });
      });
      // coverage and edge checks inside this group's largest region
      const c = { lid: 0, cop: 0, none: 0 };
      for (let i = 0; i < hit.dist.length; i++) {
        if (!(hit.dist[i] <= maxM)) continue;
        if (w.cls[i] === CLASS.OUT) { touches++; continue; }
        if (w.src[i] === SRC.LIDAR) c.lid++; else if (w.src[i] === SRC.COPERNICUS) c.cop++; else c.none++;
        const cc = i % w.cols, rr = (i - cc) / w.cols;
        if (cc === 0 || rr === 0 || cc === w.cols - 1 || rr === w.rows - 1 || w.cls[i - 1] === CLASS.OUT || w.cls[i + 1] === CLASS.OUT || w.cls[i - w.cols] === CLASS.OUT || w.cls[i + w.cols] === CLASS.OUT) touches++;
      }
      cov = c; // the outermost group describes the whole search area
      outerHit = hit;
    }
    const extras = weighting && outerHit ? this.weigh(outerHit, usable, weighting, warnings) : {};
    regions.sort((p, q) => p.km - q.km);
    const land = Math.max(1, cov.lid + cov.cop + cov.none);
    const coverage = { lidarPct: Math.round((cov.lid / land) * 100), copernicusPct: Math.round((cov.cop / land) * 100), nonePct: Math.round((cov.none / land) * 100) };
    if (startMovedM) warnings.push(`The planning point is not on walkable ground (sea, water or a cliff); the area is drawn from the nearest walkable point, ${startMovedM} m away.`);
    if (touches > 0) warnings.push('The largest area reaches the edge of the terrain data; the shape beyond it is cut off.');
    if (coverage.copernicusPct > 50) warnings.push(`Heights here are mostly 30 m satellite data (${coverage.copernicusPct} %): small cliffs, quarries and embankments can be missed. Mapped cliffs and paths are still used.`);
    if (coarseCell) warnings.push(`Rings beyond ${Math.floor(fineMaxM / 1000)} km are modelled on a ${coarseCell} m grid, so narrow paths and gaps are coarser there.`);
    warnings.push('The distances are straight-line statistics; the shapes are a walking-effort model of where that distance can take someone on this ground. Use the circle as the outer reference.');
    const [la, lo] = fromItm(x, y);
    return { point: { lat: Math.round(la * 1e6) / 1e6, lon: Math.round(lo * 1e6) / 1e6, kind: point.kind ?? 'ipp' }, regions, cellM: cellMin, coverage, startMovedM, warnings, computedMs: Date.now() - started, builtAt: t.meta.builtAt, ...extras };
  }
}
