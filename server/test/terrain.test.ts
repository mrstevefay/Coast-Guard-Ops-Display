import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { areaClass, floodSea, gridFor, lineFlag } from '../src/terrain/build.js';
import { CLASS, FLAG, MAX_SLOPE, passable, slopeFactor } from '../src/terrain/classes.js';
import { regionPolygons } from '../src/terrain/contours.js';
import { costDistance, type CostGrid } from '../src/terrain/dijkstra.js';
import { fromItm, toItm } from '../src/terrain/itm.js';
import { DEM_NODATA, SRC, writeTerrain, type GridSpec, type TerrainData } from '../src/terrain/raster.js';
import { drawLine, fillRings, type XY } from '../src/terrain/rasterise.js';
import { TerrainService } from '../src/terrain/service.js';
import { testApp } from './helpers/app.js';

describe('Irish Transverse Mercator', () => {
  it('maps the false origin and round-trips to the millimetre', () => {
    const [e, n] = toItm(53.5, -8);
    expect(e).toBeCloseTo(600000, 3);
    expect(n).toBeCloseTo(750000, 3);
    for (const [lat, lon] of [[53.3905, -6.068], [53.5833, -6.1], [51.9, -10.3], [55.2, -7.4]]) {
      const [x, y] = toItm(lat, lon);
      const [la, lo] = fromItm(x, y);
      expect(Math.abs(la - lat) * 111_000).toBeLessThan(0.001);
      expect(Math.abs(lo - lon) * 66_000).toBeLessThan(0.001);
    }
  });
  it('agrees with GSI\'s own projection of a LiDAR tile at Howth to the centimetre', () => {
    // OPW_3392 is exactly 730000–732000 E, 738000–740000 N; GSI's FeatureServer returned these WGS84 corners (outSR=4326)
    const corners: [number, number, number, number][] = [
      [53.3941324, -6.0453643, 730000, 740000], [53.3936365, -6.0153126, 732000, 740000],
      [53.3756736, -6.0161482, 732000, 738000], [53.3761692, -6.0461872, 730000, 738000],
    ];
    for (const [lat, lon, e, n] of corners) {
      const [x, y] = toItm(lat, lon);
      expect(Math.abs(x - e)).toBeLessThan(0.05);
      expect(Math.abs(y - n)).toBeLessThan(0.05);
    }
  });
});

describe('effort model', () => {
  it('flat ground costs its distance; climbing costs more; gentle descent never less; cliffs block', () => {
    expect(slopeFactor(0, 10)).toBe(1);
    expect(slopeFactor(2, 10)).toBeGreaterThan(1.5);
    expect(slopeFactor(-0.5, 10)).toBe(1);
    expect(slopeFactor(10, 10)).toBe(Infinity); // 45°
    expect(slopeFactor(10, 10, true)).toBeLessThan(Infinity); // steps
    expect(Math.atan(MAX_SLOPE) * (180 / Math.PI)).toBeCloseTo(35, 5);
    expect(passable(CLASS.SEA, 0)).toBe(false);
    expect(passable(CLASS.SEA, FLAG.TRAVEL)).toBe(true); // a pier
    expect(passable(CLASS.GRASS, FLAG.CLIFF)).toBe(false);
    expect(passable(CLASS.GRASS, FLAG.RAIL)).toBe(false);
    expect(passable(CLASS.GRASS, FLAG.RAIL | FLAG.TRAVEL)).toBe(true); // level crossing
    expect(passable(CLASS.GRASS, FLAG.CLIFF | FLAG.TRAVEL)).toBe(false); // a path never makes a cliff walkable
  });
  it('maps OSM tags to classes and flags', () => {
    expect(areaClass({ natural: 'water' })).toBe(CLASS.WATER);
    expect(areaClass({ landuse: 'forest' })).toBe(CLASS.WOOD);
    expect(areaClass({ leisure: 'golf_course' })).toBe(CLASS.GRASS);
    expect(areaClass({ landuse: 'residential' })).toBe(CLASS.URBAN);
    expect(areaClass({ building: 'yes' })).toBeUndefined();
    expect(lineFlag({ highway: 'footway' })).toBe(FLAG.TRAVEL);
    expect(lineFlag({ highway: 'motorway' })).toBe(FLAG.MOTORWAY);
    expect(lineFlag({ highway: 'primary', tunnel: 'yes' })).toBe(0);
    expect(lineFlag({ railway: 'rail' })).toBe(FLAG.RAIL);
    expect(lineFlag({ natural: 'cliff' })).toBe(FLAG.CLIFF);
    expect(lineFlag({ man_made: 'pier' })).toBe(FLAG.TRAVEL);
    expect(lineFlag({ waterway: 'river' })).toBe(FLAG.RIVER);
    expect(lineFlag({ waterway: 'ditch' })).toBe(FLAG.STREAM);
  });
});

