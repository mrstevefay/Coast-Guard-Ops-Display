/**
 * "Enter what you know, get a plan": combines the live MISPER-UK profile, the 2011 study's
 * terrain/sex segments and the ISRID autism figures into one card. Pure: no DOM, no Node.
 *
 * Every number carries a `Basis` (source, table, n, fallback level) so the card never shows a
 * figure without saying where it came from and how specific it is.
 */
import { ISRID_ASD, isridGroup, type IsridEcoregion, type IsridGroup } from './isridAsd.js';
import { LPB, locationShares, outcomeShares, profileBySlug, type LpbShare } from './index.js';
import { CATEGORY_TACTICS, IMMEDIATE_TACTICS, tacticsFor, type Tactic } from './tactics.js';
import { LPB_TERRAINS, type LpbLocation, type LpbProfile, type LpbTerrain } from './types.js';
import { category2011, DETAIL_GROUP_2011, UKMPBS_2011, type Category2011, type LocationDetail2011, type LocationGroup2011, type Outcome2011, type Segment2011, type SegmentCounts2011, type SegmentDistance2011 } from './ukmpbs2011.js';

export interface PlanInput {
  category: string;
  terrain?: string;
  sex?: string;
  age?: number;
  suicideThreatened?: boolean;
  previousAttempts?: boolean;
  depression?: boolean;
  significantPlaceKnown?: boolean;
}

export interface PlanContext {
  daylight?: boolean;
  tempC?: number;
  /** Active weather or marine warnings, headline text. */
  warnings?: string[];
}

export type MatchLevel = 'category+terrain+sex' | 'category+terrain' | 'category+sex' | 'category' | 'all';

export interface Basis {
  source: 'MISPER-UK' | 'UKMPBS_2011' | 'ISRID_ASD_2020';
  /** Table or page, e.g. "Table 14 farmland". */
  ref: string;
  n?: number;
  level: MatchLevel;
  /** Short tag for the card, e.g. "LIVE n=512" or "2011 T14 farmland". */
  tag: string;
}

export interface PlanRing {
  pct: number;
  km: number;
  interpolated: boolean;
}

export interface PlanCondition {
  basis: Basis;
  alivePct: number;
  fatalityPct: number;
  injuredPct: number;
  /** Not found or outcome unknown. */
  unknownPct: number;
  /** 2011 terrain/sex segment outcome, when the study has one for this subject. */
  segment?: { basis: Basis; pct: Record<Outcome2011, number> };
  /** Indicative fatality rates from the despondent characteristic modifiers (males only). */
  modifiers?: { basis: Basis; lines: { text: string; pct: number }[] };
}

export interface SearchPlan {
  profile: LpbProfile;
  study?: Category2011;
  input: PlanInput;
  /** Rings for the map, from the live cumulative table. */
  rings: { basis: Basis; items: PlanRing[]; zeroSharePct: number };
  /** The 2011 distance table for the matched segment, to compare against the live rings. */
  studyDistance?: { basis: Basis; points: { pct: number; km: number }[]; stepPct: number };
  /** Small categories: every reported distance. */
  rawDistancesKm?: { basis: Basis; km: number[] };
  locations: { basis: Basis; shares: LpbShare<LpbLocation>[] };
  /** 2011 grouped + detail split for the matched segment. */
  studyLocations?: { basis: Basis; groups: { key: LocationGroup2011; n: number; pct?: number }[]; detail: { key: LocationDetail2011; group: LocationGroup2011; n: number; pct?: number }[] };
  condition: PlanCondition;
  scenarios: { basis: Basis; items: string[] };
  tactics: { immediate: Tactic[]; category: Tactic[] };
  isrid?: { basis: Basis; group: IsridGroup; ecoregion: IsridEcoregion; rings: PlanRing[]; findLocation: { key: string; pct: number }[]; survivalDays: IsridGroup['survivalDays']; mobilityHours: IsridGroup['mobilityHours']; trackOffsetM: IsridGroup['trackOffsetM'] };
  warnings: string[];
  sources: string[];
}

const tag = (b: Omit<Basis, 'tag'>): Basis => {
  const src = b.source === 'MISPER-UK' ? 'LIVE' : b.source === 'UKMPBS_2011' ? '2011' : 'ISRID';
  const ref = b.source === 'MISPER-UK' ? '' : ` ${b.ref.replace(/^Table /, 'T')}`;
  return { ...b, tag: `${src}${ref}${b.n ? ` n=${b.n}` : ''}` };
};

