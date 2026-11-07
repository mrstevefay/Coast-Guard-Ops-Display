/** Cut a cost grid around a point from the station terrain, coarsening if it would be too big. */
import { CLASS, FLAG } from './classes.js';
import type { CostGrid } from './dijkstra.js';
import { DEM_NODATA, SRC, type GridSpec, type TerrainData } from './raster.js';

export interface Window extends CostGrid, GridSpec {
  src: Uint8Array;
  /** Base cells per window cell along each axis. */
  factor: number;
}

export function cutWindow(t: TerrainData, x: number, y: number, radiusM: number, maxCells = 1_600_000): Window {
  const base = t.meta;
  const span = 2 * radiusM;
  let factor = 1;
  while ((span / (base.cellM * factor)) ** 2 > maxCells) factor++;
  const cellM = base.cellM * factor;
  const half = Math.ceil(radiusM / cellM);
  const cols = 2 * half + 1, rows = 2 * half + 1;
  // align the window to the base grid so window cells are whole base blocks
  const cc = Math.floor((x - base.x0) / cellM), rc = Math.floor((base.y0 - y) / cellM);
  const x0 = base.x0 + (cc - half) * cellM, y0 = base.y0 - (rc - half) * cellM;
  const n = cols * rows;
  const dem = new Float32Array(n), cls = new Uint8Array(n), flags = new Uint8Array(n), src = new Uint8Array(n), cap = new Uint8Array(n);
  const bc0 = (cc - half) * factor, br0 = (rc - half) * factor;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const w = r * cols + c;
      let hSum = 0, hN = 0, fl = 0, water = 0, inside = 0, srcBest = 0;
      const counts = new Map<number, number>();
      for (let dr = 0; dr < factor; dr++) {
        const br = br0 + r * factor + dr;
        if (br < 0 || br >= base.rows) continue;
        for (let dc = 0; dc < factor; dc++) {
          const bc = bc0 + c * factor + dc;
          if (bc < 0 || bc >= base.cols) continue;
          const i = br * base.cols + bc;
          inside++;
          const h = t.dem[i];
          if (h !== DEM_NODATA) { hSum += h / 10; hN++; }
          fl |= t.flags[i];
          const k = t.cls[i];
          if (k === CLASS.SEA || k === CLASS.WATER) water++;
          counts.set(k, (counts.get(k) ?? 0) + 1);
          if (t.src[i] > srcBest) srcBest = t.src[i];
        }
      }
      if (!inside) { cls[w] = CLASS.OUT; dem[w] = NaN; continue; }
      dem[w] = hN ? hSum / hN : NaN;
      flags[w] = fl;
      src[w] = srcBest;
      if (factor === 1) cls[w] = counts.keys().next().value!;
      else if (water * 2 >= inside) cls[w] = (counts.get(CLASS.SEA) ?? 0) >= (counts.get(CLASS.WATER) ?? 0) ? CLASS.SEA : CLASS.WATER;
      else {
        let best = CLASS.OPEN as number, bestN = -1;
        for (const [k, v] of counts) if (k !== CLASS.SEA && k !== CLASS.WATER && v > bestN) { best = k; bestN = v; }
        cls[w] = best;
      }
      // Copernicus is a surface model: in towns and along roads its "slopes" are buildings and trees, so cap them.
      if (fl & FLAG.TRAVEL || (cls[w] === CLASS.URBAN && srcBest !== SRC.LIDAR)) cap[w] = 1;
    }
  }
  return { cols, rows, cellM, x0, y0, dem, cls, flags, src, cap, factor };
}