describe('rasterising', () => {
  const g: GridSpec = { x0: 0, y0: 100, cellM: 1, cols: 100, rows: 100 };
  it('draws 4-connected lines', () => {
    const cells: number[] = [];
    drawLine(g, [[0.5, 0.5], [40.5, 17.5]], (i) => cells.push(i));
    for (let k = 1; k < cells.length; k++) {
      const a = cells[k - 1], b = cells[k];
      const d = Math.abs((a % 100) - (b % 100)) + Math.abs(Math.floor(a / 100) - Math.floor(b / 100));
      expect(d).toBe(1);
    }
    expect(cells[cells.length - 1]).toBe(17 * 100 + 40);
  });
  it('fills polygons with holes (even-odd)', () => {
    const sq = (x0: number, y0: number, s: number): XY[] => [[x0, y0], [x0 + s, y0], [x0 + s, y0 + s], [x0, y0 + s], [x0, y0]];
    let n = 0;
    fillRings(g, [sq(10, 10, 40), sq(20, 20, 10)], () => n++);
    expect(n).toBe(40 * 40 - 10 * 10);
  });
  it('floods the sea from the east edge but not past a coastline', () => {
    const gg: GridSpec = { x0: 0, y0: 50, cellM: 1, cols: 50, rows: 50 };
    const n = 50 * 50;
    const cls = new Uint8Array(n), flags = new Uint8Array(n), dem = new Int16Array(n), src = new Uint8Array(n);
    drawLine(gg, [[30.5, -1], [30.5, 51]], (i) => { flags[i] |= FLAG.COAST; });
    floodSea(gg, cls, flags, dem, src);
    expect(cls[10 * 50 + 45]).toBe(CLASS.SEA);
    expect(cls[10 * 50 + 10]).toBe(CLASS.OPEN);
    expect(cls[10 * 50 + 30]).toBe(CLASS.OPEN); // the coastline cell is land
  });
});

/** A synthetic grid centred on Howth so the lat/lon conversions are realistic. */
function synthetic(size: number, cellM: number, paint: (c: number, r: number) => { cls?: number; flags?: number; h?: number }): TerrainData {
  const [cx, cy] = toItm(53.38, -6.06);
  const x0 = Math.round(cx / cellM) * cellM - (size / 2) * cellM, y0 = Math.round(cy / cellM) * cellM + (size / 2) * cellM;
  const n = size * size;
  const dem = new Int16Array(n), cls = new Uint8Array(n), flags = new Uint8Array(n), src = new Uint8Array(n).fill(SRC.LIDAR);
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
    const p = paint(c, r), i = r * size + c;
    cls[i] = p.cls ?? CLASS.OPEN;
    flags[i] = p.flags ?? 0;
    dem[i] = p.h === undefined ? 0 : Math.round(p.h * 10);
  }
  return {
    meta: { version: 1, crs: 'EPSG:2157', x0, y0, cellM, cols: size, rows: size, bbox: [-6.1, 53.35, -6.0, 53.41], builtAt: '2026-11-06T00:00:00Z', coverage: { lidarPct: 100, copernicusPct: 0, nonePct: 0, seaPct: 0 }, sources: { lidarTiles: [], copernicusTiles: [], osmTiles: 0 }, attribution: [] },
    dem, cls, flags, src,
  };
}

function toCost(t: TerrainData): CostGrid {
  const n = t.meta.cols * t.meta.rows;
  const dem = new Float32Array(n);
  for (let i = 0; i < n; i++) dem[i] = t.dem[i] === DEM_NODATA ? NaN : t.dem[i] / 10;
  return { cols: t.meta.cols, rows: t.meta.rows, cellM: t.meta.cellM, dem, cls: t.cls, flags: t.flags };
}

