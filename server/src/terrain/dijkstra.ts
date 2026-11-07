/**
 * Cost-distance from a start cell over a window grid: 16 directions, no corner cutting past a
 * blocked cell (so one-cell walls are watertight), directed slope costs.
 * Yields to the event loop every `yieldEvery` pops so a big window never stalls WebSockets.
 */
import { cellMult, FLAG, passable, slopeFactor } from './classes.js';

export interface CostGrid {
  cols: number;
  rows: number;
  cellM: number;
  /** Height in metres per cell; NaN = unknown (treated as flat). */
  dem: Float32Array;
  cls: Uint8Array;
  flags: Uint8Array;
  /** 1 = cap the slope effect here (roads, and towns on surface-model heights). */
  cap?: Uint8Array;
}

/** Roads rarely exceed this grade; steeper "slopes" on them are height-data artefacts. */
export const CAPPED_SLOPE = 0.15;

class MinHeap {
  private idx: Int32Array;
  private key: Float64Array;
  size = 0;
  constructor(cap: number) {
    this.idx = new Int32Array(cap);
    this.key = new Float64Array(cap);
  }
  push(i: number, k: number): void {
    if (this.size === this.idx.length) {
      const ni = new Int32Array(this.size * 2); ni.set(this.idx); this.idx = ni;
      const nk = new Float64Array(this.size * 2); nk.set(this.key); this.key = nk;
    }
    let p = this.size++;
    while (p > 0) {
      const q = (p - 1) >> 1;
      if (this.key[q] <= k) break;
      this.idx[p] = this.idx[q]; this.key[p] = this.key[q]; p = q;
    }
    this.idx[p] = i; this.key[p] = k;
  }
  /** Pops the minimum into `out` ([index, key]). */
  pop(out: [number, number]): void {
    out[0] = this.idx[0]; out[1] = this.key[0];
    const li = this.idx[--this.size], lk = this.key[this.size];
    let p = 0;
    for (;;) {
      let c = 2 * p + 1;
      if (c >= this.size) break;
      if (c + 1 < this.size && this.key[c + 1] < this.key[c]) c++;
      if (this.key[c] >= lk) break;
      this.idx[p] = this.idx[c]; this.key[p] = this.key[c]; p = c;
    }
    this.idx[p] = li; this.key[p] = lk;
  }
}

/**
 * 16 directions: the 8 neighbours plus the 8 knight's moves. With 8 alone the reachable set on
 * flat ground is an octagon of 90 % of the circle's area; with 16 it is 97 %. Each diagonal and
 * knight's move lists the cells its straight line passes through; all must be passable, so a
 * one-cell (4-connected) wall can never be jumped.
 */
const SQRT5 = Math.sqrt(5);
const NB: { dc: number; dr: number; len: number; via: [number, number][] }[] = [
  { dc: 1, dr: 0, len: 1, via: [] }, { dc: -1, dr: 0, len: 1, via: [] }, { dc: 0, dr: 1, len: 1, via: [] }, { dc: 0, dr: -1, len: 1, via: [] },
  ...[[1, 1], [1, -1], [-1, 1], [-1, -1]].map(([dc, dr]) => ({ dc, dr, len: Math.SQRT2, via: [[dc, 0], [0, dr]] as [number, number][] })),
  ...[[2, 1], [2, -1], [-2, 1], [-2, -1]].map(([dc, dr]) => ({ dc, dr, len: SQRT5, via: [[Math.sign(dc), 0], [Math.sign(dc), dr]] as [number, number][] })),
  ...[[1, 2], [-1, 2], [1, -2], [-1, -2]].map(([dc, dr]) => ({ dc, dr, len: SQRT5, via: [[0, Math.sign(dr)], [dc, Math.sign(dr)]] as [number, number][] })),
];

/** Nearest passable cell to (c, r) within `maxCells`, or -1. */
export function nearestPassable(g: CostGrid, c: number, r: number, maxCells: number): number {
  for (let rad = 0; rad <= maxCells; rad++) {
    let best = -1, bestD = Infinity;
    for (let dr = -rad; dr <= rad; dr++) for (let dc = -rad; dc <= rad; dc++) {
      if (Math.max(Math.abs(dr), Math.abs(dc)) !== rad) continue;
      const cc = c + dc, rr = r + dr;
      if (cc < 0 || rr < 0 || cc >= g.cols || rr >= g.rows) continue;
      const i = rr * g.cols + cc;
      if (!passable(g.cls[i], g.flags[i])) continue;
      const d = dr * dr + dc * dc;
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best >= 0) return best;
  }
  return -1;
}

export async function costDistance(g: CostGrid, starts: number[], maxEffort: number, yieldEvery = 200_000): Promise<Float32Array> {
  const n = g.cols * g.rows;
  const dist = new Float32Array(n).fill(Infinity);
  const done = new Uint8Array(n);
  const ok = new Uint8Array(n);
  for (let i = 0; i < n; i++) ok[i] = passable(g.cls[i], g.flags[i]) ? 1 : 0;
  const heap = new MinHeap(1 << 16);
  for (const s of starts) if (s >= 0 && ok[s]) { dist[s] = 0; heap.push(s, 0); }
  const top: [number, number] = [0, 0];
  let pops = 0;
  const cell = g.cellM;
  while (heap.size) {
    heap.pop(top);
    const i = top[0], d = top[1];
    if (done[i]) continue;
    if (d > maxEffort) break;
    done[i] = 1;
    if (++pops % yieldEvery === 0) await new Promise((res) => setImmediate(res));
    const c = i % g.cols, r = (i - c) / g.cols;
    const hi = g.dem[i];
    const ti = (g.flags[i] & FLAG.TRAVEL) !== 0;
    const mi = cellMult(g.cls[i], g.flags[i]);
    for (const { dc, dr, len, via } of NB) {
      const cc = c + dc, rr = r + dr;
      if (cc < 0 || rr < 0 || cc >= g.cols || rr >= g.rows) continue;
      const j = rr * g.cols + cc;
      if (!ok[j] || done[j]) continue;
      let blocked = false;
      for (const [vc, vr] of via) if (!ok[(r + vr) * g.cols + (c + vc)]) { blocked = true; break; } // no corner cutting
      if (blocked) continue;
      const run = len * cell;
      const hj = g.dem[j];
      let rise = Number.isFinite(hi) && Number.isFinite(hj) ? hj - hi : 0;
      if (g.cap && g.cap[i] && g.cap[j]) rise = Math.max(-CAPPED_SLOPE * run, Math.min(CAPPED_SLOPE * run, rise));
      const tj = (g.flags[j] & FLAG.TRAVEL) !== 0;
      const sf = slopeFactor(rise, run, ti && tj);
      if (!Number.isFinite(sf)) continue;
      const nd = d + run * sf * 0.5 * (mi + cellMult(g.cls[j], g.flags[j]));
      if (nd < dist[j]) { dist[j] = nd; heap.push(j, nd); }
    }
  }
  return dist;
}