const sum = (o: Partial<Record<string, number>>) => Object.values(o).reduce((a, b) => (a ?? 0) + (b ?? 0), 0) ?? 0;

/** Linear interpolation on a cumulative table. Returns undefined outside the table. */
export function interpolateKm(points: { pct: number; km: number }[], pct: number): { km: number; interpolated: boolean } | undefined {
  const exact = points.find((p) => p.pct === pct);
  if (exact) return { km: exact.km, interpolated: false };
  const sorted = [...points].sort((a, b) => a.pct - b.pct);
  for (let i = 1; i < sorted.length; i++) {
    const lo = sorted[i - 1], hi = sorted[i];
    if (lo.pct < pct && pct < hi.pct) {
      const t = (pct - lo.pct) / (hi.pct - lo.pct);
      return { km: Math.round((lo.km + t * (hi.km - lo.km)) * 100) / 100, interpolated: true };
    }
  }
  return undefined;
}

/** Percentiles drawn on the map. 95 % is only shown where a source gives it directly (ISRID). */
export const PLAN_RING_PCTS = [25, 50, 75, 90] as const;

export function planRings(profile: LpbProfile): PlanRing[] {
  const out: PlanRing[] = [];
  for (const pct of PLAN_RING_PCTS) {
    const r = interpolateKm(profile.distanceKm, pct);
    if (!r || r.km <= 0) continue;
    if (out.some((x) => x.km === r.km)) continue;
    out.push({ pct, km: r.km, interpolated: r.interpolated });
  }
  return out;
}

/** Largest cumulative percentage that still sits at 0 km (finds at the planning point or unrecorded distances). */
export function zeroSharePct(profile: LpbProfile): number {
  return profile.distanceKm.filter((d) => d.km === 0).reduce((m, d) => Math.max(m, d.pct), 0);
}

function sexOf(s: string | undefined): 'Male' | 'Female' | undefined {
  if (!s) return undefined;
  const l = s.toLowerCase();
  return l.startsWith('m') ? 'Male' : l.startsWith('f') ? 'Female' : undefined;
}

/** Pick the most specific 2011 segment for the subject: terrain+sex → terrain → sex → whole category. */
export function matchSegment<T extends Segment2011>(segments: T[] | undefined, terrain: string | undefined, sex: 'Male' | 'Female' | undefined): { segment: T; level: MatchLevel } | undefined {
  if (!segments?.length) return undefined;
  const t = terrain && (LPB_TERRAINS as string[]).includes(terrain) ? (terrain as LpbTerrain) : undefined;
  const terrainOk = (s: Segment2011) => Boolean(t && s.terrains?.includes(t));
  const sexOk = (s: Segment2011) => Boolean(sex && s.sex === sex);
  const pick = (f: (s: T) => boolean, level: MatchLevel) => {
    const s = segments.find(f);
    return s ? { segment: s, level } : undefined;
  };
  return (
    pick((s) => terrainOk(s) && sexOk(s), 'category+terrain+sex') ??
    pick((s) => terrainOk(s) && !s.sex, 'category+terrain') ??
    pick((s) => !s.terrains && sexOk(s), 'category+sex') ??
    pick((s) => !s.terrains && !s.sex, 'category')
  );
}

function segmentN<K extends string>(s: SegmentCounts2011<K>): number {
  return s.n ?? sum(s.counts);
}

function isridFor(category: string, terrain: string | undefined, age: number | undefined): { group: IsridGroup; ecoregion: IsridEcoregion } | undefined {
  const eco: IsridEcoregion = terrain === 'Urban' ? 'Urban' : 'Temperate';
  if (category === 'developmental-problem' || category === 'other-vulnerable') return { group: isridGroup('asd'), ecoregion: eco };
  if (category === 'children-aged-1-16' || (age !== undefined && age >= 1 && age <= 16 && category === 'miscellaneous')) return { group: isridGroup('td-child'), ecoregion: eco };
  return undefined;
}

