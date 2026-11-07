import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildPlan, interpolateKm, matchSegment, planRings, profileBySlug } from '../../shared/lpb/index.js';
import { category2011 } from '../../shared/lpb/ukmpbs2011.js';
import { testApp } from './helpers/app.js';

describe('plan engine: rings and interpolation', () => {
  it('interpolates between cumulative points and flags it', () => {
    const pts = [{ pct: 20, km: 0 }, { pct: 30, km: 0 }, { pct: 40, km: 0.5 }, { pct: 50, km: 1 }, { pct: 70, km: 2 }, { pct: 80, km: 3.5 }, { pct: 90, km: 8 }];
    expect(interpolateKm(pts, 50)).toEqual({ km: 1, interpolated: false });
    expect(interpolateKm(pts, 25)).toEqual({ km: 0, interpolated: true });
    expect(interpolateKm(pts, 75)).toEqual({ km: 2.75, interpolated: true });
    expect(interpolateKm(pts, 95)).toBeUndefined();
  });

  it('dementia rings: 25 % is interpolated, 50/90 are source deciles, nothing at 0 km', () => {
    expect(planRings(profileBySlug('dementia')!)).toEqual([{ pct: 50, km: 1, interpolated: false }, { pct: 75, km: 2.75, interpolated: true }, { pct: 90, km: 8, interpolated: false }]);
    // despondent: 25 % and 40 % sit at 0 km, so only 50/75/90 draw
    expect(planRings(profileBySlug('despondent')!).map((r) => r.pct)).toEqual([50, 75, 90]);
    expect(planRings(profileBySlug('despondent')!)[1]).toEqual({ pct: 75, km: 1.5, interpolated: true });
  });
});

describe('plan engine: 2011 segment matching', () => {
  const desp = category2011('despondent')!;
  it('prefers terrain+sex, then terrain, then the whole category', () => {
    expect(matchSegment(desp.outcome!.segments, 'Farmland', 'Male')).toMatchObject({ level: 'category+terrain+sex', segment: { label: 'farmland male' } });
    expect(matchSegment(desp.outcome!.segments, 'Farmland', undefined)).toBeUndefined(); // farmland is only split by sex in Table 17
    expect(matchSegment(desp.outcome!.segments, 'Water Margin', 'Female')).toMatchObject({ level: 'category+terrain', segment: { label: 'water margin' } });
    expect(matchSegment(desp.distance!.segments, 'Urban', 'Male')).toMatchObject({ level: 'category', segment: { label: 'all searches' } });
    const solo = category2011('walker-solo')!;
    expect(matchSegment(solo.distance!.segments, 'Moorland / Upland', 'Female')).toMatchObject({ level: 'category+sex', segment: { label: 'female' } });
  });
});

