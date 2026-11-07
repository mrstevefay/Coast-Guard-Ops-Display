import { describe, expect, it } from 'vitest';
import { ISRID_ASD } from '../../shared/lpb/isridAsd.js';
import { DETAIL_GROUP_2011, UKMPBS_2011, category2011 } from '../../shared/lpb/ukmpbs2011.js';

const sum = (o: Partial<Record<string, number>>) => Object.values(o).reduce((a, b) => (a ?? 0) + (b ?? 0), 0) ?? 0;

/** Table 1 of the study. */
const TABLE_1: Record<string, number> = {
  'children-aged-1-16': 113, climber: 3, dementia: 194, despondent: 457, 'developmental-problem': 37, fellrunner: 7, 'health-related': 8, miscellaneous: 29,
  'mountain-biker': 6, 'other-vulnerable': 83, 'psychological-illness': 63, 'substance-related': 33, 'walker-solo': 132, 'walker-group': 95, 'water-related': 11,
};

/** Figures the study prints that do not add up; kept as printed, listed here so the checks skip them knowingly. */
const PRINTED_ANOMALIES = new Set([
  'substance-related terrain urban', // 0 + 15 + 2 printed as 7
  'despondent outcome total', // "all other terrain types" column sums to 77 not 79
  'dementia location others linear feature', // printed 21 % for 5 of 28
  'dementia location others trees', // printed 21 % for 7 of 28
]);