describe('cost distance', () => {
  it('on flat open ground the region is nearly the circle (16-direction metric)', async () => {
    const t = synthetic(201, 10, () => ({}));
    const g = toCost(t);
    const dist = await costDistance(g, [100 * 201 + 100], 1000);
    // straight east 50 cells = 500 m
    expect(dist[100 * 201 + 150]).toBeCloseTo(500, 3);
    // never less than straight-line
    for (let k = 0; k < 2000; k++) {
      const i = Math.floor(Math.random() * dist.length);
      const c = i % 201, r = Math.floor(i / 201);
      const eu = Math.hypot(c - 100, r - 100) * 10;
      if (Number.isFinite(dist[i])) expect(dist[i]).toBeGreaterThanOrEqual(eu - 1e-3);
    }
    const [reg] = regionPolygons(dist, t.meta, [1000]);
    const ratio = reg.areaM2 / (Math.PI * 1000 ** 2);
    expect(ratio).toBeGreaterThan(0.95);
    expect(ratio).toBeLessThanOrEqual(1.01);
  });

  it('goes round a wall through its gap, never through it', async () => {
    const t = synthetic(101, 10, (c, r) => (c === 60 && r !== 10 ? { flags: FLAG.CLIFF } : {}));
    const dist = await costDistance(toCost(t), [50 * 101 + 50], 5000);
    const behind = dist[50 * 101 + 70];
    expect(behind).toBeGreaterThan(200 * 1.5); // straight is 200 m; must go via the gap at row 10
    expect(dist[50 * 101 + 60]).toBe(Infinity);
  });

  it('a steep hill shrinks the region uphill only', async () => {
    // slope rises 0.3 per metre to the north (rows decrease northwards)
    const t = synthetic(201, 10, (_c, r) => ({ h: Math.max(0, (100 - r) * 10 * 0.3) }));
    const dist = await costDistance(toCost(t), [100 * 201 + 100], 2000);
    const north = dist[50 * 201 + 100], south = dist[150 * 201 + 100];
    expect(south).toBeCloseTo(500, 0);
    expect(north).toBeGreaterThan(south * 1.8);
  });

  it('headland: a land strip in the sea gives a region along the strip, not a circle', async () => {
    // land 300 m wide running east-west through the centre, sea north and south, and a cliff line on the north edge
    const t = synthetic(301, 10, (_c, r) => (Math.abs(r - 150) <= 15 ? (r === 135 ? { flags: FLAG.CLIFF } : {}) : { cls: CLASS.SEA }));
    const svc = await withService(t);
    const area = await svc.searchArea(centreLatLon(t), [{ pct: 50, km: 1 }]);
    const reg = area.regions[0];
    expect(reg.ratio).toBeLessThan(0.25); // ~0.28 km² of strip against a 3.14 km² circle
    expect(reg.ratio).toBeGreaterThan(0.12);
    const lons = reg.geometry.coordinates.flat(2).map((p) => p[0]);
    const lats = reg.geometry.coordinates.flat(2).map((p) => p[1]);
    const ewKm = (Math.max(...lons) - Math.min(...lons)) * 66.4, nsKm = (Math.max(...lats) - Math.min(...lats)) * 111.2;
    expect(ewKm).toBeGreaterThan(1.8);
    expect(nsKm).toBeLessThan(0.35);
  });

  it('a planning point in the sea is moved to the nearest land, and says so', async () => {
    const t = synthetic(101, 10, (c) => (c < 50 ? {} : { cls: CLASS.SEA }));
    const svc = await withService(t);
    const [x0, y0] = [t.meta.x0 + 55.5 * 10, t.meta.y0 - 50.5 * 10];
    const [lat, lon] = fromItm(x0, y0);
    const area = await svc.searchArea({ lat, lon }, [{ pct: 50, km: 0.3 }]);
    expect(area.startMovedM).toBeGreaterThan(40);
    expect(area.warnings.some((w) => w.includes('nearest walkable point'))).toBe(true);
  });
});

