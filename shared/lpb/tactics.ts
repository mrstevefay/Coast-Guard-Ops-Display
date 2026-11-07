/**
 * Reflex tasks the plan card suggests, each tied to the statistic that justifies it.
 * These are search-management prompts, not orders: the MISPER-UK immediate-response tactics
 * plus category tasks that follow from the 2011 study's tables. Wording is ours; the
 * evidence fields point at the source so the card can say why.
 */
import type { LpbTerrain } from './types.js';

export interface TacticEvidence {
  source: 'MISPER-UK' | 'UKMPBS_2011' | 'ISRID_ASD_2020';
  /** Table or page the figure comes from. */
  ref: string;
  /** The figure in words, e.g. "62% of males found at a significant place were dead". */
  stat: string;
}

export interface Tactic {
  id: string;
  task: string;
  evidence: TacticEvidence;
  /** Only for these categories (slugs); empty = all. */
  categories?: string[];
  /** Only when the subject's terrain is one of these; empty = any. */
  terrains?: LpbTerrain[];
  /** Only for this sex. */
  sex?: 'Male' | 'Female';
  /** Only when this subject flag is set. */
  requires?: 'suicideThreatened' | 'previousAttempts' | 'depression' | 'significantPlaceKnown';
  /** Only when the flag is NOT set. */
  requiresNot?: 'suicideThreatened';
  /** Higher first. */
  priority: 1 | 2 | 3;
}

/** First hour or two, usually actioned by Gardaí / police before teams arrive. */
export const IMMEDIATE_TACTICS: Tactic[] = [
  { id: 'imm-buildings', priority: 1, task: 'Search any buildings the person may be in: their home and outbuildings, houses of family and friends, care homes, hospitals, schools, pubs, places they go.', evidence: { source: 'MISPER-UK', ref: 'Immediate Response', stat: 'about two thirds of those found alive are in a building or on a travel aid' } },
  { id: 'imm-roads', priority: 1, task: 'Drive every road and track leading away from the place last seen that they could have followed; check bus stops, car parks and the harbour.', evidence: { source: 'MISPER-UK', ref: 'Immediate Response', stat: '32% found within 500 m and 49% within 1 km of the planning point, all categories' } },
  { id: 'imm-confirm', priority: 1, task: 'Confirm the planning point: last known position, who saw them, when, and which way they were facing or heading.', evidence: { source: 'UKMPBS_2011', ref: 'Despondents g', stat: "'lines and points': the routes are only right if the start point is" } },
];

