import { describe, expect, it } from 'vitest';
import { coverageFromTracks, cumulativePod, distanceM, pointInRing, ringAreaM2, updatePoa } from '../../shared/searchtheory.js';

// a 200 m square near Howth summit
const lat0 = 53.37, lon0 = -6.06, dLat = 200 / 111_320, dLon = 200 / (111_320 * Math.cos((lat0 * Math.PI) / 180));
const SQ: [number, number][] = [[lon0, lat0], [lon0 + dLon, lat0], [lon0 + dLon, lat0 + dLat], [lon0, lat0 + dLat], [lon0, lat0]];

describe('search theory', () => {
  it('combines repeated searches', () => {
    expect(cumulativePod([0.5, 0.5])).toBeCloseTo(0.75, 6);
    expect(cumulativePod([])).toBe(0);
    expect(cumulativePod([1.4])).toBe(1); // clamped
  });

  it('moves probability out of a searched segment into the others and the rest of the area, keeping the total', () => {
    const segs = [{ id: 'S1', poaPct: 40 }, { id: 'S2', poaPct: 20 }, { id: 'S3', poaPct: 10 }];
    const r = updatePoa(segs, [{ segmentId: 'S1', pod: 0.7 }], 90);
    const s1 = r.find((x) => x.id === 'S1')!, s2 = r.find((x) => x.id === 'S2')!;
    // S1: 40 × 0.3 = 12 unnormalised; the rest is 90 − 70 = 20; sum = 12 + 20 + 10 + 20 = 62; scale 90/62
    expect(s1.nowPct).toBeCloseTo((12 * 90) / 62, 1);
    expect(s2.nowPct).toBeCloseTo((20 * 90) / 62, 1);
    expect(s1.cumPod).toBe(0.7);
    expect(s2.nowPct).toBeGreaterThan(s1.nowPct); // S2 is now the better bet
    const total = r.reduce((t, x) => t + x.nowPct, 0) + (20 * 90) / 62;
    expect(total).toBeCloseTo(90, 0);
    expect(updatePoa(segs, [], 90).map((x) => x.nowPct)).toEqual([40, 20, 10]);
  });

  it('measures areas, distances and points in rings', () => {
    expect(ringAreaM2(SQ)).toBeCloseTo(40_000, -2);
    expect(distanceM(SQ[0], SQ[1])).toBeCloseTo(200, 0);
    expect(pointInRing([lon0 + dLon / 2, lat0 + dLat / 2], SQ)).toBe(true);
    expect(pointInRing([lon0 - dLon / 2, lat0], SQ)).toBe(false);
  });

  it('turns a track inside an area into coverage and POD', () => {
    // five 200 m sweeps, 40 m apart, inside the square: 1,000 m walked at 20 m each side
    const t0 = 1_800_000_000;
    const pts: { tst: number; lon: number; lat: number }[] = [];
    for (let k = 0; k < 5; k++) {
      const lat = lat0 + ((k * 40 + 20) / 200) * dLat;
      pts.push({ tst: t0 + k * 200, lon: lon0 + 0.001 * dLon, lat }, { tst: t0 + k * 200 + 150, lon: lon0 + 0.999 * dLon, lat });
    }
    const c = coverageFromTracks(SQ, [pts], 20);
    expect(c.trackM).toBeGreaterThan(1100); // the sweeps plus the steps between them
    expect(c.coverage).toBeCloseTo((c.trackM * 40) / c.areaM2, 2);
    expect(c.pod).toBeCloseTo(1 - Math.exp(-c.coverage), 2);
    // a gap longer than the limit is not counted
    expect(coverageFromTracks(SQ, [[pts[0], { ...pts[1], tst: pts[0].tst + 4000 }]], 20).trackM).toBe(0);
  });
});
