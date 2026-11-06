/** Effort field → region polygons in lat/lon. */
import { contours } from 'd3-contour';
import { fromItm } from './itm.js';
import type { GridSpec } from './raster.js';

type Ring = [number, number][];

function sqSegDist(p: [number, number], a: [number, number], b: [number, number]): number {
  let x = a[0], y = a[1];
  let dx = b[0] - x, dy = b[1] - y;
  if (dx !== 0 || dy !== 0) {
    const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) { x = b[0]; y = b[1]; } else if (t > 0) { x += dx * t; y += dy * t; }
  }
  dx = p[0] - x; dy = p[1] - y;
  return dx * dx + dy * dy;
}

/** Douglas–Peucker on a closed ring (keeps the closing point). */
export function simplifyRing(ring: Ring, tol: number): Ring {
  if (ring.length <= 4) return ring;
  const keep = new Uint8Array(ring.length);
  keep[0] = keep[ring.length - 1] = 1;
  const stack: [number, number][] = [[0, ring.length - 1]];
  const t2 = tol * tol;
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let maxD = 0, idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = sqSegDist(ring[i], ring[s], ring[e]);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > t2 && idx > 0) { keep[idx] = 1; stack.push([s, idx], [idx, e]); }
  }
  const out = ring.filter((_, i) => keep[i]);
  return out.length >= 4 ? out : ring;
}

function ringStats(ring: Ring): { area: number; perimeter: number } {
  let a = 0, p = 0;
  for (let i = 1; i < ring.length; i++) {
    a += ring[i - 1][0] * ring[i][1] - ring[i][0] * ring[i - 1][1];
    p += Math.hypot(ring[i][0] - ring[i - 1][0], ring[i][1] - ring[i - 1][1]);
  }
  return { area: Math.abs(a) / 2, perimeter: p };
}

/**
 * Holes the width of a motorway, railway or river line (and specks) are real walls but read as
 * clutter on the map: drop holes that are tiny or long and thin, and tiny islands. Grid units.
 * The areas and probabilities are computed from the cells, not from these outlines.
 */
export function tidyPolygon(poly: Ring[]): Ring[] | undefined {
  const [outer, ...holes] = poly;
  const o = ringStats(outer);
  if (o.area < 6) return undefined;
  return [outer, ...holes.filter((h) => { const st = ringStats(h); return st.area >= 25 && st.area / Math.max(1, st.perimeter) >= 1.2; })];
}

export interface RegionGeometry {
  threshold: number;
  /** Area of cells within the threshold, square metres. */
  areaM2: number;
  geometry: GeoJSON.MultiPolygon;
}

export function regionPolygons(dist: Float32Array, g: GridSpec, thresholds: number[]): RegionGeometry[] {
  const n = g.cols * g.rows;
  const values = new Float64Array(n);
  for (let i = 0; i < n; i++) values[i] = Number.isFinite(dist[i]) ? -dist[i] : -1e15;
  const gen = contours().size([g.cols, g.rows]).smooth(true);
  return thresholds.map((t) => {
    let cells = 0;
    for (let i = 0; i < n; i++) if (dist[i] <= t) cells++;
    const mp = gen.contour(Array.from(values), -t);
    const coordinates = mp.coordinates
      .map((poly) => tidyPolygon(poly as Ring[]))
      .filter((poly): poly is Ring[] => Boolean(poly))
      .map((poly) =>
        poly
          .map((ring) => simplifyRing(ring as Ring, 0.6))
          .filter((ring) => ring.length >= 4)
          .map((ring) => ring.map(([gx, gy]) => {
            const [lat, lon] = fromItm(g.x0 + gx * g.cellM, g.y0 - gy * g.cellM);
            return [Math.round(lon * 1e6) / 1e6, Math.round(lat * 1e6) / 1e6];
          })),
      )
      .filter((poly) => poly.length > 0);
    return { threshold: t, areaM2: cells * g.cellM * g.cellM, geometry: { type: 'MultiPolygon', coordinates } };
  });
}