export const CATEGORY_TACTICS: Tactic[] = [
  // Despondent
  { id: 'desp-significant', priority: 1, categories: ['despondent'], task: 'Go first to any place significant to them: a beauty spot or viewpoint, somewhere with memories, a regular walk. Send a team, not a drive-by.', evidence: { source: 'UKMPBS_2011', ref: 'Despondents e', stat: '15% of females and 14% of males were found at a significant place; 62% of males found there were dead (70% if no threat was made)' } },
  { id: 'desp-water', priority: 1, categories: ['despondent'], terrains: ['Water Margin', 'Urban'], task: 'Task the water margin early: shoreline, pier, slipways, bridges, outfalls. Brief teams that the person may be in the water.', evidence: { source: 'UKMPBS_2011', ref: 'Table 17/18', stat: 'water margin: 56% fatal, 55% found in the water; urban: 20% found in water' } },
  { id: 'desp-woods', priority: 1, categories: ['despondent'], terrains: ['Plantation (dense)', 'Woodland / Parkland'], task: 'Search the interior of woodland and plantation, not just the paths: use close line search in cover.', evidence: { source: 'UKMPBS_2011', ref: 'Table 18/19', stat: '64% found among trees in woodland or plantation, 49% in the forest itself' } },
  { id: 'desp-farm-buildings', priority: 2, categories: ['despondent'], terrains: ['Farmland'], task: 'Check farm buildings, barns, sheds and outbuildings as well as houses.', evidence: { source: 'UKMPBS_2011', ref: 'Table 19', stat: 'farmland: 42% of males found in a building, 23% in a building or shelter rather than a dwelling' } },
  { id: 'desp-urban-habitation', priority: 2, categories: ['despondent'], terrains: ['Urban'], task: 'Clear habitation first: their own home, friends and family, hostels, hotels.', evidence: { source: 'UKMPBS_2011', ref: 'Table 19', stat: 'urban: 48% found in a building, 34% in habitation' } },
  { id: 'desp-no-threat', priority: 2, categories: ['despondent'], sex: 'Male', requiresNot: 'suicideThreatened', requires: 'previousAttempts', task: 'Treat as high risk: no threat made but a history of attempts or threats. Prioritise significant places and water.', evidence: { source: 'UKMPBS_2011', ref: 'Despondents c(ii)', stat: 'male fatality rate 54% with history but no threat, against 39% with no threat and no history' } },
  { id: 'desp-depression', priority: 2, categories: ['despondent'], sex: 'Male', requires: 'depression', task: 'Depression reported: plan for a fatality search as well as a live find; brief teams on what to do on finding.', evidence: { source: 'UKMPBS_2011', ref: 'Despondents c(ii)', stat: 'male fatality rate 51% with depression, 30% without' } },
  { id: 'desp-close', priority: 2, categories: ['despondent'], task: 'Search close in hard before expanding: cover the first 500 m thoroughly, including cover and structures right at the planning point.', evidence: { source: 'MISPER-UK', ref: 'Despondent distance', stat: '36% of despondents found within 0.5 km (25% for other categories); half within 0.3 km on current data' } },
  // Dementia
  { id: 'dem-travel-aid', priority: 1, categories: ['dementia'], task: 'Walk and drive every road, track and path leading away from the planning point; they tend to keep going along whatever they are on.', evidence: { source: 'UKMPBS_2011', ref: 'Table 12', stat: 'found on a travel aid: 36% urban, 42% farmland females, 29% farmland males' } },
  { id: 'dem-linear', priority: 1, categories: ['dementia'], terrains: ['Farmland', 'Moorland / Upland', 'Crag / Broken Ground', 'Woodland / Parkland', 'Not Specified'], task: 'Walk the field boundaries, walls, fences, ditches and streams: they stop where a barrier stops them.', evidence: { source: 'UKMPBS_2011', ref: 'Table 12/13', stat: 'farmland males: 29% at a linear feature, equally stream/ditch and wall/fence' } },
  { id: 'dem-cover', priority: 2, categories: ['dementia'], task: 'Look into dense undergrowth, bushes, nettles and under hedges within the first kilometre; they go to ground and do not call out.', evidence: { source: 'UKMPBS_2011', ref: 'Dementia e', stat: '"open ground" finds: hit a natural barrier and sat down, stuck in undergrowth, in thick bushes, in nettles' } },
  { id: 'dem-buildings', priority: 2, categories: ['dementia'], terrains: ['Urban'], task: 'Check buildings they know from earlier in life: old home, old workplace, church, shops, the bus route they used to take.', evidence: { source: 'UKMPBS_2011', ref: 'Table 13', stat: 'urban: 30% found in a building, 21% in habitation' } },
  { id: 'dem-injury', priority: 2, categories: ['dementia'], task: 'Bring casualty care forward: expect injury or hypothermia on finding.', evidence: { source: 'MISPER-UK', ref: 'Dementia outcome', stat: 'significantly more found injured than any other category (20% on current data)' } },
  // Children
  { id: 'child-buildings', priority: 1, categories: ['children-aged-1-16'], task: 'Search every building at and around the planning point first, including sheds, garages and outbuildings; then friends\' houses.', evidence: { source: 'UKMPBS_2011', ref: 'Table 7/8', stat: 'found in a building: 71% urban (51% habitation), 52% farmland' } },
  { id: 'child-roads', priority: 2, categories: ['children-aged-1-16'], terrains: ['Crag / Broken Ground', 'Moorland / Upland', 'Plantation (dense)', 'Water Margin', 'Woodland / Parkland', 'Not Specified'], task: 'Outside towns and farmland, cover roads before paths: a child on a travel aid is twice as likely to be on a road.', evidence: { source: 'UKMPBS_2011', ref: 'Table 8', stat: 'other terrain: 33% on a travel aid, road 21% vs path 12%' } },
  { id: 'child-hiding', priority: 2, categories: ['children-aged-1-16'], task: 'Brief teams that a child may hide from searchers or not answer: look under bushes, in dens, in vehicles.', evidence: { source: 'UKMPBS_2011', ref: 'Children e', stat: 'one "open ground" find was sheltering under bushes' } },
  // Developmental / other vulnerable (autism lives here)
  { id: 'dev-structures', priority: 1, categories: ['developmental-problem', 'other-vulnerable'], task: 'Search structures first: any building, shed, vehicle or shelter in the first kilometre, including locked or odd spaces.', evidence: { source: 'ISRID_ASD_2020', ref: 'Table 7', stat: 'ASD subjects found in a structure 78% of the time (temperate)' } },
  { id: 'dev-water', priority: 1, categories: ['developmental-problem', 'other-vulnerable'], task: 'Check water early: ponds, streams, the shoreline and the harbour. Attraction to water is a known ASD risk.', evidence: { source: 'ISRID_ASD_2020', ref: 'Table 8', stat: 'drowning was the cause in 2.8% of ASD incidents, five times the rate for other children' } },
  { id: 'dev-evading', priority: 2, categories: ['developmental-problem', 'other-vulnerable'], task: 'Assume they may evade or not respond to calls: use quiet, close search and people they know; avoid sirens and shouting near the find.', evidence: { source: 'ISRID_ASD_2020', ref: 'Table 8', stat: '17% of ASD incidents were evading, against 5.6% for other children' } },
  { id: 'dev-buildings-uk', priority: 2, categories: ['developmental-problem'], terrains: ['Urban'], task: 'In town, clear habitation and buildings before anything else.', evidence: { source: 'UKMPBS_2011', ref: 'Table 23', stat: 'urban: found in a building 7 of 12 times' } },
  // Psychological illness
  { id: 'psych-paths', priority: 1, categories: ['psychological-illness'], terrains: ['Crag / Broken Ground', 'Farmland', 'Moorland / Upland', 'Plantation (dense)', 'Water Margin', 'Woodland / Parkland', 'Not Specified'], task: 'Outside town, task the paths and roads first.', evidence: { source: 'UKMPBS_2011', ref: 'Table 43/44', stat: 'rural: 41% on a travel aid, split evenly between path and road' } },
  { id: 'psych-buildings', priority: 1, categories: ['psychological-illness'], terrains: ['Urban'], task: 'In town, clear habitation: home, relatives, the unit or ward they attend.', evidence: { source: 'UKMPBS_2011', ref: 'Table 43', stat: 'urban: found in a building 11 of 19 times' } },
  { id: 'psych-no-trace', priority: 2, categories: ['psychological-illness'], task: 'Plan for a long search: this category has the highest not-found rate. Widen enquiries (transport, bank cards, phone) in parallel with the ground search.', evidence: { source: 'UKMPBS_2011', ref: 'Table 42', stat: '16% no trace, 9 of the 10 male' } },
  // Substance related
  { id: 'subst-buildings', priority: 1, categories: ['substance-related'], task: 'Check habitation and buildings first: home, friends, places they drink or use.', evidence: { source: 'UKMPBS_2011', ref: 'Table 48/49', stat: '47% found in a building, 40% in habitation' } },
  { id: 'subst-farmland', priority: 2, categories: ['substance-related'], terrains: ['Farmland'], task: 'In farmland, do not assume they are close: extend the search area and the road checks early.', evidence: { source: 'UKMPBS_2011', ref: 'Table 50', stat: 'farmland: 83% found further than 0.5 km, median 5 km' } },
  { id: 'subst-water', priority: 2, categories: ['substance-related'], task: 'Check water and open ground near the route home.', evidence: { source: 'UKMPBS_2011', ref: 'Table 48', stat: '17% found in water, 17% in open ground' } },
  // Walkers
  { id: 'walk-route', priority: 1, categories: ['walker-solo', 'walker-group'], task: 'Search the intended route and its obvious wrong turns first; most are on or near it, stopped by weather, injury or dark.', evidence: { source: 'UKMPBS_2011', ref: 'Walker (solo) e', stat: 'open ground finds: went to ground or stayed put (6), on the expected route, on a summit ridge, sheltering in boulders' } },
  { id: 'walk-open', priority: 1, categories: ['walker-solo'], sex: 'Male', task: 'Male solo walker: open ground, crag bases and scree below ridges, then shelters and paths. Expect a longer travel distance.', evidence: { source: 'UKMPBS_2011', ref: 'Table A8/A10', stat: 'males: 46% open ground; 50% beyond 3 km; fatal finds had fallen from a ridge or were on crags or scree' } },
  { id: 'walk-female', priority: 1, categories: ['walker-solo'], sex: 'Female', task: 'Female solo walker: paths and roads first, then buildings and shelters; most are within about a kilometre.', evidence: { source: 'UKMPBS_2011', ref: 'Table A8/A10', stat: 'females: 7 of 19 on a travel aid, 6 of 19 in a building; 50% within 1.1 km' } },
  { id: 'walk-shelter', priority: 2, categories: ['walker-solo', 'walker-group'], task: 'Check shelters, bothies, summit wall-shelters, boulder fields and tents: groups go to ground.', evidence: { source: 'UKMPBS_2011', ref: 'Walkers (group) e', stat: 'open ground finds: found natural shelter, went to ground in tents, at a summit wall-shelter, sheltering in peat-hags' } },
  { id: 'walk-group-open', priority: 2, categories: ['walker-group'], task: 'Groups are found in open ground or a building; put teams on the ridge lines and the valley buildings.', evidence: { source: 'UKMPBS_2011', ref: 'Table A3', stat: 'male and mixed groups: 38% open ground, 26–27% building; 80% within 5 km' } },
  // Water related
  { id: 'water-margin', priority: 1, categories: ['water-related'], task: 'Search the water and the margin from the entry point downstream or downtide; request boat and drone cover. Expect a recovery.', evidence: { source: 'MISPER-UK', ref: 'Water Related', stat: '61% found in the water, 63% fatal; 80% within 700 m of the planning point' } },
  // Low-numbers activity categories
  { id: 'act-route', priority: 1, categories: ['climber', 'fellrunner', 'mountain-biker'], task: 'Search the route, the descent lines and the crag base; then roads out.', evidence: { source: 'MISPER-UK', ref: 'category pages', stat: 'small categories (n=7–55): found on open ground or a travel aid in most cases' } },
  // Health related / misc
  { id: 'health-buildings', priority: 1, categories: ['health-related', 'miscellaneous'], task: 'Check buildings and roads first; collapse or confusion keeps people close to where they were going.', evidence: { source: 'UKMPBS_2011', ref: 'Table 28', stat: 'miscellaneous: 38% building, 27% travel aid' } },
];

/** Tactics that apply to this subject, immediate block first then category tasks by priority. */
export function tacticsFor(input: { category: string; terrain?: string; sex?: string; suicideThreatened?: boolean; previousAttempts?: boolean; depression?: boolean; significantPlaceKnown?: boolean }): { immediate: Tactic[]; category: Tactic[] } {
  const flag = (k: NonNullable<Tactic['requires']>) => Boolean(input[k]);
  const ok = (t: Tactic) =>
    (!t.categories || t.categories.includes(input.category)) &&
    (!t.terrains || !input.terrain || t.terrains.includes(input.terrain as LpbTerrain)) &&
    (!t.sex || !input.sex || t.sex === input.sex) &&
    (!t.requires || flag(t.requires)) &&
    (!t.requiresNot || !flag(t.requiresNot));
  return { immediate: IMMEDIATE_TACTICS, category: CATEGORY_TACTICS.filter(ok).sort((a, b) => a.priority - b.priority) };
}