const tmpDirs: string[] = [];
async function withService(t: TerrainData): Promise<TerrainService> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-terrain-'));
  tmpDirs.push(dir);
  writeTerrain(dir, t);
  return new TerrainService(dir, undefined);
}
function centreLatLon(t: TerrainData): { lat: number; lon: number } {
  const [lat, lon] = fromItm(t.meta.x0 + (t.meta.cols / 2) * t.meta.cellM, t.meta.y0 - (t.meta.rows / 2) * t.meta.cellM);
  return { lat, lon };
}
afterAll(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

describe('grid for the station bbox', () => {
  it('covers Dublin city centre to Skerries at 10 m', () => {
    const g = gridFor([-6.35, 53.33, -5.95, 53.6], 10);
    expect(g.cols).toBeGreaterThan(2600);
    expect(g.rows).toBeGreaterThan(2900);
    expect(g.cols * g.rows).toBeLessThan(9_000_000);
  });
});

describe('search area over the API', () => {
  let t: Awaited<ReturnType<typeof testApp>>;
  let manager: string, member: string;
  let id: string;
  const json = (r: { body: string }) => JSON.parse(r.body);
  beforeAll(async () => {
    t = await testApp();
    manager = await t.login('manager');
    member = await t.login('member');
    id = json(await t.app.inject({ method: 'POST', url: '/api/incidents', headers: { cookie: manager }, payload: { text: 'terrain test' } })).incident.id;
  });
  afterAll(async () => t.close());
  const area = () => t.app.inject({ method: 'GET', url: `/api/incidents/${id}/search-area`, headers: { cookie: member } });

  it('explains what is missing, then returns regions once terrain exists', async () => {
    expect((await area()).statusCode).toBe(409); // no point yet
    await t.app.inject({ method: 'POST', url: `/api/incidents/${id}/points`, headers: { cookie: manager }, payload: { kind: 'lkp', lat: 53.38, lon: -6.06 } });
    expect((await area()).statusCode).toBe(409); // no category yet
    await t.app.inject({ method: 'PUT', url: `/api/incidents/${id}/subject`, headers: { cookie: manager }, payload: { category: 'dementia', sex: 'Male' } });
    const notBuilt = await area();
    expect(notBuilt.statusCode).toBe(503);
    expect(json(notBuilt).error).toMatch(/Settings → Terrain/);
    // a flat synthetic grid under the station dataDir
    const flat = synthetic(2201, 10, () => ({}));
    writeTerrain(path.join(t.cfg.server.dataDir, 'terrain'), flat);
    const ok = await area();
    expect(ok.statusCode).toBe(200);
    const a = json(ok).area;
    expect(a.regions.map((r: { pct: number }) => r.pct)).toEqual([50, 75, 90]); // dementia: 25 % is at 0 km
    expect(a.regions[2].km).toBe(8);
    expect(a.regions[0].ratio).toBeGreaterThan(0.95); // the 1 km ring is on the fine 10 m grid
    expect(a.regions[0].cellM).toBe(10);
    expect(a.regions[2].cellM).toBe(20); // 8 km does not fit at 10 m
    expect(a.cellM).toBe(10);
    expect(a.warnings.some((w: string) => w.includes('straight-line statistics'))).toBe(true);
  });

  it('terrain status and build are admin-only', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/admin/terrain', headers: { cookie: manager } })).statusCode).toBe(403);
    const admin = await t.login('admin');
    const st = json(await t.app.inject({ method: 'GET', url: '/api/admin/terrain', headers: { cookie: admin } }));
    expect(st.built).toBe(true);
    expect(st.size).toEqual({ cols: 2201, rows: 2201 });
  });
});

