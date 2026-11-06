import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LPB, LPB_LOCATIONS, LPB_OUTCOMES, LPB_TERRAINS, locationShares, outcomeShares, profileBySlug, ringRadiiKm, suggestProfile, terrainsWithData } from '../../shared/lpb/index.js';
import { testApp } from './helpers/app.js';

const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);

describe('MISPER-UK lost person behaviour dataset', () => {
  it('has the 15 categories and 5406 incidents', () => {
    expect(LPB.profiles).toHaveLength(15);
    expect(LPB.profiles.reduce((a, p) => a + p.n, 0)).toBe(5406);
    expect(new Set(LPB.profiles.map((p) => p.slug)).size).toBe(15);
    expect(LPB.source.attribution).toMatch(/Centre for Search Research/);
  });

  it('reconciles every profile: outcomes, all-terrain locations and per-terrain locations all equal n', () => {
    for (const p of LPB.profiles) {
      expect(sum(p.outcome), p.slug).toBe(p.n);
      expect(sum(p.locations.all), p.slug).toBe(p.n);
      const byTerrain = Object.values(p.locations.byTerrain).reduce((a, t) => a + sum(t!), 0);
      expect(byTerrain, p.slug).toBe(p.n);
      for (const t of Object.keys(p.locations.byTerrain)) expect(LPB_TERRAINS).toContain(t);
      for (const o of Object.keys(p.outcome)) expect(LPB_OUTCOMES).toContain(o);
      for (const l of Object.keys(p.locations.all)) expect(LPB_LOCATIONS).toContain(l);
      expect(p.definition.length, p.slug).toBeGreaterThan(20);
      expect(p.sourceUrl).toBe(`https://misper.uk/initial-response/${p.slug}/`);
    }
  });

  it('distance tables are cumulative, cover the deciles and never decrease', () => {
    for (const p of LPB.profiles) {
      const pcts = p.distanceKm.map((d) => d.pct);
      for (const d of [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]) expect(pcts, p.slug).toContain(d);
      for (let i = 1; i < p.distanceKm.length; i++) {
        expect(p.distanceKm[i].pct, p.slug).toBeGreaterThanOrEqual(p.distanceKm[i - 1].pct);
        expect(p.distanceKm[i].km, p.slug).toBeGreaterThanOrEqual(p.distanceKm[i - 1].km);
      }
    }
  });

  it('matches spot values read from the site', () => {
    const dementia = profileBySlug('dementia')!;
    expect(dementia.n).toBe(512);
    expect(dementia.outcome).toEqual({ None: 273, 'Minor Injury': 80, 'Serious Injury': 23, Fatality: 61, Unknown: 75 });
    expect(dementia.locations.byTerrain.Urban).toEqual({ Habitation: 77, 'Travel Aid': 73, 'Linear Feature': 21, 'Open Ground': 22, Trees: 2, Water: 8, 'Not Found': 33 });
    const despondent = profileBySlug('despondent')!;
    expect(despondent.n).toBe(1731);
    expect(despondent.distanceKm.find((d) => d.pct === 90)?.km).toBe(5.5);
    expect(profileBySlug('water-related')!.outcome.Fatality).toBe(29);
    expect(profileBySlug('climber')!.lowNumbersCaution).toBe(true);
    expect(LPB.immediate).toMatchObject({ foundAlivePct: 73, fatalityPct: 21, noTracePct: 6, within500mPct: 32, within1kmPct: 49 });
    expect(LPB.immediate.tactics).toHaveLength(2);
  });
});

