/**
 * The UK Missing Person Behaviour Study, August 2011 (Perkins, Roberts & Feeney; The Centre
 * for Search Research with Mountain Rescue England & Wales). Transcribed from the published
 * PDF (https://misper.uk/media/4sbfbwg2/uk-missing-person-behaviour-study-2011.pdf).
 *
 * Why a second source: the live MISPER-UK pages give distance and outcome per category only.
 * This study splits them by terrain and sex, gives the location detail level (road vs path,
 * habitation vs shelter), the despondent characteristic modifiers and "possible scenarios".
 * Counts are smaller and older (n=1271, cut-off September 2010); every table carries its
 * number so the card can cite it. Percentages are the study's own, kept as printed.
 *
 * Copyright The Centre for Search Research; no reuse licence stated. Used with attribution.
 */
import type { LpbTerrain } from './types.js';

export type Outcome2011 = 'fatal' | 'injured' | 'no trace' | 'unhurt';
export const OUTCOMES_2011: Outcome2011[] = ['fatal', 'injured', 'no trace', 'unhurt'];

export type LocationGroup2011 = 'building' | 'travel aid' | 'trees' | 'open ground' | 'water' | 'linear feature' | 'not recorded';
export const LOCATION_GROUPS_2011: LocationGroup2011[] = ['building', 'travel aid', 'trees', 'open ground', 'water', 'linear feature', 'not recorded'];

export type LocationDetail2011 = 'building / shelter' | 'habitation' | 'path / track' | 'road' | 'forest / woodland' | 'forest edge / clearing' | 'stream / ditch' | 'wall / fence line';
export const LOCATION_DETAILS_2011: LocationDetail2011[] = ['building / shelter', 'habitation', 'path / track', 'road', 'forest / woodland', 'forest edge / clearing', 'stream / ditch', 'wall / fence line'];

/** Which grouped location each detail row belongs to. */
export const DETAIL_GROUP_2011: Record<LocationDetail2011, LocationGroup2011> = {
  'building / shelter': 'building', habitation: 'building',
  'path / track': 'travel aid', road: 'travel aid',
  'forest / woodland': 'trees', 'forest edge / clearing': 'trees',
  'stream / ditch': 'linear feature', 'wall / fence line': 'linear feature',
};

export type Sex2011 = 'Male' | 'Female' | 'Mixed';

/**
 * A slice of a category the study reports separately. `terrains` lists the live MISPER-UK
 * terrain names that fall into it (empty = any terrain); `sex` narrows it further.
 */
export interface Segment2011 {
  /** Label exactly as the study prints it, e.g. "farmland female", "all other terrain types". */
  label: string;
  terrains?: LpbTerrain[];
  sex?: Sex2011;
}

export interface SegmentCounts2011<K extends string> extends Segment2011 {
  /** Base the study's percentages use, when it differs from the sum of the counts. */
  n?: number;
  counts: Partial<Record<K, number>>;
  /** Percentages as printed, when printed. */
  pct?: Partial<Record<K, number>>;
}

export interface SegmentDistance2011 extends Segment2011 {
  /** Cumulative: `pct` % of this segment's subjects were found within `km`. Step size shows the study's confidence tier. */
  points: { pct: number; km: number }[];
}

export interface Table2011<T> {
  table: string;
  segments: T[];
}

export interface Category2011 {
  slug: string;
  name: string;
  n: number;
  /** Headline fatality rate as printed (%). */
  fatalityPct?: number;
  /** The study prints raw figures only, with a caution, for categories under n=10. */
  lowNumbers: boolean;
  terrainBySex?: { table: string; rows: { terrain: string; female: number; male: number; other: number; mixed?: number; total: number }[] };
  outcome?: Table2011<SegmentCounts2011<Outcome2011>>;
  location?: Table2011<SegmentCounts2011<LocationGroup2011>>;
  locationDetail?: Table2011<SegmentCounts2011<LocationDetail2011>>;
  distance?: Table2011<SegmentDistance2011>;
  /** Categories under n=10: every reported distance, km. */
  rawDistancesKm?: number[];
  /** "Possible scenarios" bullets, as printed. */
  scenarios: string[];
  /** Significance statements and extra notes, as printed. */
  notes: string[];
}

const FARMLAND: LpbTerrain[] = ['Farmland'];
const URBAN: LpbTerrain[] = ['Urban'];
const NOT_FARM_URBAN: LpbTerrain[] = ['Crag / Broken Ground', 'Moorland / Upland', 'Plantation (dense)', 'Water Margin', 'Woodland / Parkland', 'Not Specified'];
const NOT_URBAN: LpbTerrain[] = ['Crag / Broken Ground', 'Farmland', 'Moorland / Upland', 'Plantation (dense)', 'Water Margin', 'Woodland / Parkland', 'Not Specified'];
const WOODS: LpbTerrain[] = ['Plantation (dense)', 'Woodland / Parkland'];
const MOOR: LpbTerrain[] = ['Moorland / Upland'];
const WATER: LpbTerrain[] = ['Water Margin'];
const CRAG: LpbTerrain[] = ['Crag / Broken Ground'];

