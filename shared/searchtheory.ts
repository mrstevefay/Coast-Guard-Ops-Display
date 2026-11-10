/**
 * Search theory for the plan: how searching an area changes where the subject probably is.
 *
 * Each segment has a probability of area (POA): the share of subjects like this one expected
 * there. Searching it with a probability of detection (POD) lowers its POA to POA × (1 − POD),
 * and the probability it loses is shared by every other segment and by the rest of the area
 * not yet split into segments, in proportion to what they already hold (Bayes). Repeated searches
 * of one segment combine: cumulative POD = 1 − Π(1 − PODₖ).
 *
 * POD from a team's track uses the exponential detection function: coverage C = effort / area,
 * where effort = track length × sweep width; POD = 1 − e^(−C). The station's "sweep width" is
 * metres each side of the walker, so the effective sweep is twice it.
 */

export interface SegmentPoa { id: string; poaPct: number }
export interface SearchedSegment { segmentId: string; pod: number }
export interface UpdatedPoa { id: string; basePct: number; nowPct: number; cumPod: number }

/** Combine several searches of one place: 1 − Π(1 − POD). */
export function cumulativePod(pods: number[]): number {
  return 1 - pods.reduce((p, x) => p * (1 - Math.min(1, Math.max(0, x))), 1);
}

/**
 * POA after the searches so far. `totalPct` is the share of subjects the whole modelled area
 * holds (the outer ring, e.g. 90 %); whatever the listed segments do not hold is the rest of the
 * area, which gains probability as segments are searched and found empty.
 */
export function updatePoa(segments: SegmentPoa[], searched: SearchedSegment[], totalPct = 100): UpdatedPoa[] {
  const pods = new Map<string, number[]>();
  for (const s of searched) pods.set(s.segmentId, [...(pods.get(s.segmentId) ?? []), s.pod]);
  const listed = segments.reduce((t, s) => t + s.poaPct, 0);
  const rest = Math.max(0, totalPct - listed);
  const after = segments.map((s) => {
    const cum = cumulativePod(pods.get(s.id) ?? []);
    return { id: s.id, basePct: s.poaPct, unnormalised: s.poaPct * (1 - cum), cumPod: cum };
  });
  const sum = after.reduce((t, s) => t + s.unnormalised, 0) + rest;
  const scale = sum > 0 ? totalPct / sum : 0;
  return after.map((s) => ({ id: s.id, basePct: s.basePct, nowPct: Math.round(s.unnormalised * scale * 10) / 10, cumPod: Math.round(s.cumPod * 100) / 100 }));
}

/** Ray casting: is [lon, lat] inside the ring (closed or not)? */
export function pointInRing(p: [number, number], ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const M_PER_DEG = 111_320;

/** Metres between two [lon, lat] points (equirectangular: exact enough over a search area). */
export function distanceM(a: [number, number], b: [number, number]): number {
  const k = Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
  return Math.hypot((a[0] - b[0]) * M_PER_DEG * k, (a[1] - b[1]) * M_PER_DEG);
}

/** Area of a [lon, lat] ring in square metres (shoelace on a local equirectangular plane). */
export function ringAreaM2(ring: [number, number][]): number {
  if (ring.length < 3) return 0;
  const lat0 = ring.reduce((t, p) => t + p[1], 0) / ring.length;
  const k = Math.cos((lat0 * Math.PI) / 180);
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j][0] * k * M_PER_DEG * ring[i][1] * M_PER_DEG - ring[i][0] * k * M_PER_DEG * ring[j][1] * M_PER_DEG;
  return Math.abs(a) / 2;
}

/**
 * Coverage of an area from tracks: metres walked inside it (legs with both ends inside and no
 * gap longer than `gapSec`), times the effective sweep (2 × sweep width each side), over its area.
 */
export function coverageFromTracks(ring: [number, number][], tracks: { tst: number; lon: number; lat: number }[][], sweepEachSideM: number, gapSec = 300): { trackM: number; areaM2: number; coverage: number; pod: number } {
  const areaM2 = ringAreaM2(ring);
  let trackM = 0;
  for (const t of tracks) {
    for (let i = 1; i < t.length; i++) {
      const a = t[i - 1], b = t[i];
      if (b.tst - a.tst > gapSec) continue;
      if (pointInRing([a.lon, a.lat], ring) && pointInRing([b.lon, b.lat], ring)) trackM += distanceM([a.lon, a.lat], [b.lon, b.lat]);
    }
  }
  const coverage = areaM2 > 0 ? (trackM * 2 * sweepEachSideM) / areaM2 : 0;
  return { trackM: Math.round(trackM), areaM2: Math.round(areaM2), coverage: Math.round(coverage * 100) / 100, pod: Math.round((1 - Math.exp(-coverage)) * 100) / 100 };
}

/** The four POD levels a team leader picks from, with plain words. */
export const POD_LEVELS: { pod: number; label: string }[] = [
  { pod: 0.3, label: 'Quick look' },
  { pod: 0.5, label: 'Normal' },
  { pod: 0.7, label: 'Thorough' },
  { pod: 0.9, label: 'Very thorough' },
];