describe('lost person behaviour helpers', () => {
  it('ring radii are the 50/70/90 % distances, skipping zero and duplicates', () => {
    expect(ringRadiiKm(profileBySlug('dementia'))).toEqual([{ pct: 50, km: 1 }, { pct: 70, km: 2 }, { pct: 90, km: 8 }]);
    expect(ringRadiiKm(profileBySlug('despondent'))).toEqual([{ pct: 50, km: 0.3 }, { pct: 70, km: 1 }, { pct: 90, km: 5.5 }]);
    // walker-group: 50 % is 0 km, so only two rings
    expect(ringRadiiKm(profileBySlug('walker-group'))).toEqual([{ pct: 70, km: 1.1 }, { pct: 90, km: 4 }]);
    expect(ringRadiiKm(undefined)).toEqual([]);
  });

  it('location and outcome shares sum to ~100 and sort by count', () => {
    const all = locationShares(profileBySlug('dementia')!);
    expect(all[0]).toEqual({ key: 'Travel Aid', n: 127, pct: 24.8 });
    expect(Math.round(all.reduce((a, s) => a + s.pct, 0))).toBe(100);
    const urban = locationShares(profileBySlug('dementia')!, 'Urban');
    expect(urban[0].key).toBe('Habitation');
    expect(urban.reduce((a, s) => a + s.n, 0)).toBe(236);
    expect(locationShares(profileBySlug('climber')!, 'Urban')).toEqual([]); // no climbers in urban terrain
    expect(outcomeShares(profileBySlug('water-related')!)[0]).toEqual({ key: 'Fatality', n: 29, pct: 63 });
    expect(terrainsWithData(profileBySlug('climber')!)).toEqual(['Crag / Broken Ground', 'Moorland / Upland']);
  });

  it('suggests a category from the subject flags and age', () => {
    expect(suggestProfile({ age: 67, despondent: true, mentalHealth: true })).toBe('despondent');
    expect(suggestProfile({ age: 9 })).toBe('children-aged-1-16');
    expect(suggestProfile({ age: 40, mentalHealth: true })).toBe('psychological-illness');
    expect(suggestProfile({ age: 40 })).toBeUndefined();
    expect(suggestProfile({})).toBeUndefined();
  });
});

describe('subject category and terrain over the API', () => {
  let t: Awaited<ReturnType<typeof testApp>>;
  let manager: string;
  let id: string;
  const json = (r: { body: string }) => JSON.parse(r.body);
  beforeAll(async () => {
    t = await testApp();
    manager = await t.login('manager');
    id = json(await t.app.inject({ method: 'POST', url: '/api/incidents', headers: { cookie: manager }, payload: { text: 'LPB test' } })).incident.id;
  });
  afterAll(async () => t.close());

  it('stores a valid category and terrain, clears them, and rejects unknown values', async () => {
    const ok = await t.app.inject({ method: 'PUT', url: `/api/incidents/${id}/subject`, headers: { cookie: manager }, payload: { name: 'A', category: 'dementia', terrain: 'Urban' } });
    expect(ok.statusCode).toBe(200);
    expect(json(ok).subject).toMatchObject({ category: 'dementia', terrain: 'Urban' });
    expect((await t.app.inject({ method: 'PUT', url: `/api/incidents/${id}/subject`, headers: { cookie: manager }, payload: { category: 'alien' } })).statusCode).toBe(400);
    expect((await t.app.inject({ method: 'PUT', url: `/api/incidents/${id}/subject`, headers: { cookie: manager }, payload: { terrain: 'Moon' } })).statusCode).toBe(400);
    // unchanged after the rejected writes
    expect(json(await t.app.inject({ method: 'GET', url: `/api/incidents/${id}/subject`, headers: { cookie: manager } })).subject).toMatchObject({ category: 'dementia', terrain: 'Urban' });
    const cleared = json(await t.app.inject({ method: 'PUT', url: `/api/incidents/${id}/subject`, headers: { cookie: manager }, payload: { category: '', terrain: '' } })).subject;
    expect(cleared.category).toBeUndefined();
    expect(cleared.terrain).toBeUndefined();
  });

  it('the report names the behaviour profile', async () => {
    await t.app.inject({ method: 'PUT', url: `/api/incidents/${id}/subject`, headers: { cookie: manager }, payload: { category: 'despondent', terrain: 'Water Margin' } });
    const html = (await t.app.inject({ method: 'GET', url: `/api/incidents/${id}/report.html`, headers: { cookie: manager } })).body;
    expect(html).toContain('Behaviour profile:</b> Despondent (MISPER-UK, n=1731), terrain Water Margin');
    expect(html).toContain('0.3 km (50 %), 1 km (70 %), 5.5 km (90 %)');
  });
});