export const UKMPBS_2011 = {
  source: {
    id: 'UKMPBS_2011',
    name: 'UK Missing Person Behaviour Study, August 2011',
    authors: 'Dave Perkins & Pete Roberts (Northumberland National Park MRT, The Centre for Search Research) and Ged Feeney (Penrith MRT, MREW Statistics Officer)',
    url: 'https://misper.uk/media/4sbfbwg2/uk-missing-person-behaviour-study-2011.pdf',
    cutOff: '2010-09',
    n: 1271,
    attribution: 'Figures from the UK Missing Person Behaviour Study 2011 © The Centre for Search Research.',
  },
  overall: {
    bySex: { table: 'Table 2', male: 820, female: 341, other: 77, mixed: 33 },
    outcome: { table: 'Table 3', counts: { unhurt: 801, fatal: 267, injured: 131, 'no trace': 72 } as Record<Outcome2011, number> },
    outcomeBySexPct: { table: 'Table 4', male: { unhurt: 60, fatal: 23, injured: 10, 'no trace': 7 }, female: { unhurt: 67, fatal: 17, injured: 13, 'no trace': 4 } } as { table: string; male: Record<Outcome2011, number>; female: Record<Outcome2011, number> },
    /** Granularity the study used, by segment size: full deciles, 20 % steps, quartiles, raw data. */
    tiers: [{ minN: 50, stepPct: 10 }, { minN: 20, stepPct: 20 }, { minN: 10, stepPct: 25 }, { minN: 0, stepPct: 100 }],
  },
  categories: [
    {
      slug: 'children-aged-1-16', name: 'Children aged 1 to 16 years', n: 113, fatalityPct: 3, lowNumbers: false,
      terrainBySex: { table: 'Table 5', rows: [
        { terrain: 'urban', female: 17, male: 25, other: 3, total: 45 }, { terrain: 'farmland', female: 5, male: 18, other: 2, total: 25 }, { terrain: 'moorland', female: 4, male: 8, other: 4, total: 16 },
        { terrain: 'plantation', female: 4, male: 4, other: 0, total: 8 }, { terrain: 'water margin', female: 1, male: 6, other: 0, total: 7 }, { terrain: 'woodland', female: 3, male: 4, other: 0, total: 7 }, { terrain: 'crag / broken ground', female: 1, male: 3, other: 1, total: 5 },
      ] },
      outcome: { table: 'Table 6', segments: [{ label: 'all searches', counts: { fatal: 3, injured: 1, unhurt: 109, 'no trace': 0 }, pct: { fatal: 3, injured: 1, unhurt: 96, 'no trace': 0 } }] },
      location: { table: 'Table 7', segments: [
        { label: 'urban', terrains: URBAN, counts: { building: 32, 'travel aid': 5, trees: 1, 'open ground': 4, water: 0, 'linear feature': 2, 'not recorded': 1 }, pct: { building: 71, 'travel aid': 11, trees: 2, 'open ground': 9, water: 0, 'linear feature': 4, 'not recorded': 2 } },
        { label: 'farmland', terrains: FARMLAND, counts: { building: 13, 'travel aid': 2, trees: 5, 'open ground': 2, water: 1, 'linear feature': 2, 'not recorded': 0 }, pct: { building: 52, 'travel aid': 8, trees: 20, 'open ground': 8, water: 4, 'linear feature': 8, 'not recorded': 0 } },
        { label: 'others', terrains: NOT_FARM_URBAN, counts: { building: 14, 'travel aid': 14, trees: 5, 'open ground': 5, water: 3, 'linear feature': 1, 'not recorded': 1 }, pct: { building: 33, 'travel aid': 33, trees: 12, 'open ground': 12, water: 7, 'linear feature': 2, 'not recorded': 2 } },
      ] },
      locationDetail: { table: 'Table 8', segments: [
        { label: 'urban', terrains: URBAN, counts: { 'building / shelter': 9, habitation: 23, 'path / track': 1, road: 4, 'forest / woodland': 1, 'forest edge / clearing': 0, 'stream / ditch': 0, 'wall / fence line': 2 }, pct: { 'building / shelter': 20, habitation: 51, 'path / track': 2, road: 9, 'forest / woodland': 2, 'forest edge / clearing': 0, 'stream / ditch': 0, 'wall / fence line': 4 } },
        { label: 'farmland', terrains: FARMLAND, counts: { 'building / shelter': 6, habitation: 7, 'path / track': 0, road: 2, 'forest / woodland': 3, 'forest edge / clearing': 2, 'stream / ditch': 2, 'wall / fence line': 0 }, pct: { 'building / shelter': 24, habitation: 28, 'path / track': 0, road: 8, 'forest / woodland': 12, 'forest edge / clearing': 8, 'stream / ditch': 8, 'wall / fence line': 0 } },
        { label: 'others', terrains: NOT_FARM_URBAN, counts: { 'building / shelter': 6, habitation: 8, 'path / track': 5, road: 9, 'forest / woodland': 5, 'forest edge / clearing': 0, 'stream / ditch': 0, 'wall / fence line': 1 }, pct: { 'building / shelter': 14, habitation: 19, 'path / track': 12, road: 21, 'forest / woodland': 12, 'forest edge / clearing': 0, 'stream / ditch': 0, 'wall / fence line': 2 } },
      ] },
      distance: { table: 'Table 9', segments: [
        { label: 'farmland', terrains: FARMLAND, points: [{ pct: 20, km: 0.1 }, { pct: 40, km: 0.5 }, { pct: 60, km: 0.7 }, { pct: 80, km: 2 }, { pct: 100, km: 5 }] },
        { label: 'others', terrains: ['Urban', ...NOT_FARM_URBAN], points: [{ pct: 10, km: 0 }, { pct: 20, km: 0.5 }, { pct: 30, km: 0.58 }, { pct: 40, km: 1 }, { pct: 50, km: 1.1 }, { pct: 60, km: 2 }, { pct: 70, km: 2.2 }, { pct: 80, km: 5 }, { pct: 90, km: 9.2 }, { pct: 100, km: 130 }] },
      ] },
      scenarios: [
        'the missing child is likely to be found alive (96% of incidents)',
        'in an urban environment, a missing child is likely to be found in a building (71%), the majority of which (51%) are classed as habitation',
        'a child missing in farmland is likely to be found in a building (52%), which is almost equally likely to be classed as habitation or building / shelter, or in trees (20%)',
        'in environments other than urban or farmland the missing child is equally likely (33% of incidents each) to be found in a building (habitation and building / shelter equally likely) or on a travel aid (almost twice as likely to be on a road as on a path or track)',
        'a child missing in farmland is likely to be found closer to the IPP than a child missing in other environments; in farmland, 50% are found within 0.5 km of the IPP, whereas in other environments 50% are found within 1.1 km of the IPP',
      ],
      notes: [
        'The fatality rate for children was 3%, which is significantly lower than the fatality rate for the other categories in the study.',
        'Children were significantly different from the other categories in all respects: more were found unhurt, and fewer were either found injured or not found at all. No discernible gender or terrain difference in outcome.',
        'Location found: no discernible gender difference; significant differences between terrain types, in particular the likelihood of being found in a building.',
        'Distance: no significant difference from the other categories, but children missing in farmland were found significantly closer than children in other terrain. No discernible gender difference.',
        'One "open ground" find: sheltering under bushes.',
      ],
    },
    {
      slug: 'climber', name: 'Climber', n: 3, lowNumbers: true,
      outcome: { table: 'text', segments: [{ label: 'all searches', counts: { fatal: 2, injured: 0, unhurt: 1, 'no trace': 0 } }] },
      location: { table: 'text', segments: [{ label: 'all searches', counts: { 'open ground': 2, building: 1 } }] },
      locationDetail: { table: 'text', segments: [{ label: 'all searches', counts: { habitation: 1 } }] },
      rawDistancesKm: [0.8, 2, 27],
      scenarios: [],
      notes: ['Insufficient data to draw any firm conclusions; the figures are unprocessed and should be used with caution.'],
    },
    {
      slug: 'dementia', name: 'Dementia', n: 194, fatalityPct: 18, lowNumbers: false,
      terrainBySex: { table: 'Table 10', rows: [
        { terrain: 'urban', female: 29, male: 62, other: 8, total: 99 }, { terrain: 'farmland', female: 21, male: 41, other: 3, total: 65 }, { terrain: 'woodland', female: 4, male: 6, other: 1, total: 11 }, { terrain: 'moorland', female: 0, male: 8, other: 0, total: 8 },
        { terrain: 'water margin', female: 3, male: 3, other: 0, total: 6 }, { terrain: 'plantation', female: 1, male: 2, other: 0, total: 3 }, { terrain: 'crag / broken ground', female: 1, male: 1, other: 0, total: 2 },
      ] },
      outcome: { table: 'Table 11', segments: [{ label: 'all searches', counts: { fatal: 34, injured: 31, 'no trace': 6, unhurt: 123 }, pct: { fatal: 18, injured: 16, 'no trace': 3, unhurt: 63 } }] },
      location: { table: 'Table 12', segments: [
        { label: 'farmland female', terrains: FARMLAND, sex: 'Female', counts: { 'travel aid': 8, building: 5, 'linear feature': 2, 'open ground': 1, trees: 3, water: 0, 'not recorded': 0 }, pct: { 'travel aid': 42, building: 26, 'linear feature': 11, 'open ground': 5, trees: 16, water: 0, 'not recorded': 0 } },
        { label: 'farmland male', terrains: FARMLAND, sex: 'Male', counts: { 'travel aid': 12, building: 8, 'linear feature': 12, 'open ground': 7, trees: 1, water: 1, 'not recorded': 0 }, pct: { 'travel aid': 29, building: 20, 'linear feature': 29, 'open ground': 17, trees: 2, water: 2, 'not recorded': 0 } },
        { label: 'urban', terrains: URBAN, counts: { 'travel aid': 35, building: 29, 'linear feature': 17, 'open ground': 11, trees: 1, water: 4, 'not recorded': 1 }, pct: { 'travel aid': 36, building: 30, 'linear feature': 17, 'open ground': 11, trees: 1, water: 4, 'not recorded': 1 } },
        { label: 'others', terrains: NOT_FARM_URBAN, counts: { 'travel aid': 1, building: 2, 'linear feature': 5, 'open ground': 8, trees: 7, water: 5, 'not recorded': 0 }, pct: { 'travel aid': 4, building: 7, 'linear feature': 21, 'open ground': 29, trees: 21, water: 18, 'not recorded': 0 } },
      ] },
      locationDetail: { table: 'Table 13', segments: [
        { label: 'farmland female', terrains: FARMLAND, sex: 'Female', counts: { 'path / track': 2, road: 6, 'building / shelter': 1, habitation: 4, 'stream / ditch': 1, 'wall / fence line': 1, 'forest / woodland': 2, 'forest edge / clearing': 1 }, pct: { 'path / track': 11, road: 32, 'building / shelter': 5, habitation: 21, 'stream / ditch': 5, 'wall / fence line': 5, 'forest / woodland': 11, 'forest edge / clearing': 5 } },
        { label: 'farmland male', terrains: FARMLAND, sex: 'Male', counts: { 'path / track': 6, road: 6, 'building / shelter': 3, habitation: 5, 'stream / ditch': 6, 'wall / fence line': 6, 'forest / woodland': 1, 'forest edge / clearing': 0 }, pct: { 'path / track': 15, road: 15, 'building / shelter': 7, habitation: 12, 'stream / ditch': 15, 'wall / fence line': 15, 'forest / woodland': 2, 'forest edge / clearing': 0 } },
        { label: 'urban', terrains: URBAN, counts: { 'path / track': 7, road: 28, 'building / shelter': 8, habitation: 21, 'stream / ditch': 7, 'wall / fence line': 10, 'forest / woodland': 1, 'forest edge / clearing': 0 }, pct: { 'path / track': 7, road: 29, 'building / shelter': 8, habitation: 21, 'stream / ditch': 7, 'wall / fence line': 10, 'forest / woodland': 1, 'forest edge / clearing': 0 } },
        { label: 'others', terrains: NOT_FARM_URBAN, counts: { 'path / track': 1, road: 0, 'building / shelter': 1, habitation: 1, 'stream / ditch': 3, 'wall / fence line': 2, 'forest / woodland': 5, 'forest edge / clearing': 2 }, pct: { 'path / track': 4, road: 0, 'building / shelter': 4, habitation: 4, 'stream / ditch': 11, 'wall / fence line': 7, 'forest / woodland': 18, 'forest edge / clearing': 7 } },
      ] },
      distance: { table: 'Table 14', segments: [
        { label: 'farmland', terrains: FARMLAND, points: [{ pct: 10, km: 0.4 }, { pct: 20, km: 0.5 }, { pct: 30, km: 0.7 }, { pct: 40, km: 1 }, { pct: 50, km: 1.2 }, { pct: 60, km: 2 }, { pct: 70, km: 3 }, { pct: 80, km: 5.2 }, { pct: 90, km: 8.8 }, { pct: 100, km: 84 }] },
        { label: 'urban', terrains: URBAN, points: [{ pct: 10, km: 0.16 }, { pct: 20, km: 0.3 }, { pct: 30, km: 0.5 }, { pct: 40, km: 1 }, { pct: 50, km: 1.7 }, { pct: 60, km: 2.7 }, { pct: 70, km: 4 }, { pct: 80, km: 5 }, { pct: 90, km: 8.7 }, { pct: 100, km: 33 }] },
        { label: 'others', terrains: NOT_FARM_URBAN, points: [{ pct: 20, km: 0.64 }, { pct: 40, km: 1 }, { pct: 60, km: 2 }, { pct: 80, km: 2.5 }, { pct: 100, km: 9.9 }] },
      ] },
      scenarios: [
        'the missing person is likely to be found alive (82% of incidents)',
        'for incidents in farmland, females are most likely to be found on a travel aid (42%) or in a building (26%); males are equally likely (29%) to be found on a travel aid or next to a linear feature, or in a building (20%)',
        'in urban areas, the missing person is most likely to be found on a travel aid (36%) or in a building (29%)',
      ],
      notes: [
        'Fatality rate 18%: not significantly different from the other categories; no discernible gender or terrain difference.',
        'Significantly more dementia sufferers were found injured than in all other categories.',
        'Location found: significant difference between farmland and urban, and a significant gender difference in farmland.',
        'Distance: no significant difference from the other categories, but a significant difference between farmland and urban.',
        '"Open ground" finds (5): hit a natural barrier and sat down, stuck in dense undergrowth, asleep on a park bench, in thick bushes, in a patch of overgrown nettles and grass.',
      ],
    },
    {
      slug: 'despondent', name: 'Despondents', n: 457, lowNumbers: false,
      terrainBySex: { table: 'Table 15', rows: [
        { terrain: 'farmland', female: 54, male: 75, other: 2, total: 131 }, { terrain: 'urban', female: 46, male: 51, other: 12, total: 109 }, { terrain: 'woodland', female: 15, male: 46, other: 2, total: 63 }, { terrain: 'moorland', female: 12, male: 45, other: 4, total: 61 },
        { terrain: 'water margin', female: 10, male: 33, other: 2, total: 45 }, { terrain: 'plantation', female: 3, male: 29, other: 0, total: 32 }, { terrain: 'crag / broken ground', female: 3, male: 13, other: 0, total: 16 },
      ] },
      outcome: { table: 'Table 17', segments: [
        { label: 'farmland female', terrains: FARMLAND, sex: 'Female', counts: { fatal: 11, injured: 6, 'no trace': 5, unhurt: 32 }, pct: { fatal: 20, injured: 11, 'no trace': 9, unhurt: 59 } },
        { label: 'farmland male', terrains: FARMLAND, sex: 'Male', counts: { fatal: 23, injured: 8, 'no trace': 8, unhurt: 36 }, pct: { fatal: 31, injured: 11, 'no trace': 11, unhurt: 48 } },
        { label: 'urban', terrains: URBAN, counts: { fatal: 32, injured: 6, 'no trace': 8, unhurt: 63 }, pct: { fatal: 29, injured: 6, 'no trace': 7, unhurt: 58 } },
        { label: 'plantations & woodland', terrains: WOODS, counts: { fatal: 37, injured: 19, 'no trace': 11, unhurt: 28 }, pct: { fatal: 39, injured: 20, 'no trace': 12, unhurt: 29 } },
        { label: 'water margin', terrains: WATER, counts: { fatal: 25, injured: 4, 'no trace': 5, unhurt: 11 }, pct: { fatal: 56, injured: 9, 'no trace': 11, unhurt: 24 } },
        { label: 'all other terrain types', terrains: ['Moorland / Upland', 'Crag / Broken Ground', 'Not Specified'], counts: { fatal: 19, injured: 15, 'no trace': 5, unhurt: 38 }, pct: { fatal: 25, injured: 19, 'no trace': 6, unhurt: 49 } },
      ] },
      location: { table: 'Table 18', segments: [
        { label: 'farmland female', terrains: FARMLAND, sex: 'Female', counts: { building: 17, trees: 7, water: 8, 'travel aid': 12, 'open ground': 2, 'linear feature': 2, 'not recorded': 1 }, pct: { building: 35, trees: 14, water: 16, 'travel aid': 24, 'open ground': 4, 'linear feature': 4, 'not recorded': 2 } },
        { label: 'farmland male', terrains: FARMLAND, sex: 'Male', counts: { building: 28, trees: 8, water: 3, 'travel aid': 12, 'open ground': 10, 'linear feature': 5, 'not recorded': 1 }, pct: { building: 42, trees: 12, water: 4, 'travel aid': 18, 'open ground': 15, 'linear feature': 7, 'not recorded': 1 } },
        { label: 'urban', terrains: URBAN, counts: { building: 48, trees: 8, water: 20, 'travel aid': 14, 'open ground': 7, 'linear feature': 3, 'not recorded': 1 }, pct: { building: 48, trees: 8, water: 20, 'travel aid': 14, 'open ground': 7, 'linear feature': 3, 'not recorded': 1 } },
        { label: 'plantations & woodland', terrains: WOODS, counts: { building: 11, trees: 54, water: 5, 'travel aid': 9, 'open ground': 3, 'linear feature': 1, 'not recorded': 1 }, pct: { building: 13, trees: 64, water: 6, 'travel aid': 11, 'open ground': 4, 'linear feature': 1, 'not recorded': 1 } },
        { label: 'moorland', terrains: MOOR, counts: { building: 10, trees: 10, water: 7, 'travel aid': 15, 'open ground': 9, 'linear feature': 6, 'not recorded': 0 }, pct: { building: 18, trees: 18, water: 12, 'travel aid': 26, 'open ground': 16, 'linear feature': 11, 'not recorded': 0 } },
        { label: 'water margins', terrains: WATER, counts: { building: 6, trees: 4, water: 22, 'travel aid': 2, 'open ground': 1, 'linear feature': 4, 'not recorded': 1 }, pct: { building: 15, trees: 10, water: 55, 'travel aid': 5, 'open ground': 3, 'linear feature': 10, 'not recorded': 3 } },
        { label: 'crag / broken ground', terrains: CRAG, counts: { building: 1, trees: 5, water: 2, 'travel aid': 1, 'open ground': 5, 'linear feature': 1, 'not recorded': 0 } },
      ] },
      locationDetail: { table: 'Table 19', segments: [
        { label: 'farmland female', terrains: FARMLAND, sex: 'Female', counts: { 'building / shelter': 3, habitation: 14, 'forest / woodland': 4, 'forest edge / clearing': 3, 'path / track': 1, road: 11, 'stream / ditch': 1, 'wall / fence line': 1 }, pct: { 'building / shelter': 6, habitation: 29, 'forest / woodland': 8, 'forest edge / clearing': 6, 'path / track': 2, road: 22, 'stream / ditch': 2, 'wall / fence line': 2 } },
        { label: 'farmland male', terrains: FARMLAND, sex: 'Male', counts: { 'building / shelter': 15, habitation: 13, 'forest / woodland': 2, 'forest edge / clearing': 6, 'path / track': 7, road: 5, 'stream / ditch': 3, 'wall / fence line': 2 }, pct: { 'building / shelter': 23, habitation: 19, 'forest / woodland': 3, 'forest edge / clearing': 9, 'path / track': 11, road: 7, 'stream / ditch': 4, 'wall / fence line': 3 } },
        { label: 'urban', terrains: URBAN, counts: { 'building / shelter': 14, habitation: 34, 'forest / woodland': 5, 'forest edge / clearing': 3, 'path / track': 2, road: 12, 'stream / ditch': 1, 'wall / fence line': 2 }, pct: { 'building / shelter': 14, habitation: 34, 'forest / woodland': 5, 'forest edge / clearing': 3, 'path / track': 2, road: 12, 'stream / ditch': 1, 'wall / fence line': 2 } },
        { label: 'plantations & woodland', terrains: WOODS, counts: { 'building / shelter': 2, habitation: 9, 'forest / woodland': 41, 'forest edge / clearing': 13, 'path / track': 5, road: 4, 'stream / ditch': 1, 'wall / fence line': 0 }, pct: { 'building / shelter': 2, habitation: 11, 'forest / woodland': 49, 'forest edge / clearing': 15, 'path / track': 6, road: 5, 'stream / ditch': 1, 'wall / fence line': 0 } },
        { label: 'moorland', terrains: MOOR, counts: { 'building / shelter': 4, habitation: 6, 'forest / woodland': 8, 'forest edge / clearing': 2, 'path / track': 7, road: 8, 'stream / ditch': 4, 'wall / fence line': 2 }, pct: { 'building / shelter': 7, habitation: 11, 'forest / woodland': 14, 'forest edge / clearing': 4, 'path / track': 12, road: 14, 'stream / ditch': 7, 'wall / fence line': 4 } },
        { label: 'water margins', terrains: WATER, counts: { 'building / shelter': 5, habitation: 1, 'forest / woodland': 3, 'forest edge / clearing': 1, 'path / track': 1, road: 1, 'stream / ditch': 4, 'wall / fence line': 0 }, pct: { 'building / shelter': 13, habitation: 2, 'forest / woodland': 8, 'forest edge / clearing': 2, 'path / track': 3, road: 3, 'stream / ditch': 10, 'wall / fence line': 0 } },
        { label: 'crag / broken ground', terrains: CRAG, counts: { 'building / shelter': 1, habitation: 0, 'forest / woodland': 5, 'forest edge / clearing': 0, 'path / track': 0, road: 1, 'stream / ditch': 0, 'wall / fence line': 1 } },
      ] },
      distance: { table: 'Table 20', segments: [
        { label: 'all searches', points: [{ pct: 10, km: 0.1 }, { pct: 20, km: 0.22 }, { pct: 30, km: 0.5 }, { pct: 40, km: 0.7 }, { pct: 50, km: 1 }, { pct: 60, km: 1.5 }, { pct: 70, km: 2.5 }, { pct: 80, km: 5.4 }, { pct: 90, km: 15 }, { pct: 100, km: 150 }] },
      ] },
      scenarios: [
        "'Lines and points': points are the missing person's likely destinations (a building, trees, or a body of water), and lines are the routes they could have taken to get there; which depends on the terrain and, in farmland, on gender",
        'Use local knowledge plus the missing person\'s habits and patterns of behaviour with the location tables to identify likely destinations, in particular places which are either familiar to them or which could be described as scenic',
      ],
      notes: [
        'Despondents were significantly different from all other categories: fewer found unhurt, more injured or not found at all. Outcome varied with terrain and, in farmland, by gender.',
        'Fatality rate by terrain ranged from 18% (moorland) to 56% (water margin).',
        'Distance: 36% of despondents were found within 0.5 km of the IPP compared to 25% of the other categories; terrain and gender made no significant difference.',
        'Significant locations: 15% of female and 14% of male despondents were found somewhere significant to them (a beauty spot or viewpoint, a place with memories, a regular route). 62% of males found in such places were dead, against 29% elsewhere; 70% if no suicide threat had been made. No such difference for females.',
        '"Open ground" finds (4): at a high vantage point overlooking the valley, close to a footpath, in a quarry, in the hospital grounds.',
        'Characteristics come from the free-text fields of reports and are only as complete as the reporting; 69% of despondent reports mentioned at least one.',
      ],
    },
    {
      slug: 'developmental-problem', name: 'Developmental Problems', n: 37, fatalityPct: 5, lowNumbers: false,
      terrainBySex: { table: 'Table 21', rows: [{ terrain: 'urban', female: 3, male: 8, other: 1, total: 12 }, { terrain: 'farmland', female: 2, male: 9, other: 0, total: 11 }, { terrain: 'other terrain types', female: 3, male: 11, other: 0, total: 14 }] },
      outcome: { table: 'Table 22', segments: [{ label: 'all searches', counts: { fatal: 2, injured: 2, 'no trace': 1, unhurt: 32 }, pct: { fatal: 5, injured: 5, 'no trace': 3, unhurt: 86 } }] },
      location: { table: 'Table 23', segments: [
        { label: 'urban', terrains: URBAN, counts: { building: 7, trees: 1, 'travel aid': 2, water: 0, 'linear feature': 0, 'open ground': 0, 'not recorded': 1 } },
        { label: 'non-urban', terrains: NOT_URBAN, counts: { building: 8, trees: 7, 'travel aid': 4, water: 3, 'linear feature': 2, 'open ground': 1, 'not recorded': 0 }, pct: { building: 32, trees: 28, 'travel aid': 16, water: 12, 'linear feature': 8, 'open ground': 4, 'not recorded': 0 } },
      ] },
      locationDetail: { table: 'Table 24', segments: [
        { label: 'urban', terrains: URBAN, counts: { 'building / shelter': 3, habitation: 4, 'forest / woodland': 0, 'forest edge / clearing': 1, 'path / track': 1, road: 1, 'stream / ditch': 0, 'wall / fence line': 0 } },
        { label: 'non-urban', terrains: NOT_URBAN, counts: { 'building / shelter': 2, habitation: 6, 'forest / woodland': 6, 'forest edge / clearing': 1, 'path / track': 1, road: 3, 'stream / ditch': 0, 'wall / fence line': 2 }, pct: { 'building / shelter': 8, habitation: 24, 'forest / woodland': 24, 'forest edge / clearing': 4, 'path / track': 4, road: 12, 'stream / ditch': 0, 'wall / fence line': 8 } },
      ] },
      distance: { table: 'Table 25', segments: [{ label: 'all searches', points: [{ pct: 20, km: 0.24 }, { pct: 40, km: 0.76 }, { pct: 60, km: 2.6 }, { pct: 80, km: 10 }, { pct: 100, km: 35 }] }] },
      scenarios: [
        'the missing person is likely to be found alive (95% of incidents)',
        'for incidents in urban areas the missing person is most likely to be found in a building (7 out of 12 incidents)',
        'for incidents in non-urban areas the missing person is most likely to be found in a building (32% of incidents) or among trees (28% of incidents)',
      ],
      notes: [
        'Fatality rate 5%, significantly lower than all the other categories; significantly more found unhurt. No discernible terrain or gender difference.',
        'In an urban environment the likelihood of being found in a building was significantly greater than in all other terrain.',
        'Distance: no discernible difference from the other categories, nor by terrain or gender.',
      ],
    },
    {
      slug: 'fellrunner', name: 'Fell-runner', n: 7, lowNumbers: true,
      outcome: { table: 'text', segments: [{ label: 'all searches', counts: { fatal: 1, injured: 0, unhurt: 6, 'no trace': 0 } }] },
      location: { table: 'text', segments: [{ label: 'all searches', counts: { 'open ground': 3, 'travel aid': 4 } }] },
      locationDetail: { table: 'text', segments: [{ label: 'all searches', counts: { road: 3, 'path / track': 1 } }] },
      rawDistancesKm: [1.1, 1.3, 2, 2.9, 5.5, 6],
      scenarios: [],
      notes: ['Insufficient data to draw any firm conclusions (2 female, 5 male); the figures are unprocessed and should be used with caution. The distance was not reported in one incident.'],
    },
    {
      slug: 'health-related', name: 'Health Related', n: 8, lowNumbers: true,
      outcome: { table: 'text', segments: [{ label: 'all searches', counts: { fatal: 2, injured: 1, unhurt: 5, 'no trace': 0 } }] },
      location: { table: 'text', segments: [{ label: 'all searches', counts: { 'travel aid': 3, building: 2, trees: 1, 'open ground': 1, 'linear feature': 1 } }] },
      locationDetail: { table: 'text', segments: [{ label: 'all searches', counts: { road: 2, 'building / shelter': 1, 'forest edge / clearing': 1, habitation: 1, 'path / track': 1, 'stream / ditch': 1 } }] },
      rawDistancesKm: [1, 2, 2.5, 3, 5, 5, 8, 15],
      scenarios: [],
      notes: ['Insufficient data to draw any firm conclusions (3 female, 5 male); the figures are unprocessed and should be used with caution.'],
    },
    {
      slug: 'miscellaneous', name: 'Miscellaneous', n: 29, fatalityPct: 21, lowNumbers: false,
      terrainBySex: { table: 'Table 26', rows: [{ terrain: 'farmland', female: 1, male: 7, other: 0, mixed: 0, total: 8 }, { terrain: 'moorland', female: 1, male: 7, other: 0, mixed: 0, total: 8 }, { terrain: 'other terrain types', female: 3, male: 9, other: 0, mixed: 1, total: 13 }] },
      outcome: { table: 'Table 27', segments: [{ label: 'all searches', counts: { fatal: 6, injured: 3, 'no trace': 3, unhurt: 17 }, pct: { fatal: 21, injured: 10, 'no trace': 10, unhurt: 59 } }] },
      location: { table: 'Table 28', segments: [{ label: 'all searches', counts: { building: 10, 'travel aid': 7, 'open ground': 4, water: 3, trees: 2, 'linear feature': 0 }, pct: { building: 38, 'travel aid': 27, 'open ground': 14, water: 12, trees: 8, 'linear feature': 0 } }] },
      locationDetail: { table: 'Table 29', segments: [{ label: 'all searches', counts: { 'building / shelter': 4, habitation: 6, 'path / track': 2, road: 5, 'forest / woodland': 2, 'forest edge / clearing': 0 }, pct: { 'building / shelter': 15, habitation: 23, 'path / track': 8, road: 19, 'forest / woodland': 8, 'forest edge / clearing': 0 } }] },
      distance: { table: 'Table 30', segments: [{ label: 'all searches', points: [{ pct: 20, km: 0.36 }, { pct: 40, km: 1.7 }, { pct: 60, km: 3.1 }, { pct: 80, km: 9.9 }, { pct: 100, km: 500 }] }] },
      scenarios: ['the missing person is found alive (79%)', 'the missing person is found in a building (38%) or on a travel aid (27%)'],
      notes: [
        'Fatality rate 21%, not significantly different from all other categories combined; no discernible gender difference. Numbers per terrain too small for analysis.',
        'Distance: no significant difference from the other categories, but some extreme distances were reported.',
        'One "open ground" find: stuck in a field.',
      ],
    },
    {
      slug: 'mountain-biker', name: 'Mountain Biker', n: 6, lowNumbers: true,
      outcome: { table: 'text', segments: [{ label: 'all searches', counts: { fatal: 1, injured: 1, unhurt: 4, 'no trace': 0 } }] },
      location: { table: 'text', segments: [{ label: 'all searches', counts: { 'open ground': 2, building: 1, trees: 1, 'travel aid': 1, 'linear feature': 1 } }] },
      locationDetail: { table: 'text', segments: [{ label: 'all searches', counts: { 'building / shelter': 1, 'forest / woodland': 1, 'path / track': 1, 'wall / fence line': 1 } }] },
      rawDistancesKm: [0.9, 1, 1.2, 3, 24, 100],
      scenarios: [],
      notes: ['Insufficient data to draw any firm conclusions (5 male, 1 mixed group); the figures are unprocessed and should be used with caution.'],
    },
    {
      slug: 'other-vulnerable', name: 'Other Vulnerables', n: 83, fatalityPct: 13, lowNumbers: false,
      terrainBySex: { table: 'Table 36', rows: [{ terrain: 'urban', female: 11, male: 17, other: 4, total: 32 }, { terrain: 'farmland', female: 9, male: 21, other: 1, total: 31 }, { terrain: 'other terrain types', female: 6, male: 14, other: 0, total: 20 }] },
      outcome: { table: 'Table 37', segments: [{ label: 'all searches', counts: { fatal: 11, injured: 10, 'no trace': 4, unhurt: 58 }, pct: { fatal: 13, injured: 12, 'no trace': 5, unhurt: 70 } }] },
      location: { table: 'Table 38', segments: [
        { label: 'urban', terrains: URBAN, n: 32, counts: { building: 19, 'travel aid': 6, 'open ground': 2, trees: 3, 'linear feature': 1, water: 0, 'not recorded': 0 }, pct: { building: 59, 'travel aid': 19, 'open ground': 6, trees: 9, 'linear feature': 3, water: 0, 'not recorded': 0 } },
        { label: 'farmland female', terrains: FARMLAND, sex: 'Female', counts: { building: 0, 'travel aid': 3, 'open ground': 4, trees: 0, 'linear feature': 1, water: 0, 'not recorded': 0 } },
        { label: 'farmland male', terrains: FARMLAND, sex: 'Male', n: 21, counts: { building: 6, 'travel aid': 7, 'open ground': 3, trees: 1, 'linear feature': 2, water: 2, 'not recorded': 0 }, pct: { building: 29, 'travel aid': 33, 'open ground': 14, trees: 5, 'linear feature': 10, water: 10, 'not recorded': 0 } },
        { label: 'all others', terrains: NOT_FARM_URBAN, counts: { building: 4, 'travel aid': 6, 'open ground': 2, trees: 3, 'linear feature': 1, water: 1, 'not recorded': 1 } },
      ] },
      locationDetail: { table: 'Table 39', segments: [
        { label: 'urban', terrains: URBAN, n: 32, counts: { 'building / shelter': 5, habitation: 14, 'path / track': 1, road: 5, 'forest / woodland': 2, 'forest edge / clearing': 1, 'stream / ditch': 0, 'wall / fence line': 1 }, pct: { 'building / shelter': 16, habitation: 44, 'path / track': 3, road: 16, 'forest / woodland': 6, 'forest edge / clearing': 3, 'stream / ditch': 0, 'wall / fence line': 3 } },
        { label: 'farmland female', terrains: FARMLAND, sex: 'Female', counts: { 'building / shelter': 0, habitation: 0, 'path / track': 0, road: 3, 'forest / woodland': 0, 'forest edge / clearing': 0, 'stream / ditch': 1, 'wall / fence line': 0 } },
        { label: 'farmland male', terrains: FARMLAND, sex: 'Male', n: 21, counts: { 'building / shelter': 1, habitation: 5, 'path / track': 1, road: 6, 'forest / woodland': 1, 'forest edge / clearing': 0, 'stream / ditch': 2, 'wall / fence line': 0 }, pct: { 'building / shelter': 5, habitation: 24, 'path / track': 5, road: 29, 'forest / woodland': 5, 'forest edge / clearing': 0, 'stream / ditch': 10, 'wall / fence line': 0 } },
        { label: 'all others', terrains: NOT_FARM_URBAN, counts: { 'building / shelter': 1, habitation: 3, 'path / track': 4, road: 2, 'forest / woodland': 3, 'forest edge / clearing': 0, 'stream / ditch': 1, 'wall / fence line': 0 } },
      ] },
      distance: { table: 'Table 40', segments: [
        { label: 'farmland', terrains: FARMLAND, points: [{ pct: 20, km: 0.46 }, { pct: 40, km: 1.4 }, { pct: 60, km: 2 }, { pct: 80, km: 3.6 }, { pct: 100, km: 50 }] },
        { label: 'urban', terrains: URBAN, points: [{ pct: 20, km: 0 }, { pct: 40, km: 0.48 }, { pct: 60, km: 1 }, { pct: 80, km: 9.4 }, { pct: 100, km: 310 }] },
        { label: 'all other terrain types', terrains: NOT_FARM_URBAN, points: [{ pct: 25, km: 0.5 }, { pct: 50, km: 2 }, { pct: 75, km: 4.1 }, { pct: 100, km: 40 }] },
      ] },
      scenarios: [
        'the missing person is likely to be found alive (92% of incidents involving females, 83% involving males)',
        'for incidents involving males in urban areas the missing person is most likely to be found in a building (8 out of 17 incidents), on a travel aid (4 out of 17) or among trees (3 out of 17)',
        'for incidents involving males in farmland the missing person is likely to be found on a travel aid (33%), particularly a road (29%) or in a building (29%)',
        'for incidents involving females in farmland the missing person is most likely to be found in open ground (4 out of 9 incidents) or on a travel aid, particularly a road (3 out of 9)',
        'for incidents involving females in urban areas the missing person is most likely to be found in a building (7 out of 11 incidents)',
        'in urban areas the missing person is likely to be found within 1 km of the IPP (50% of incidents); in all other types of terrain the missing person is likely to be found within 2 km of the IPP (50% of incidents)',
      ],
      notes: [
        'Fatality rate 13%, not significantly different from the other categories.',
        'Location found in urban areas was significantly different from farmland, with a significant gender difference in farmland.',
        'Significant differences in distance between farmland and urban; no discernible gender difference.',
      ],
    },
    {
      slug: 'psychological-illness', name: 'Psychological Illness', n: 63, fatalityPct: 21, lowNumbers: false,
      terrainBySex: { table: 'Table 41', rows: [{ terrain: 'urban', female: 5, male: 13, other: 4, total: 22 }, { terrain: 'farmland', female: 10, male: 6, other: 1, total: 17 }, { terrain: 'other terrain types', female: 5, male: 16, other: 3, total: 24 }] },
      outcome: { table: 'Table 42', segments: [{ label: 'all searches', counts: { fatal: 13, injured: 4, 'no trace': 10, unhurt: 36 }, pct: { fatal: 21, injured: 6, 'no trace': 16, unhurt: 57 } }] },
      location: { table: 'Table 43', segments: [
        { label: 'urban', terrains: URBAN, counts: { 'travel aid': 3, building: 11, 'open ground': 1, trees: 1, 'linear feature': 1, water: 1, 'not recorded': 1 } },
        { label: 'all other terrain types', terrains: NOT_URBAN, counts: { 'travel aid': 14, building: 5, 'open ground': 5, trees: 4, 'linear feature': 3, water: 3, 'not recorded': 0 }, pct: { 'travel aid': 41, building: 15, 'open ground': 15, trees: 12, 'linear feature': 9, water: 9, 'not recorded': 0 } },
      ] },
      locationDetail: { table: 'Table 44', segments: [
        { label: 'urban', terrains: URBAN, counts: { 'path / track': 1, road: 2, 'building / shelter': 3, habitation: 8, 'forest / woodland': 0, 'forest edge / clearing': 1, 'stream / ditch': 0, 'wall / fence line': 1 } },
        { label: 'all other terrain types', terrains: NOT_URBAN, counts: { 'path / track': 7, road: 7, 'building / shelter': 4, habitation: 1, 'forest / woodland': 4, 'forest edge / clearing': 0, 'stream / ditch': 2, 'wall / fence line': 1 }, pct: { 'path / track': 21, road: 21, 'building / shelter': 12, habitation: 3, 'forest / woodland': 12, 'forest edge / clearing': 0, 'stream / ditch': 6, 'wall / fence line': 3 } },
      ] },
      distance: { table: 'Table 45', segments: [{ label: 'all searches', points: [{ pct: 10, km: 0.1 }, { pct: 20, km: 0.38 }, { pct: 30, km: 0.5 }, { pct: 40, km: 0.78 }, { pct: 50, km: 1 }, { pct: 60, km: 2.2 }, { pct: 70, km: 3.7 }, { pct: 80, km: 7.8 }, { pct: 90, km: 12 }, { pct: 100, km: 90 }] }] },
      scenarios: [
        'the missing person is likely to be found alive (79% of incidents)',
        'for incidents in urban areas the missing person is likely to be found in a building (11 out of 19 incidents)',
        'for incidents in other types of the terrain the missing person is likely to be found on a travel aid (41%)',
        'the missing person is likely to be found within 1 km of the IPP (50% of incidents)',
      ],
      notes: [
        'Fatality rate 21%, not significantly different from the other categories.',
        'Significantly different from all other categories on account of the high proportion not found (no trace); 9 of the 10 persons not found were male.',
        'Locations in urban areas were significantly different from other terrain; no significant gender difference.',
        'One "open ground" find: hiding in bushes.',
      ],
    },
    {
      slug: 'substance-related', name: 'Substance Related', n: 33, fatalityPct: 30, lowNumbers: false,
      terrainBySex: { table: 'Table 46', rows: [{ terrain: 'farmland', female: 3, male: 11, other: 0, total: 14 }, { terrain: 'urban', female: 0, male: 15, other: 2, total: 7 }, { terrain: 'other terrain types', female: 2, male: 9, other: 1, total: 12 }] },
      outcome: { table: 'Table 47', segments: [{ label: 'all searches', counts: { fatal: 10, injured: 3, 'no trace': 3, unhurt: 17 }, pct: { fatal: 30, injured: 9, 'no trace': 9, unhurt: 52 } }] },
      location: { table: 'Table 48', segments: [{ label: 'all searches', counts: { building: 14, 'open ground': 5, water: 5, 'travel aid': 3, trees: 2, 'linear feature': 1 }, pct: { building: 47, 'open ground': 17, water: 17, 'travel aid': 10, trees: 7, 'linear feature': 3 } }] },
      locationDetail: { table: 'Table 49', segments: [{ label: 'all searches', counts: { 'building / shelter': 2, habitation: 12, 'path / track': 0, road: 3, 'forest / woodland': 1, 'forest edge / clearing': 1, 'stream / ditch': 1, 'wall / fence line': 0 }, pct: { 'building / shelter': 7, habitation: 40, 'path / track': 0, road: 10, 'forest / woodland': 3, 'forest edge / clearing': 3, 'stream / ditch': 3, 'wall / fence line': 0 } }] },
      distance: { table: 'Table 50', segments: [
        { label: 'farmland', terrains: FARMLAND, points: [{ pct: 25, km: 0.8 }, { pct: 50, km: 5 }, { pct: 75, km: 9 }, { pct: 100, km: 45 }] },
        { label: 'other terrain types', terrains: ['Urban', ...NOT_FARM_URBAN], points: [{ pct: 25, km: 0.2 }, { pct: 50, km: 0.8 }, { pct: 75, km: 2 }, { pct: 100, km: 7.5 }] },
      ] },
      scenarios: [
        'the missing person is likely to be found alive (70% of incidents)',
        'the missing person is likely to be found in a building (47% of incidents)',
        'for incidents in farmland, the missing person is likely to be found further than 0.5 km from the IPP (83% of incidents)',
        'for incidents in other types of terrain, the missing person is likely to be found within 3 km of the IPP (83% of incidents)',
      ],
      notes: [
        'Fatality rate 30%, not significantly different from the other categories. No significant gender or terrain differences in location.',
        'Distances in farmland were significantly greater than in other terrain.',
        'The printed urban row of Table 46 (0 / 15 / 2 = 7) does not add up; kept as printed.',
      ],
    },
    {
      slug: 'walker-solo', name: 'Walker (solo)', n: 132, fatalityPct: 17, lowNumbers: false,
      terrainBySex: { table: 'Table A6', rows: [{ terrain: 'moorland', female: 11, male: 64, other: 3, total: 78 }, { terrain: 'crag / broken ground', female: 5, male: 30, other: 5, total: 40 }, { terrain: 'other', female: 3, male: 11, other: 0, total: 14 }] },
      outcome: { table: 'Table A7', segments: [{ label: 'all searches', counts: { fatal: 22, injured: 11, 'no trace': 2, unhurt: 97 }, pct: { fatal: 17, injured: 8, 'no trace': 2, unhurt: 73 } }] },
      location: { table: 'Table A8', segments: [
        { label: 'female', sex: 'Female', counts: { 'open ground': 4, 'travel aid': 7, building: 6, 'linear feature': 0, trees: 2, water: 0 } },
        { label: 'male', sex: 'Male', counts: { 'open ground': 47, 'travel aid': 23, building: 21, 'linear feature': 9, trees: 2, water: 1 }, pct: { 'open ground': 46, 'travel aid': 22, building: 20, 'linear feature': 8, trees: 2, water: 1 } },
      ] },
      locationDetail: { table: 'Table A9', segments: [
        { label: 'female', sex: 'Female', counts: { 'path / track': 3, road: 4, 'building / shelter': 3, habitation: 3, 'stream / ditch': 0, 'wall / fence line': 0, 'forest / woodland': 2, 'forest edge / clearing': 0 } },
        { label: 'male', sex: 'Male', counts: { 'path / track': 13, road: 10, 'building / shelter': 11, habitation: 10, 'stream / ditch': 4, 'wall / fence line': 5, 'forest / woodland': 1, 'forest edge / clearing': 1 }, pct: { 'path / track': 13, road: 10, 'building / shelter': 11, habitation: 10, 'stream / ditch': 4, 'wall / fence line': 5, 'forest / woodland': 1, 'forest edge / clearing': 1 } },
      ] },
      distance: { table: 'Table A10', segments: [
        { label: 'female', sex: 'Female', points: [{ pct: 25, km: 1 }, { pct: 50, km: 1.1 }, { pct: 75, km: 3 }, { pct: 100, km: 16 }] },
        { label: 'male', sex: 'Male', points: [{ pct: 10, km: 0.2 }, { pct: 20, km: 0.7 }, { pct: 30, km: 1.5 }, { pct: 40, km: 2.4 }, { pct: 50, km: 3 }, { pct: 60, km: 4.1 }, { pct: 70, km: 5 }, { pct: 80, km: 6.1 }, { pct: 90, km: 9.5 }, { pct: 100, km: 510 }] },
      ] },
      scenarios: [
        'a missing solo female walker is likely to be found unhurt (16 out of 19 incidents)',
        'a missing solo male walker is likely to be found unhurt (71%), but there is a 20% fatality rate for solo male walkers',
        'a missing solo female walker is likely to be found on a travel aid (7 out of 19 incidents) or in a building (6 out of 19 incidents)',
        'a missing solo male walker is likely to be found in open ground (46%), on a travel aid (22%) or in a building (20%)',
        '50% of solo female walkers are found within 1.1 km of the IPP',
        '50% of solo male walkers are found within 3 km of the IPP',
      ],
      notes: [
        '22 fatalities (17%), 21 of them male; despite that, no significant gender difference in outcome.',
        'Locations for male and female solo walkers differed enough to report separately, though not significantly.',
        'Significant gender difference in distance: males tended to be found further from the IPP. (Table A10 is mislabelled "Walkers (group)" in the source.)',
        '"Open ground" finds (27). Fatal (4): fallen from a ridge (2), on crags, on a scree slope. Non-fatal (23): went to ground / stayed put (6), sheltering in boulders (3), on the expected route (2), by a crossroads of footpaths, in a boggy area (2), on a summit ridge (3), cragfast, off route, on steep ground (2), on top of a rocky escarpment, at a campsite.',
      ],
    },
    {
      slug: 'walker-group', name: 'Walkers (group)', n: 95, fatalityPct: 2, lowNumbers: false,
      terrainBySex: { table: 'Table A1', rows: [{ terrain: 'moorland', female: 13, male: 33, mixed: 22, other: 9, total: 77 }, { terrain: 'crag / broken ground', female: 3, male: 4, mixed: 2, other: 2, total: 11 }, { terrain: 'other', female: 0, male: 5, mixed: 2, other: 0, total: 7 }] },
      outcome: { table: 'Table A2', segments: [
        { label: 'female', sex: 'Female', counts: { fatal: 0, injured: 3, 'no trace': 0, unhurt: 13 } },
        { label: 'male', sex: 'Male', counts: { fatal: 2, injured: 1, 'no trace': 0, unhurt: 39 }, pct: { fatal: 5, injured: 2, 'no trace': 0, unhurt: 93 } },
        { label: 'mixed group', sex: 'Mixed', counts: { fatal: 0, injured: 0, 'no trace': 0, unhurt: 26 }, pct: { fatal: 0, injured: 0, 'no trace': 0, unhurt: 100 } },
      ] },
      location: { table: 'Table A3', segments: [
        { label: 'female', sex: 'Female', counts: { 'open ground': 6, 'travel aid': 7, building: 0, trees: 0, 'linear feature': 2, water: 1 } },
        { label: 'male', sex: 'Male', counts: { 'open ground': 16, 'travel aid': 7, building: 11, trees: 5, 'linear feature': 1, water: 2 }, pct: { 'open ground': 38, 'travel aid': 17, building: 26, trees: 12, 'linear feature': 2, water: 5 } },
        { label: 'mixed group', sex: 'Mixed', counts: { 'open ground': 10, 'travel aid': 6, building: 7, trees: 1, 'linear feature': 2, water: 0 }, pct: { 'open ground': 38, 'travel aid': 23, building: 27, trees: 4, 'linear feature': 8, water: 0 } },
      ] },
      locationDetail: { table: 'Table A4', segments: [
        { label: 'female', sex: 'Female', counts: { 'path / track': 7, road: 0, 'building / shelter': 0, habitation: 0, 'forest / woodland': 0, 'forest edge / clearing': 0, 'stream / ditch': 1, 'wall / fence line': 1 } },
        { label: 'male', sex: 'Male', counts: { 'path / track': 5, road: 2, 'building / shelter': 5, habitation: 6, 'forest / woodland': 3, 'forest edge / clearing': 2, 'stream / ditch': 0, 'wall / fence line': 1 }, pct: { 'path / track': 12, road: 5, 'building / shelter': 12, habitation: 14, 'forest / woodland': 7, 'forest edge / clearing': 5, 'stream / ditch': 0, 'wall / fence line': 2 } },
        { label: 'mixed group', sex: 'Mixed', counts: { 'path / track': 4, road: 2, 'building / shelter': 5, habitation: 2, 'forest / woodland': 0, 'forest edge / clearing': 1, 'stream / ditch': 1, 'wall / fence line': 1 }, pct: { 'path / track': 15, road: 8, 'building / shelter': 19, habitation: 8, 'forest / woodland': 0, 'forest edge / clearing': 4, 'stream / ditch': 4, 'wall / fence line': 4 } },
      ] },
      distance: { table: 'Table A5', segments: [{ label: 'all searches', points: [{ pct: 10, km: 0.5 }, { pct: 20, km: 1.1 }, { pct: 30, km: 2 }, { pct: 40, km: 2.3 }, { pct: 50, km: 3 }, { pct: 60, km: 3.1 }, { pct: 70, km: 4.2 }, { pct: 80, km: 5 }, { pct: 90, km: 6.5 }, { pct: 100, km: 25 }] }] },
      scenarios: [
        'if the missing group consists entirely of females or is of mixed gender, they are likely to be found alive (both 100%) and unhurt (females in 10 out of 16 incidents, mixed gender group 100%)',
        'if the missing group consists entirely of males, they are likely to be found alive (95%)',
        'if the missing group consists entirely of males or is of mixed gender, they are likely to be found in open ground (both 38%) or in a building (26% males, 27% mixed gender); a mixed gender group (23%) is slightly more likely to be found on a travel aid than a group of males (17%)',
        'a group of females is likely to be found on a travel aid (7 out of 16 incidents) or in open ground (6 out of 16)',
        '50% of groups in this category are found within 3 km of the IPP; 80% are found within 5 km',
      ],
      notes: [
        'Two fatalities (2%), both male. Significant gender difference in outcome from the higher proportion (3 of 16) of injuries in female groups.',
        'Significant gender difference in location: females on a travel aid, males in a building.',
        'No significant gender difference in distance.',
        '"Open ground" finds (15): on intended route, found natural shelter, off planned route on a ridgeline, went to ground in tents, went to ground, at a cairn, by a small tarn, at a summit wall-shelter, in the area of the main path, open moorland, off footpath, found own way back to campsite, sheltering in peat-hags, on very steep ground.',
      ],
    },
    {
      slug: 'water-related', name: 'Water Related', n: 11, lowNumbers: false,
      terrainBySex: { table: 'Table 56', rows: [{ terrain: 'farmland', female: 1, male: 1, other: 0, total: 2 }, { terrain: 'water margin', female: 0, male: 8, other: 1, total: 9 }] },
      outcome: { table: 'Table 57', segments: [{ label: 'all searches', counts: { fatal: 9, injured: 1, 'no trace': 1, unhurt: 0 } }] },
      location: { table: 'Table 58', segments: [{ label: 'all searches', counts: { water: 9, 'linear feature': 1 } }] },
      locationDetail: { table: 'Table 59', segments: [{ label: 'all searches', counts: { 'stream / ditch': 1, 'wall / fence line': 0 } }] },
      distance: { table: 'Table 60', segments: [{ label: 'all searches', points: [{ pct: 25, km: 0.05 }, { pct: 50, km: 0.2 }, { pct: 75, km: 1.2 }, { pct: 100, km: 4.5 }] }] },
      scenarios: ['the missing person is likely to be found dead (9 out of 11 incidents)', 'the missing person is likely to be found in the water (9 out of 11 incidents)'],
      notes: ['Fatality rate 9 of 11, significantly higher than all the other categories.'],
    },
  ] as Category2011[],

  /** Despondents, Table 16 and section c(ii): characteristics drawn from the free text of reports. */
  despondent: {
    characteristics: {
      table: 'Table 16',
      rows: [
        { characteristic: 'suicide threatened', female: 41, male: 84, other: 5, total: 130 },
        { characteristic: 'stress or distress', female: 33, male: 74, other: 1, total: 108 },
        { characteristic: 'depression', female: 44, male: 51, other: 9, total: 104 },
        { characteristic: 'previous suicide attempts', female: 26, male: 34, other: 3, total: 63 },
      ],
    },
    /** Fatality rates for MALE despondents only (n=292); the female rate did not vary significantly with any characteristic. */
    maleFatalityPct: {
      source: 'section c(ii) and e',
      nMales: 292,
      suicideThreatened: 21,
      notThreatened: 39,
      notThreatenedWithHistory: 54,
      depression: 51,
      noDepression: 30,
      significantPlace: 62,
      significantPlaceNoThreat: 70,
      otherPlace: 29,
      stressNoDifference: true,
    },
  },
};

export type Ukmpbs2011 = typeof UKMPBS_2011;

export function category2011(slug: string | undefined | null): Category2011 | undefined {
  if (!slug) return undefined;
  return UKMPBS_2011.categories.find((c) => c.slug === slug);
}
