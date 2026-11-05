/**
 * Lost person behaviour (LPB) reference data: UK missing-person statistics per subject
 * category, used by the search manager to plan from evidence. Generated from MISPER-UK
 * (The Centre for Search Research) by `scripts/fetch-misper.mjs`; see `misperUk.ts`.
 */

export type LpbTerrain =
  | 'Crag / Broken Ground'
  | 'Farmland'
  | 'Moorland / Upland'
  | 'Not Specified'
  | 'Plantation (dense)'
  | 'Urban'
  | 'Water Margin'
  | 'Woodland / Parkland';

export const LPB_TERRAINS: LpbTerrain[] = ['Crag / Broken Ground', 'Farmland', 'Moorland / Upland', 'Not Specified', 'Plantation (dense)', 'Urban', 'Water Margin', 'Woodland / Parkland'];

/** Where the person was found. "Travel Aid" = road, track or path they could have walked along. */
export type LpbLocation = 'Habitation' | 'Travel Aid' | 'Linear Feature' | 'Open Ground' | 'Trees' | 'Water' | 'Not Found';

export const LPB_LOCATIONS: LpbLocation[] = ['Habitation', 'Travel Aid', 'Linear Feature', 'Open Ground', 'Trees', 'Water', 'Not Found'];

export type LpbOutcome = 'None' | 'Minor Injury' | 'Serious Injury' | 'Fatality' | 'Unknown';

export const LPB_OUTCOMES: LpbOutcome[] = ['None', 'Minor Injury', 'Serious Injury', 'Fatality', 'Unknown'];

/** Cumulative distance point: `pct` % of subjects were found within `km` of the IPP. */
export interface LpbDistancePoint {
  pct: number;
  km: number;
}

export interface LpbProfile {
  /** URL slug on misper.uk, used as the stored category id (e.g. "dementia"). */
  slug: string;
  name: string;
  definition: string;
  /** Incidents in the category. */
  n: number;
  sourceUrl: string;
  /** The source warns the numbers are small; treat percentages as indicative only. */
  lowNumbersCaution: boolean;
  terrainBySex: { terrain: LpbTerrain; male: number; female: number; other: number }[];
  outcome: Record<LpbOutcome, number>;
  locations: {
    all: Record<LpbLocation, number>;
    byTerrain: Partial<Record<LpbTerrain, Record<LpbLocation, number>>>;
  };
  /** Deciles 10–100 % plus any extra annotated points, sorted by pct. */
  distanceKm: LpbDistancePoint[];
  /** Narrative notes from the source (significance, cautions, significant locations). */
  notes: string[];
}

export interface LpbDataset {
  source: {
    name: string;
    publisher: string;
    url: string;
    study: string;
    dataProvider: string;
    attribution: string;
    licence: string;
    fetchedAt: string;
  };
  /** All-category figures and tactics for the first hour or two. */
  immediate: {
    foundAlivePct: number;
    fatalityPct: number;
    noTracePct: number;
    within500mPct: number;
    within1kmPct: number;
    notes: string[];
    tactics: string[];
  };
  profiles: LpbProfile[];
}