describe('plan engine: buildPlan', () => {
  it('despondent male, farmland, depression: segment outcome, modifiers, tactics, warnings', () => {
    const p = buildPlan({ category: 'despondent', terrain: 'Farmland', sex: 'Male', age: 45, depression: true, significantPlaceKnown: true }, { daylight: false, tempC: 5 })!;
    expect(p.condition.segment).toMatchObject({ basis: { source: 'UKMPBS_2011', ref: 'Table 17 farmland male', n: 75, level: 'category+terrain+sex' }, pct: { fatal: 31 } });
    expect(p.condition.modifiers!.lines.map((l) => l.pct)).toEqual([39, 51, 70]);
    expect(p.rings.items.map((r) => r.km)).toEqual([0.3, 1.5, 5.5]);
    expect(p.rings.zeroSharePct).toBe(40);
    expect(p.warnings.some((w) => w.includes('40 %'))).toBe(true);
    expect(p.warnings.some((w) => w.startsWith('Dark'))).toBe(true);
    expect(p.warnings.some((w) => w.includes('hypothermia'))).toBe(true);
    expect(p.studyLocations).toMatchObject({ basis: { ref: 'Table 18 farmland male', n: 67 } });
    expect(p.studyLocations!.detail[0]).toMatchObject({ key: 'building / shelter', group: 'building', n: 15, pct: 23 });
    expect(p.locations.basis.tag).toBe('LIVE n=423');
    expect(p.tactics.category.map((t) => t.id)).toContain('desp-significant');
    expect(p.tactics.category.map((t) => t.id)).toContain('desp-depression');
    expect(p.tactics.category.map((t) => t.id)).not.toContain('desp-water'); // farmland, not water margin
    expect(p.scenarios.items.length).toBeGreaterThan(0);
    expect(p.isrid).toBeUndefined();
  });

  it('dementia, urban, 78: 2011 urban deciles beside live rings', () => {
    const p = buildPlan({ category: 'dementia', terrain: 'Urban', sex: 'Male', age: 78 })!;
    expect(p.studyDistance).toMatchObject({ basis: { ref: 'Table 14 urban', level: 'category+terrain' }, stepPct: 10 });
    expect(p.studyDistance!.points.find((x) => x.pct === 50)!.km).toBe(1.7);
    expect(p.rings.items.map((r) => r.km)).toEqual([1, 2.75, 8]);
    expect(p.condition.segment).toMatchObject({ basis: { ref: 'Table 11 all searches', level: 'category', n: 194 }, pct: { fatal: 18 } }); // whole-category 2011 figure, shown for comparison
    expect(p.condition.alivePct).toBeCloseTo(73.4, 0);
    expect(p.locations.basis.tag).toBe('LIVE n=236');
    expect(p.studyLocations!.basis.ref).toBe('Table 12 urban');
  });

  it('climber: low numbers warning, raw distances, category-level basis', () => {
    const p = buildPlan({ category: 'climber', terrain: 'Urban' })!;
    expect(p.warnings.some((w) => w.includes('Small category'))).toBe(true);
    expect(p.warnings.some((w) => w.includes('No Urban cases'))).toBe(true);
    expect(p.rawDistancesKm!.km).toEqual([0.8, 2, 27]);
    expect(p.locations.basis.level).toBe('category');
  });

  it('developmental problem, age 10: ISRID autism block, temperate unless urban', () => {
    const p = buildPlan({ category: 'developmental-problem', terrain: 'Farmland', age: 10 })!;
    expect(p.isrid!.group.id).toBe('asd');
    expect(p.isrid!.ecoregion).toBe('Temperate');
    expect(p.isrid!.rings.map((r) => r.km)).toEqual([0.4, 0.9, 2.3, 8]);
    expect(p.isrid!.findLocation[0]).toEqual({ key: 'Structure', pct: 78 });
    expect(buildPlan({ category: 'developmental-problem', terrain: 'Urban' })!.isrid!.ecoregion).toBe('Urban');
    expect(buildPlan({ category: 'children-aged-1-16' })!.isrid!.group.id).toBe('td-child');
    expect(p.tactics.category.map((t) => t.id)).toContain('dev-water');
  });

  it('unknown category returns nothing', () => {
    expect(buildPlan({ category: 'alien' })).toBeUndefined();
  });
});

describe('subject characteristics over the API', () => {
  let t: Awaited<ReturnType<typeof testApp>>;
  let manager: string;
  let id: string;
  const json = (r: { body: string }) => JSON.parse(r.body);
  beforeAll(async () => {
    t = await testApp();
    manager = await t.login('manager');
    id = json(await t.app.inject({ method: 'POST', url: '/api/incidents', headers: { cookie: manager }, payload: { text: 'plan test' } })).incident.id;
  });
  afterAll(async () => t.close());

  it('stores the despondent flags and defaults them false', async () => {
    const first = json(await t.app.inject({ method: 'PUT', url: `/api/incidents/${id}/subject`, headers: { cookie: manager }, payload: { name: 'B', category: 'despondent' } })).subject;
    expect(first).toMatchObject({ suicideThreatened: false, depression: false, significantPlaceKnown: false });
    const second = json(await t.app.inject({ method: 'PUT', url: `/api/incidents/${id}/subject`, headers: { cookie: manager }, payload: { suicideThreatened: true, depression: true, significantPlaceKnown: true } })).subject;
    expect(second).toMatchObject({ name: 'B', category: 'despondent', suicideThreatened: true, depression: true, significantPlaceKnown: true });
  });
});
