import type { TargetGeometry, TargetKind } from '../../../shared/types.js';

const MAX_VERTICES = 500;

function validCoord(c: unknown): c is [number, number] {
  return Array.isArray(c) && c.length >= 2 && typeof c[0] === 'number' && typeof c[1] === 'number' && Number.isFinite(c[0]) && Number.isFinite(c[1]) && c[0] >= -180 && c[0] <= 180 && c[1] >= -90 && c[1] <= 90;
}

/** Validate a GeoJSON geometry for a target and return it normalised ([lon,lat] only). */
export function validateGeometry(input: unknown, kind: TargetKind): TargetGeometry {
  const g = input as { type?: string; coordinates?: unknown } | null;
  if (!g || typeof g !== 'object' || typeof g.type !== 'string') throw new Error('geometry required');
  const strip = (c: [number, number]) => [c[0], c[1]] as [number, number];
  if (kind === 'point') {
    if (g.type !== 'Point' || !validCoord(g.coordinates)) throw new Error('point target needs a Point geometry');
    return { type: 'Point', coordinates: strip(g.coordinates) };
  }
  if (kind === 'line') {
    if (g.type !== 'LineString' || !Array.isArray(g.coordinates) || g.coordinates.length < 2) throw new Error('line target needs a LineString with 2+ points');
    if (g.coordinates.length > MAX_VERTICES) throw new Error(`too many vertices (max ${MAX_VERTICES})`);
    if (!g.coordinates.every(validCoord)) throw new Error('invalid coordinates');
    return { type: 'LineString', coordinates: g.coordinates.map(strip) };
  }
  if (g.type !== 'Polygon' || !Array.isArray(g.coordinates) || !Array.isArray(g.coordinates[0])) throw new Error('area target needs a Polygon geometry');
  const ring = g.coordinates[0] as unknown[];
  if (ring.length < 4) throw new Error('polygon ring needs at least 4 points (closed)');
  if (ring.length > MAX_VERTICES) throw new Error(`too many vertices (max ${MAX_VERTICES})`);
  if (!ring.every(validCoord)) throw new Error('invalid coordinates');
  const coords = (ring as [number, number][]).map(strip);
  const first = coords[0], last = coords[coords.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) coords.push([first[0], first[1]]); // close it
  return { type: 'Polygon', coordinates: [coords] };
}

/** Representative point (centroid-ish) for labels and distance calculations. */
export function anchor(g: TargetGeometry): [number, number] {
  if (g.type === 'Point') return g.coordinates;
  const pts = g.type === 'LineString' ? g.coordinates : g.coordinates[0];
  const n = pts.length;
  return [pts.reduce((s, c) => s + c[0], 0) / n, pts.reduce((s, c) => s + c[1], 0) / n];
}
