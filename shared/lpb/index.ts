/**
 * Lost person behaviour helpers over the MISPER-UK dataset. Pure functions: no DOM,
 * no Node, so the server (report, validation) and the web apps share them.
 */
import { MISPER_UK } from './misperUk.js';
import { LPB_LOCATIONS, LPB_OUTCOMES, LPB_TERRAINS, type LpbDataset, type LpbLocation, type LpbOutcome, type LpbProfile, type LpbTerrain } from './types.js';

export * from './types.js';
export { MISPER_UK };

export const LPB: LpbDataset = MISPER_UK;

/** Cumulative percentiles drawn as rings around the planning point. 100 % is never drawn. */
export const RING_PCTS = [50, 70, 90] as const;

/** Sidebar grouping for the category picker. */
export const LPB_GROUPS: { label: string; slugs: string[] }[] = [
  { label: 'Vulnerable persons', slugs: ['despondent', 'dementia', 'psychological-illness', 'children-aged-1-16', 'developmental-problem', 'other-vulnerable', 'health-related', 'substance-related'] },
  { label: 'Outdoor activity', slugs: ['walker-solo', 'walker-group', 'fellrunner', 'climber', 'mountain-biker', 'water-related'] },
  { label: 'Other', slugs: ['miscellaneous'] },
];

export function profileBySlug(slug: string | undefined | null): LpbProfile | undefined {
  if (!slug) return undefined;
  return LPB.profiles.find((p) => p.slug === slug);
}

export function profileSlugs(): string[] {
  return LPB.profiles.map((p) => p.slug);
}

export function isTerrain(t: string | undefined | null): t is LpbTerrain {
  return Boolean(t) && (LPB_TERRAINS as string[]).includes(t as string);
}

/** Distance within which `pct` % of this profile's subjects were found (km), from the cumulative table. */
export function distanceAtPct(profile: LpbProfile, pct: number): number | undefined {
  return profile.distanceKm.find((d) => d.pct === pct)?.km;
}

/** Rings to draw: the RING_PCTS points, skipping 0 km and duplicate radii. */
export function ringRadiiKm(profile: LpbProfile | undefined): { pct: number; km: number }[] {
  if (!profile) return [];
  const out: { pct: number; km: number }[] = [];
  for (const pct of RING_PCTS) {
    const km = distanceAtPct(profile, pct);
    if (km === undefined || km <= 0) continue;
    if (out.some((r) => r.km === km)) continue;
    out.push({ pct, km });
  }
  return out;
}

export interface LpbShare<K extends string> {
  key: K;
  n: number;
  /** Percentage of the base (0–100, one decimal). */
  pct: number;
}

function shares<K extends string>(counts: Record<K, number> | undefined, keys: K[]): LpbShare<K>[] {
  if (!counts) return [];
  const total = keys.reduce((a, k) => a + (counts[k] ?? 0), 0);
  return keys
    .map((key) => ({ key, n: counts[key] ?? 0, pct: total ? Math.round(((counts[key] ?? 0) / total) * 1000) / 10 : 0 }))
    .filter((s) => s.n > 0)
    .sort((a, b) => b.n - a.n);
}

/** Where subjects were found, for one terrain or all, sorted by count. */
export function locationShares(profile: LpbProfile, terrain?: LpbTerrain | string | null): LpbShare<LpbLocation>[] {
  const counts = isTerrain(terrain) ? profile.locations.byTerrain[terrain] : profile.locations.all;
  return shares(counts, LPB_LOCATIONS);
}

export function outcomeShares(profile: LpbProfile): LpbShare<LpbOutcome>[] {
  return shares(profile.outcome, LPB_OUTCOMES);
}

/** Terrains the profile has location data for (some categories have no incidents in some terrains). */
export function terrainsWithData(profile: LpbProfile): LpbTerrain[] {
  return LPB_TERRAINS.filter((t) => profile.locations.byTerrain[t]);
}

/**
 * Suggest a category from what the subject form already knows. A hint only: the
 * search manager picks the category.
 */
export function suggestProfile(subject: { age?: number; despondent?: boolean; mentalHealth?: boolean }): string | undefined {
  if (subject.despondent) return 'despondent';
  if (subject.age !== undefined && subject.age >= 1 && subject.age <= 16) return 'children-aged-1-16';
  if (subject.mentalHealth) return 'psychological-illness';
  return undefined;
}
