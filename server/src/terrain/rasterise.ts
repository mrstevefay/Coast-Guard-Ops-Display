/**
 * Drawing vector features into a byte grid: 4-connected lines (so a one-cell line is a
 * watertight wall for both 4- and 8-connected movement with no corner cutting) and even-odd
 * polygon fill (works on an unordered set of ring edges, which is what OSM multipolygon
 * members are).
 */
import type { GridSpec } from './raster.js';

export type XY = [number, number];

/** Grid coordinates (fractional columns/rows) for an ITM point. */
export function toGrid(g: GridSpec, x: number, y: number): XY {
  return [(x - g.x0) / g.cellM, (g.y0 - y) / g.cellM];
}

/** Visit every cell a segment passes through (Amanatides & Woo), 4-connected. */
export function walkSegment(g: GridSpec, a: XY, b: XY, visit: (idx: number) => void): void {
  let cx = Math.floor(a[0]), cy = Math.floor(a[1]);
  const ex = Math.floor(b[0]), ey = Math.floor(b[1]);
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const sx = dx > 0 ? 1 : -1, sy = dy > 0 ? 1 : -1;
  const tdx = dx !== 0 ? Math.abs(1 / dx) : Infinity, tdy = dy !== 0 ? Math.abs(1 / dy) : Infinity;
  let tx = dx !== 0 ? (dx > 0 ? cx + 1 - a[0] : a[0] - cx) * tdx : Infinity;
  let ty = dy !== 0 ? (dy > 0 ? cy + 1 - a[1] : a[1] - cy) * tdy : Infinity;
  const put = () => { if (cx >= 0 && cy >= 0 && cx < g.cols && cy < g.rows) visit(cy * g.cols + cx); };
  put();
  let guard = Math.abs(ex - cx) + Math.abs(ey - cy) + 2;
  while ((cx !== ex || cy !== ey) && guard-- > 0) {
    if (tx < ty) { tx += tdx; cx += sx; } else { ty += tdy; cy += sy; }
    put();
  }
}

export function drawLine(g: GridSpec, pts: XY[], visit: (idx: number) => void): void {
  for (let i = 1; i < pts.length; i++) walkSegment(g, pts[i - 1], pts[i], visit);
  if (pts.length === 1) walkSegment(g, pts[0], pts[0], visit);
}

/** Even-odd fill of cell centres inside the union of rings (grid coordinates). */
export function fillRings(g: GridSpec, rings: XY[][], visit: (idx: number) => void): void {
  let minY = Infinity, maxY = -Infinity;
  const edges: [number, number, number, number][] = [];
  for (const ring of rings) {
    for (let i = 0; i < ring.length - 1; i++) {
      const [x1, y1] = ring[i], [x2, y2] = ring[i + 1];
      if (y1 === y2) continue;
      edges.push([x1, y1, x2, y2]);
      minY = Math.min(minY, y1, y2);
      maxY = Math.max(maxY, y1, y2);
    }
  }
  if (!edges.length) return;
  const r0 = Math.max(0, Math.floor(minY)), r1 = Math.min(g.rows - 1, Math.ceil(maxY));
  const xs: number[] = [];
  for (let r = r0; r <= r1; r++) {
    const yc = r + 0.5;
    xs.length = 0;
    for (const [x1, y1, x2, y2] of edges) {
      if ((y1 <= yc && y2 > yc) || (y2 <= yc && y1 > yc)) xs.push(x1 + ((yc - y1) / (y2 - y1)) * (x2 - x1));
    }
    if (xs.length < 2) continue;
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const c0 = Math.max(0, Math.ceil(xs[k] - 0.5)), c1 = Math.min(g.cols - 1, Math.floor(xs[k + 1] - 0.5));
      for (let c = c0; c <= c1; c++) visit(r * g.cols + c);
    }
  }
}
