/**
 * Land classes, linear-feature flags and the travel-effort model.
 *
 * Effort is in "metres of flat open ground": walking 100 m along a flat road costs 100.
 * Every factor is ≥ 1, so effort is never less than straight-line distance and a terrain
 * region at effort r always sits inside the statistical circle of radius r. The terrain only
 * takes reach away (sea, cliffs, steep ground, dense cover), it never adds any.
 */

export const CLASS = {
  OPEN: 0, // nothing mapped: fields, verges
  URBAN: 1,
  GRASS: 2, // parks, farmland, golf courses, meadows
  HEATH: 3,
  SCRUB: 4,
  WOOD: 5,
  BEACH: 6,
  WETLAND: 7,
  ROCK: 8,
  WATER: 9, // inland water
  SEA: 10,
  OUT: 255, // outside the terrain grid
} as const;

export const CLASS_NAME: Record<number, string> = { 0: 'open ground', 1: 'urban', 2: 'grass / farmland', 3: 'heath', 4: 'scrub', 5: 'woodland', 6: 'beach', 7: 'wetland', 8: 'rock / scree', 9: 'water', 10: 'sea', 255: 'outside data' };

/** Effort per metre on flat ground, by land class. Infinity = cannot be entered on foot. */
export const CLASS_MULT: Record<number, number> = { 0: 1.0, 1: 1.0, 2: 1.0, 3: 1.3, 4: 1.8, 5: 1.5, 6: 1.2, 7: 3.0, 8: 2.0, 9: Infinity, 10: Infinity, 255: Infinity };

export const FLAG = {
  TRAVEL: 1, // road, track, path, steps, pier: walkable whatever is under it (bridges, piers)
  CLIFF: 2, // OSM natural=cliff line: a wall
  RIVER: 4, // river or canal line: a wall except at a TRAVEL crossing
  RAIL: 8, // railway: a wall except at a TRAVEL crossing
  MOTORWAY: 16, // a wall except at a TRAVEL crossing
  STREAM: 32, // stream, ditch, drain: crossable but slow
  COAST: 64, // coastline line (stops the sea flood fill); passable
} as const;

const HARD_LINES = FLAG.RIVER | FLAG.RAIL | FLAG.MOTORWAY;

/** Slope above this (rise/run) is a wall unless a path is mapped on it: 35°. */
export const MAX_SLOPE = Math.tan((35 * Math.PI) / 180);

export function passable(cls: number, flags: number): boolean {
  if (flags & FLAG.CLIFF) return false;
  const travel = (flags & FLAG.TRAVEL) !== 0;
  if (!travel && flags & HARD_LINES) return false;
  if (!travel && !Number.isFinite(CLASS_MULT[cls] ?? Infinity)) return false;
  if (cls === CLASS.OUT) return false;
  return true;
}

/** Effort per metre for a passable cell (before slope). */
export function cellMult(cls: number, flags: number): number {
  if (flags & FLAG.TRAVEL) return 1.0;
  const m = CLASS_MULT[cls] ?? 1.0;
  return flags & FLAG.STREAM ? m * 1.3 : m;
}

/**
 * Tobler's hiking function as an effort factor: speed falls off with slope and the fastest
 * walking is slightly downhill. Normalised to 1 on the flat and clamped at ≥ 1 so a gentle
 * descent never counts as more than straight-line reach. Infinity above MAX_SLOPE unless
 * `onPath` (steps, steep paths).
 */
export function slopeFactor(rise: number, run: number, onPath = false): number {
  const s = rise / run;
  if (Math.abs(s) > MAX_SLOPE && !onPath) return Infinity;
  const sc = Math.max(-MAX_SLOPE, Math.min(MAX_SLOPE, s));
  return Math.max(1, Math.exp(3.5 * (Math.abs(sc + 0.05) - 0.05)));
}