describe('UK Missing Person Behaviour Study 2011 transcription', () => {
  it('covers the 15 categories with the Table 1 counts, 1271 in all', () => {
    expect(UKMPBS_2011.categories).toHaveLength(15);
    for (const c of UKMPBS_2011.categories) expect(c.n, c.slug).toBe(TABLE_1[c.slug]);
    expect(UKMPBS_2011.categories.reduce((a, c) => a + c.n, 0)).toBe(1271);
    expect(UKMPBS_2011.source.n).toBe(1271);
  });

  it('terrain-by-sex rows add up to their totals and to n', () => {
    for (const c of UKMPBS_2011.categories) {
      if (!c.terrainBySex) continue;
      for (const r of c.terrainBySex.rows) {
        if (PRINTED_ANOMALIES.has(`${c.slug} terrain ${r.terrain}`)) continue;
        expect(r.female + r.male + r.other + (r.mixed ?? 0), `${c.slug} ${r.terrain}`).toBe(r.total);
      }
      if (c.slug !== 'substance-related') expect(c.terrainBySex.rows.reduce((a, r) => a + r.total, 0), c.slug).toBe(c.n);
    }
  });

  it('outcome segments cover the category and printed percentages match the counts', () => {
    for (const c of UKMPBS_2011.categories) {
      if (!c.outcome) continue;
      const total = c.outcome.segments.reduce((a, s) => a + sum(s.counts), 0);
      // walkers (group): the "other" column has no outcome split; despondent: one column is printed short.
      const expected = c.slug === 'walker-group' ? 95 - 11 : PRINTED_ANOMALIES.has(`${c.slug} outcome total`) ? c.n - 2 : c.n;
      expect(total, c.slug).toBe(expected);
      for (const s of c.outcome.segments) {
        if (!s.pct) continue;
        const n = s.n ?? sum(s.counts);
        for (const [k, p] of Object.entries(s.pct)) expect(Math.abs(((s.counts[k as keyof typeof s.counts] ?? 0) / n) * 100 - (p as number)), `${c.slug} ${s.label} ${k}`).toBeLessThan(1.6);
      }
    }
  });

  it('location percentages match the counts, and detail rows roll up into the grouped rows', () => {
    for (const c of UKMPBS_2011.categories) {
      if (!c.location) continue;
      for (const g of c.location.segments) {
        const n = g.n ?? sum(g.counts);
        if (g.pct) for (const [k, p] of Object.entries(g.pct)) {
          if (PRINTED_ANOMALIES.has(`${c.slug} location ${g.label} ${k}`)) continue;
          expect(Math.abs(((g.counts[k as keyof typeof g.counts] ?? 0) / n) * 100 - (p as number)), `${c.slug} ${g.label} ${k}`).toBeLessThan(1.6);
        }
        const d = c.locationDetail?.segments.find((s) => s.label === g.label);
        if (!d) continue;
        const rolled: Partial<Record<string, number>> = {};
        for (const [k, v] of Object.entries(d.counts)) {
          const grp = DETAIL_GROUP_2011[k as keyof typeof DETAIL_GROUP_2011];
          rolled[grp] = (rolled[grp] ?? 0) + (v ?? 0);
        }
        for (const [grp, v] of Object.entries(rolled)) if (g.counts[grp as keyof typeof g.counts] !== undefined) expect(g.counts[grp as keyof typeof g.counts], `${c.slug} ${g.label} ${grp}`).toBe(v);
        // detail percentages use the grouped segment's base
        if (d.pct) for (const [k, p] of Object.entries(d.pct)) expect(Math.abs(((d.counts[k as keyof typeof d.counts] ?? 0) / n) * 100 - (p as number)), `${c.slug} ${d.label} ${k}`).toBeLessThan(1.6);
      }
    }
  });

  it('distance tables are cumulative, increasing and end at 100 %', () => {
    for (const c of UKMPBS_2011.categories) {
      if (!c.distance) continue;
      for (const s of c.distance.segments) {
        expect(s.points[s.points.length - 1].pct, `${c.slug} ${s.label}`).toBe(100);
        for (let i = 1; i < s.points.length; i++) {
          expect(s.points[i].pct).toBeGreaterThan(s.points[i - 1].pct);
          expect(s.points[i].km, `${c.slug} ${s.label} ${s.points[i].pct}%`).toBeGreaterThanOrEqual(s.points[i - 1].km);
        }
      }
    }
    for (const c of UKMPBS_2011.categories) if (c.lowNumbers) expect(c.rawDistancesKm?.length, c.slug).toBeGreaterThan(0);
  });

  it('spot values read from the PDF', () => {
    const dem = category2011('dementia')!;
    expect(dem.distance!.segments.find((s) => s.label === 'urban')!.points.find((p) => p.pct === 50)!.km).toBe(1.7);
    expect(dem.location!.segments.find((s) => s.label === 'farmland female')!.pct!['travel aid']).toBe(42);
    const desp = category2011('despondent')!;
    expect(desp.outcome!.segments.find((s) => s.label === 'water margin')!.pct!.fatal).toBe(56);
    expect(UKMPBS_2011.despondent.maleFatalityPct).toMatchObject({ suicideThreatened: 21, notThreatened: 39, notThreatenedWithHistory: 54, depression: 51, noDepression: 30, significantPlace: 62, significantPlaceNoThreat: 70 });
    expect(UKMPBS_2011.despondent.characteristics.rows.find((r) => r.characteristic === 'suicide threatened')!.total).toBe(130);
    expect(category2011('walker-solo')!.distance!.segments.find((s) => s.label === 'male')!.points.find((p) => p.pct === 50)!.km).toBe(3);
    expect(category2011('water-related')!.distance!.segments[0].points).toEqual([{ pct: 25, km: 0.05 }, { pct: 50, km: 0.2 }, { pct: 75, km: 1.2 }, { pct: 100, km: 4.5 }]);
  });
});

describe('ISRID autism figures (Koester 2020)', () => {
  it('has both groups with quartiles in order', () => {
    expect(ISRID_ASD.groups.map((g) => g.id)).toEqual(['asd', 'td-child']);
    for (const g of ISRID_ASD.groups) {
      for (const eco of ['Temperate', 'Dry', 'Urban'] as const) {
        const d = g.distanceKm[eco];
        expect(d.p25).toBeLessThanOrEqual(d.p50);
        expect(d.p50).toBeLessThanOrEqual(d.p75);
        expect(d.p75).toBeLessThanOrEqual(d.p95);
        const loc = g.findLocationPct[eco];
        expect(Math.abs(sum(loc.pct) - 100), `${g.id} ${eco}`).toBeLessThanOrEqual(3);
      }
      expect(Math.abs(g.outcomePct.well + g.outcomePct.injured + g.outcomePct.dead + g.outcomePct.neverFound - 100)).toBeLessThan(1);
    }
    expect(ISRID_ASD.groups[0].distanceKm.Temperate).toEqual({ n: 233, p25: 0.4, p50: 0.9, p75: 2.3, p95: 8 });
    expect(ISRID_ASD.groups[0].survivalDays.p05).toBe(7);
  });
});