describe('probability of area, segments and corridors', () => {
  it('bands carry the share at the point and each band between rings', async () => {
    const { bandsFor } = await import('../src/terrain/weights.js');
    const b = bandsFor([{ pct: 50, km: 1 }, { pct: 75, km: 2.75 }, { pct: 90, km: 8 }], 30);
    expect(b).toEqual([{ fromM: 0, toM: 60, mass: 0.3 }, { fromM: 0, toM: 1000, mass: 0.2 }, { fromM: 1000, toM: 2750, mass: 0.25 }, { fromM: 2750, toM: 8000, mass: 0.15 }]);
    expect(b.reduce((s, x) => s + x.mass, 0)).toBeCloseTo(0.9, 10);
    expect(bandsFor([{ pct: 70, km: 1.1 }, { pct: 90, km: 4 }], 50)[1]).toEqual({ fromM: 0, toM: 1100, mass: 0.2 });
  });

  it('conserves mass, favours the ground this category is found on, and weights corridors', async () => {
    const { computeWeights, bandsFor, LOC } = await import('../src/terrain/weights.js');
    const { cutWindow } = await import('../src/terrain/window.js');
    // flat open ground with a road running east-west through the centre
    const t = synthetic(201, 10, (_c, r) => (r === 100 ? { flags: FLAG.TRAVEL } : {}));
    const [cx, cy] = [t.meta.x0 + 100.5 * 10, t.meta.y0 - 100.5 * 10];
    const w = cutWindow(t, cx, cy, 950);
    const mid = Math.floor(w.cols / 2);
    const dist = await costDistance(w, [mid * w.cols + mid], 900);
    const bands = bandsFor([{ pct: 50, km: 0.4 }, { pct: 90, km: 0.9 }], 0);
    const dest = (mid - 60) * w.cols + (mid + 30);
    const res = computeWeights(w, dist, { bands, shares: { 'Travel Aid': 50, 'Open Ground': 50 }, destinations: [dest] });
    expect(res.total).toBeCloseTo(0.9, 3);
    const road = mid * w.cols + (mid + 20), field = (mid + 20) * w.cols + mid;
    expect(res.type[road]).toBe(LOC.TRAVEL);
    expect(res.type[field]).toBe(LOC.OPEN);
    expect(res.poa[road]).toBeGreaterThan(res.poa[field] * 3);
    expect(res.corridors).toHaveLength(1);
    expect(res.corridors[0][0]).toBe(mid * w.cols + mid);
    expect(res.corridors[0][res.corridors[0].length - 1]).toBe(dest);
    const nearDest = (mid - 60) * w.cols + (mid + 32), farField = (mid + 60) * w.cols + (mid - 30);
    expect(res.poa[nearDest]).toBeGreaterThan(res.poa[farField] * 2);
  });

  it('search area returns heat, ranked segments that fit a target, and the corridor', async () => {
    const t = synthetic(301, 10, (_c, r) => (Math.abs(r - 150) <= 15 ? {} : { cls: CLASS.SEA }));
    const svc = await withService(t);
    const c = centreLatLon(t);
    const [x, y] = toItm(c.lat, c.lon);
    const [dlat, dlon] = fromItm(x + 800, y);
    const area = await svc.searchArea(c, [{ pct: 50, km: 0.5 }, { pct: 90, km: 1.2 }], { zeroPct: 10, shares: { 'Open Ground': 60, 'Travel Aid': 40 }, significant: [{ lat: dlat, lon: dlon, label: 'Viewpoint' }] });
    expect(area.modelledPct).toBeCloseTo(90, 0);
    expect(area.heat?.url).toMatch(/^data:image\/png;base64,/);
    expect(area.heat?.coordinates).toHaveLength(4);
    const segs = area.segments!;
    expect(segs.length).toBeGreaterThan(3);
    for (let i = 1; i < segs.length; i++) expect(segs[i].poaPct).toBeLessThanOrEqual(segs[i - 1].poaPct);
    expect(segs.reduce((s, x) => s + x.poaPct, 0)).toBeLessThanOrEqual(90.5);
    for (const s of segs) {
      expect(s.targetRing.length).toBeGreaterThanOrEqual(4);
      expect(s.targetRing.length).toBeLessThanOrEqual(400);
      expect(s.targetRing[0]).toEqual(s.targetRing[s.targetRing.length - 1]);
    }
    expect(area.corridors).toHaveLength(1);
    expect(area.corridors![0]).toMatchObject({ label: 'Viewpoint' });
    expect(area.corridors![0].effortKm).toBeGreaterThanOrEqual(area.corridors![0].straightKm - 0.01);
  });

  it('drops barrier-width holes and specks from outlines', async () => {
    const { tidyPolygon } = await import('../src/terrain/contours.js');
    const sq = (x0: number, y0: number, w: number, h: number): [number, number][] => [[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h], [x0, y0]];
    const kept = tidyPolygon([sq(0, 0, 100, 100), sq(10, 50, 80, 1), sq(20, 20, 10, 10), sq(60, 20, 2, 2)])!;
    expect(kept).toHaveLength(2); // the thin motorway-like hole and the speck go; the 10×10 pond stays
    expect(tidyPolygon([sq(0, 0, 2, 2)])).toBeUndefined();
  });
});
