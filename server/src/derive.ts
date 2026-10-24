import type { DashboardData } from '../../shared/types.js';
import { round } from './util/units.js';

/**
 * Cross-provider derivations that need more than one source. Kept pure so the
 * frontend stays dumb and this stays testable.
 */
export function derive(data: Readonly<DashboardData>): DashboardData {
  const out: DashboardData = { ...data };
  if (data.tide) {
    const tide = { ...data.tide };
    // Surge = observed gauge − predicted at the same instant, via the curve.
    if (tide.observedM !== undefined && tide.observedAt && tide.curve.length > 1) {
      const predicted = interpolate(tide.curve, Date.parse(tide.observedAt));
      if (predicted !== undefined) tide.surgeM = round(tide.observedM - predicted, 2);
    }
    if (tide.curve.length > 1) {
      const nowP = interpolate(tide.curve, Date.now());
      if (nowP !== undefined) tide.predictedNowM = round(nowP, 2);
    }
    out.tide = tide;
  }
  return out;
}

export function interpolate(curve: { time: string; heightM: number }[], tMs: number): number | undefined {
  let prev: { t: number; h: number } | undefined;
  for (const p of curve) {
    const t = Date.parse(p.time);
    if (t === tMs) return p.heightM;
    if (t > tMs) {
      if (!prev) return undefined;
      const f = (tMs - prev.t) / (t - prev.t);
      return prev.h + f * (p.heightM - prev.h);
    }
    prev = { t, h: p.heightM };
  }
  return undefined;
}
