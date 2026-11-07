/**
 * Probability of area (POA) inside the terrain region, per cell:
 *
 *  - distance bands from the category's cumulative table: the share found at the point itself
 *    goes to the first 60 m of effort, each band between drawn rings gets its share of subjects;
 *  - within a band, cells are weighted by where this category is found (travel aid, trees,
 *    water's edge, buildings, linear features, open ground) against how much of each the band
 *    holds, so a category found on paths 40 % of the time puts more weight on the paths;
 *  - corridors: least-cost routes from the planning point to places significant to the subject
 *    ("lines and points") are weighted up, the place itself more.
 *
 * Mass is conserved per band, so the map's total is the outer ring's percentage.
 */
import { CLASS, FLAG } from './classes.js';
import type { Window } from './window.js';

export const LOC = { OPEN: 0, TRAVEL: 1, LINEAR: 2, TREES: 3, WATER: 4, HABITATION: 5 } as const;
export const LOC_NAME = ['Open Ground', 'Travel Aid', 'Linear Feature', 'Trees', 'Water', 'Habitation'] as const;
export type LocName = (typeof LOC_NAME)[number];

/** Which find-location type a cell stands for. */
export function locationType(w: Window, i: number): number {
  const f = w.flags[i], k = w.cls[i];
  if (f & FLAG.TRAVEL) return LOC.TRAVEL;
  const c = i % w.cols, r = (i - c) / w.cols;
  const wet = (j: number) => w.cls[j] === CLASS.SEA || w.cls[j] === CLASS.WATER;
  if (k === CLASS.BEACH || (c > 0 && wet(i - 1)) || (c < w.cols - 1 && wet(i + 1)) || (r > 0 && wet(i - w.cols)) || (r < w.rows - 1 && wet(i + w.cols))) return LOC.WATER;
  if (f & (FLAG.STREAM | FLAG.RIVER)) return LOC.LINEAR;
  if (k === CLASS.WOOD || k === CLASS.SCRUB) return LOC.TREES;
  if (k === CLASS.URBAN) return LOC.HABITATION;
  return LOC.OPEN;
}

export interface Band {
  fromM: number;
  toM: number;
  /** Share of subjects in this band, 0–1. */
  mass: number;
}

export interface WeightInput {
  bands: Band[];
  /** Where this category is found, % by MISPER-UK location (Not Found excluded by the caller). */
  shares: Partial<Record<LocName, number>>;
  /** Window cell indices of significant places. */
  destinations: number[];
  corridorM?: number;
}

export interface Weights {
  poa: Float32Array;
  type: Uint8Array;
  /** One path (cell indices, start→destination) per reachable destination. */
  corridors: number[][];
  total: number;
}

const NB8: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

/** Walk down the effort field from `dest` to the start: the least-cost route, reversed. */
export function tracePath(w: Window, dist: Float32Array, dest: number): number[] {
  if (!Number.isFinite(dist[dest])) return [];
  const path = [dest];
  let i = dest;
  for (let guard = 0; guard < w.cols * w.rows && dist[i] > 0; guard++) {
    const c = i % w.cols, r = (i - c) / w.cols;
    let best = i, bestD = dist[i];
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
      if (!dr && !dc) continue;
      const cc = c + dc, rr = r + dr;
      if (cc < 0 || rr < 0 || cc >= w.cols || rr >= w.rows) continue;
      const j = rr * w.cols + cc;
      if (dist[j] < bestD) { bestD = dist[j]; best = j; }
    }
    if (best === i) break;
    i = best;
    path.push(i);
  }
  return path.reverse();
}

export function computeWeights(w: Window, dist: Float32Array, input: WeightInput): Weights {
  const n = w.cols * w.rows;
  const type = new Uint8Array(n).fill(255);
  const poa = new Float32Array(n);
  const outer = Math.max(...input.bands.map((b) => b.toM));
  for (let i = 0; i < n; i++) if (dist[i] <= outer) type[i] = locationType(w, i);

  // corridor multiplier
  const mult = new Float32Array(n).fill(1);
  const corridors: number[][] = [];
  const cw = Math.max(1, Math.round((input.corridorM ?? 60) / w.cellM));
  const destR = Math.max(1, Math.round(150 / w.cellM));
  for (const d of input.destinations) {
    const p = tracePath(w, dist, d);
    if (p.length < 2) continue;
    corridors.push(p);
    const mark = (center: number, rad: number, m: number) => {
      const c = center % w.cols, r = (center - c) / w.cols;
      for (let dr = -rad; dr <= rad; dr++) for (let dc = -rad; dc <= rad; dc++) {
        if (dr * dr + dc * dc > rad * rad) continue;
        const cc = c + dc, rr = r + dr;
        if (cc < 0 || rr < 0 || cc >= w.cols || rr >= w.rows) continue;
        const j = rr * w.cols + cc;
        if (mult[j] < m) mult[j] = m;
      }
    };
    for (let k = 0; k < p.length; k += Math.max(1, Math.floor(cw / 2))) mark(p[k], cw, 2);
    mark(d, destR, 3);
  }

  // location weights from shares vs the area each type covers inside the region
  const area = new Float64Array(LOC_NAME.length);
  let tot = 0;
  for (let i = 0; i < n; i++) if (type[i] !== 255) { area[type[i]]++; tot++; }
  const shareSum = LOC_NAME.reduce((s, k) => s + (input.shares[k] ?? 0), 0) || 1;
  const lw = LOC_NAME.map((k, t) => {
    const share = (input.shares[k] ?? 0) / shareSum;
    const frac = tot ? area[t] / tot : 0;
    if (!frac) return 1;
    return Math.min(5, Math.max(0.2, share / frac));
  });

  // distribute each band's mass
  let total = 0;
  for (const b of input.bands) {
    if (b.mass <= 0) continue;
    let wsum = 0;
    for (let i = 0; i < n; i++) if (type[i] !== 255 && dist[i] > b.fromM && dist[i] <= b.toM) wsum += lw[type[i]] * mult[i];
    if (b.fromM === 0) for (let i = 0; i < n; i++) if (dist[i] === 0) wsum += lw[type[i]] * mult[i];
    if (!wsum) continue;
    for (let i = 0; i < n; i++) {
      if (type[i] === 255) continue;
      const inBand = (dist[i] > b.fromM && dist[i] <= b.toM) || (b.fromM === 0 && dist[i] === 0);
      if (!inBand) continue;
      const v = (b.mass * lw[type[i]] * mult[i]) / wsum;
      poa[i] += v;
      total += v;
    }
  }
  return { poa, type, corridors, total };
}

/** Bands from the drawn rings and the cumulative table's share at 0 km. */
export function bandsFor(rings: { pct: number; km: number }[], zeroPct: number): Band[] {
  const sorted = [...rings].sort((a, b) => a.km - b.km);
  const bands: Band[] = [];
  let prevM = 0, prevPct = 0;
  if (zeroPct > 0 && sorted.length) {
    bands.push({ fromM: 0, toM: Math.min(60, sorted[0].km * 1000), mass: zeroPct / 100 });
    prevPct = zeroPct;
  }
  for (const r of sorted) {
    const toM = r.km * 1000;
    const mass = Math.max(0, r.pct - prevPct) / 100;
    if (mass > 0) bands.push({ fromM: bands.length && prevM === 0 && zeroPct > 0 ? 0 : prevM, toM, mass });
    prevM = toM;
    prevPct = Math.max(prevPct, r.pct);
  }
  return bands;
}