export function buildPlan(input: PlanInput, ctx: PlanContext = {}): SearchPlan | undefined {
  const profile = profileBySlug(input.category);
  if (!profile) return undefined;
  const study = category2011(input.category);
  const sex = sexOf(input.sex);
  const terrain = input.terrain && (LPB_TERRAINS as string[]).includes(input.terrain) ? (input.terrain as LpbTerrain) : undefined;
  const warnings: string[] = [];
  const sources = new Set<string>([LPB.source.attribution]);

  // ---- rings (live)
  const liveBasis = tag({ source: 'MISPER-UK', ref: profile.name, n: profile.n, level: 'category' });
  const rings = { basis: liveBasis, items: planRings(profile), zeroSharePct: zeroSharePct(profile) };
  if (rings.zeroSharePct >= 30) warnings.push(`${rings.zeroSharePct} % of this category's records are at 0 km from the planning point (found at the IPP, or distance not recorded). Rings below that are not drawn; search the IPP itself properly.`);
  if (profile.lowNumbersCaution) warnings.push(`Small category (n=${profile.n}): the source says use these figures with caution.`);

  // ---- 2011 distance segment
  let studyDistance: SearchPlan['studyDistance'];
  let rawDistancesKm: SearchPlan['rawDistancesKm'];
  if (study?.distance) {
    const m = matchSegment<SegmentDistance2011>(study.distance.segments, terrain, sex);
    if (m) {
      const pts = m.segment.points;
      const stepPct = pts.length > 1 ? Math.min(...pts.slice(1).map((p, i) => p.pct - pts[i].pct)) : 100;
      studyDistance = { basis: tag({ source: 'UKMPBS_2011', ref: `${study.distance.table} ${m.segment.label}`, level: m.level }), points: pts, stepPct };
      sources.add(UKMPBS_2011.source.attribution);
    }
  } else if (study?.rawDistancesKm) {
    rawDistancesKm = { basis: tag({ source: 'UKMPBS_2011', ref: `${study.name} (raw)`, n: study.n, level: 'category' }), km: study.rawDistancesKm };
    sources.add(UKMPBS_2011.source.attribution);
  }

  // ---- where found (live by terrain, else all)
  const liveTerrain = terrain && profile.locations.byTerrain[terrain] ? terrain : undefined;
  const locN = liveTerrain ? sum(profile.locations.byTerrain[liveTerrain]!) : profile.n;
  const locations = {
    basis: tag({ source: 'MISPER-UK', ref: liveTerrain ? `${profile.name}, ${liveTerrain}` : `${profile.name}, all terrains`, n: locN, level: liveTerrain ? 'category+terrain' : 'category' }),
    shares: locationShares(profile, liveTerrain),
  };
  if (terrain && !liveTerrain) warnings.push(`No ${terrain} cases in this category on the live data; where-found figures are for all terrains.`);

  let studyLocations: SearchPlan['studyLocations'];
  if (study?.location) {
    const g = matchSegment(study.location.segments, terrain, sex);
    if (g) {
      const d = study.locationDetail ? study.locationDetail.segments.find((s) => s.label === g.segment.label) : undefined;
      const n = segmentN(g.segment);
      studyLocations = {
        basis: tag({ source: 'UKMPBS_2011', ref: `${study.location.table} ${g.segment.label}`, n, level: g.level }),
        groups: (Object.entries(g.segment.counts) as [LocationGroup2011, number][]).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([key, v]) => ({ key, n: v, pct: g.segment.pct?.[key] ?? Math.round((v / n) * 100) })),
        detail: d ? (Object.entries(d.counts) as [LocationDetail2011, number][]).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([key, v]) => ({ key, group: DETAIL_GROUP_2011[key], n: v, pct: d.pct?.[key] ?? Math.round((v / n) * 100) })) : [],
      };
      sources.add(UKMPBS_2011.source.attribution);
    }
  }

  // ---- condition
  const live = outcomeShares(profile);
  const pct = (k: string) => live.find((s) => s.key === k)?.pct ?? 0;
  const condition: PlanCondition = {
    basis: liveBasis,
    alivePct: Math.round((pct('None') + pct('Minor Injury') + pct('Serious Injury')) * 10) / 10,
    fatalityPct: pct('Fatality'),
    injuredPct: Math.round((pct('Minor Injury') + pct('Serious Injury')) * 10) / 10,
    unknownPct: pct('Unknown'),
  };
  if (study?.outcome) {
    const m = matchSegment(study.outcome.segments, terrain, sex);
    if (m && (m.level !== 'category' || study.outcome.segments.length === 1)) {
      const n = segmentN(m.segment);
      const p = {} as Record<Outcome2011, number>;
      for (const k of ['fatal', 'injured', 'no trace', 'unhurt'] as Outcome2011[]) p[k] = m.segment.pct?.[k] ?? Math.round(((m.segment.counts[k] ?? 0) / n) * 100);
      condition.segment = { basis: tag({ source: 'UKMPBS_2011', ref: `${study.outcome.table} ${m.segment.label}`, n, level: m.level }), pct: p };
      sources.add(UKMPBS_2011.source.attribution);
    }
  }
  if (input.category === 'despondent') {
    const f = UKMPBS_2011.despondent.maleFatalityPct;
    const lines: { text: string; pct: number }[] = [];
    if (sex === 'Male') {
      if (input.suicideThreatened) lines.push({ text: 'suicide threatened', pct: f.suicideThreatened });
      else if (input.previousAttempts) lines.push({ text: 'no threat made, but a history of attempts or threats', pct: f.notThreatenedWithHistory });
      else lines.push({ text: 'no suicide threat reported', pct: f.notThreatened });
      if (input.depression) lines.push({ text: 'depression diagnosed or suspected (independent of any threat)', pct: f.depression });
      if (input.significantPlaceKnown) lines.push({ text: input.suicideThreatened ? 'if found at a place significant to them' : 'if found at a place significant to them, no threat made', pct: input.suicideThreatened ? f.significantPlace : f.significantPlaceNoThreat });
      condition.modifiers = { basis: tag({ source: 'UKMPBS_2011', ref: 'Despondents c(ii)', n: f.nMales, level: 'category+sex' }), lines };
    } else if (sex === 'Female') {
      condition.modifiers = { basis: tag({ source: 'UKMPBS_2011', ref: 'Despondents c(ii)', level: 'category+sex' }), lines: [] };
    }
  }

  // ---- scenarios, tactics
  const scenarios = { basis: tag({ source: 'UKMPBS_2011', ref: `${study?.name ?? profile.name} g`, n: study?.n, level: 'category' }), items: study?.scenarios ?? [] };
  const tactics = tacticsFor({ category: input.category, terrain, sex, suicideThreatened: input.suicideThreatened, previousAttempts: input.previousAttempts, depression: input.depression, significantPlaceKnown: input.significantPlaceKnown });

  // ---- ISRID
  let isrid: SearchPlan['isrid'];
  const ig = isridFor(input.category, terrain, input.age);
  if (ig) {
    const d = ig.group.distanceKm[ig.ecoregion];
    isrid = {
      basis: tag({ source: 'ISRID_ASD_2020', ref: `Table 3 ${ig.ecoregion}`, n: d.n, level: terrain === 'Urban' ? 'category+terrain' : 'category' }),
      group: ig.group, ecoregion: ig.ecoregion,
      rings: [{ pct: 25, km: d.p25, interpolated: false }, { pct: 50, km: d.p50, interpolated: false }, { pct: 75, km: d.p75, interpolated: false }, { pct: 95, km: d.p95, interpolated: false }],
      findLocation: Object.entries(ig.group.findLocationPct[ig.ecoregion].pct).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([key, pct]) => ({ key, pct })),
      survivalDays: ig.group.survivalDays, mobilityHours: ig.group.mobilityHours, trackOffsetM: ig.group.trackOffsetM,
    };
    sources.add(ISRID_ASD.source.attribution);
  }

  // ---- context warnings
  if (ctx.daylight === false) warnings.push('Dark: halve sweep widths, expect the subject to be stationary and harder to see; survival falls overnight for the elderly and children.');
  if (ctx.tempC !== undefined && ctx.tempC < 8) warnings.push(`Air temperature ${Math.round(ctx.tempC)} °C: hypothermia risk; move casualty care forward.`);
  for (const w of ctx.warnings ?? []) warnings.push(`Active warning: ${w}`);
  warnings.push('UK land-search data (Mountain Rescue England & Wales), not Irish or coastal: use with the tide, drift and local knowledge panels, not instead of them.');
  sources.add('MISPER-UK is for trained search managers and does not itself constitute training; The Centre for Search Research accepts no responsibility for outcomes.');

  return { profile, study, input, rings, studyDistance, rawDistancesKm, locations, studyLocations, condition, scenarios, tactics, isrid, warnings, sources: [...sources] };
}

export { IMMEDIATE_TACTICS, CATEGORY_TACTICS };
