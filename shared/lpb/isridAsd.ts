/**
 * ISRID figures for subjects with Autism Spectrum Disorder (ASD) and for typically
 * developing (TD) children, from the one open-access ISRID paper:
 *
 *   Koester, R. J. (2020). Enhancements to Statistical Probability of Area Models based upon
 *   updated ISRID data collection for Autistic Spectrum Disorders and Typically Developing
 *   Children. Journal of Search & Rescue, 4(1), 65–80.
 *   https://journalofsar.com/wp-content/uploads/2020/04/v4-8-Koester-ASD-vTD.pdf.pdf
 *
 * Used because the UK data has no autism category and no mobility, track-offset or
 * survival-over-time figures. International data (ISRID2, 145,000 incidents); the paper found
 * no statistical difference between ASD children (2–16) and ASD adults (17–75), so one ASD
 * profile serves both. Ireland is the "temperate" ecoregion. The rest of ISRID (Koester,
 * Lost Person Behavior, 2008) is not reproduced: it is not openly licensed.
 */

export type IsridEcoregion = 'Temperate' | 'Dry' | 'Urban';

export interface IsridQuartiles {
  n: number;
  /** Values at 25 / 50 / 75 / 95 %. */
  p25: number;
  p50: number;
  p75: number;
  p95: number;
}

export interface IsridGroup {
  id: 'asd' | 'td-child';
  name: string;
  ages: string;
  /** Horizontal distance from the IPP, km, by ecoregion (Table 3). */
  distanceKm: Record<IsridEcoregion, IsridQuartiles>;
  /** Distance from the nearest linear feature when found, metres (Table 3). */
  trackOffsetM: IsridQuartiles;
  /** Time mobile, hours (Table 3). */
  mobilityHours: IsridQuartiles;
  /** Where found, % by ecoregion (Table 7). */
  findLocationPct: Record<IsridEcoregion, { n: number; pct: Record<string, number> }>;
  /** Outcome, % (Table 2). */
  outcomePct: { n: number; well: number; injured: number; dead: number; neverFound: number };
  /** Days since last seen at which the chance of being found alive has fallen to 75 / 50 / 25 / 5 % (Table 9). */
  survivalDays: { n: number; p75: number; p50: number; p25: number; p05: number };
  /** Elevation change from IPP to find, % (Table 6). */
  elevationPct?: { n: number; uphill: number; downhill: number; same: number };
  notes: string[];
}

export const ISRID_ASD = {
  source: {
    id: 'ISRID_ASD_2020',
    citation: 'Koester RJ. Enhancements to Statistical Probability of Area Models based upon updated ISRID data collection for Autistic Spectrum Disorders and Typically Developing Children. Journal of Search & Rescue 2020; 4(1): 65–80.',
    url: 'https://journalofsar.com/wp-content/uploads/2020/04/v4-8-Koester-ASD-vTD.pdf.pdf',
    database: 'ISRID2 (International Search & Rescue Incident Database), 145,000 incidents; ASD n=380, TD children n=2335',
    region: 'International, mostly North America; Ireland corresponds to the temperate ecoregion.',
    attribution: 'ISRID figures from Koester (2020), Journal of Search & Rescue, used with attribution.',
  },
  groups: [
    {
      id: 'asd', name: 'Autism spectrum disorder (ISRID)', ages: 'children 2–16 and adults 17–75 (no significant difference)',
      distanceKm: {
        Temperate: { n: 233, p25: 0.4, p50: 0.9, p75: 2.3, p95: 8 },
        Dry: { n: 10, p25: 0.7, p50: 1.4, p75: 3, p95: 7.2 },
        Urban: { n: 31, p25: 0.4, p50: 1, p75: 2.1, p95: 6.4 },
      },
      trackOffsetM: { n: 174, p25: 0, p50: 9, p75: 46, p95: 396 },
      mobilityHours: { n: 21, p25: 1, p50: 3, p75: 4, p95: 7 },
      findLocationPct: {
        Temperate: { n: 228, pct: { Structure: 78, Road: 7, Linear: 0, Drainage: 1, Water: 5, Brush: 0, Scrub: 0, Woods: 6, Field: 2, Rock: 0 } },
        Dry: { n: 12, pct: { Structure: 75, Road: 8, Linear: 0, Drainage: 0, Water: 8, Brush: 0, Scrub: 0, Woods: 8, Field: 0, Rock: 0 } },
        Urban: { n: 29, pct: { Structure: 45, Road: 28, Linear: 3, Drainage: 3, Water: 14, Brush: 0, Scrub: 0, Woods: 7, Field: 0, Rock: 0 } },
      },
      outcomePct: { n: 366, well: 88.5, injured: 6.8, dead: 4.4, neverFound: 0.3 },
      survivalDays: { n: 24, p75: 1, p50: 2, p25: 4, p05: 7 },
      elevationPct: { n: 16, uphill: 31, downhill: 31, same: 38 },
      notes: [
        'Those with ASD are 3–4 times more likely than typically developing children to need a formal search.',
        'All ASD subjects were alone when lost (100%); 83% male.',
        'Scenarios: lost 55%, investigative 21%, evading 17%, drowning 3%, overdue 3% (n=106). Evading and drowning are far higher than for typically developing children.',
        'Found in a structure 78% of the time in temperate terrain; water 5% (14% in urban).',
        'Survival: if not found within 24 hours survivability drops to 62%; 25% chance of being found alive at four days, 5% at seven days.',
        'Only 4% were found within 100 m of the IPP; no recorded destinations (they may have one but not tell anyone).',
      ],
    },
    {
      id: 'td-child', name: 'Typically developing child 1–16 (ISRID)', ages: '1–16',
      distanceKm: {
        Temperate: { n: 903, p25: 0.3, p50: 0.9, p75: 2.4, p95: 11.3 },
        Dry: { n: 115, p25: 0.8, p50: 2.4, p75: 4, p95: 9.7 },
        Urban: { n: 129, p25: 0.2, p50: 0.5, p75: 1.6, p95: 5.2 },
      },
      trackOffsetM: { n: 55, p25: 2, p50: 14, p75: 53, p95: 500 },
      mobilityHours: { n: 272, p25: 1, p50: 3, p75: 5, p95: 11 },
      findLocationPct: {
        Temperate: { n: 343, pct: { Structure: 34, Road: 18, Linear: 10, Drainage: 6, Water: 8, Brush: 2, Scrub: 1, Woods: 16, Field: 4, Rock: 1 } },
        Dry: { n: 32, pct: { Structure: 25, Road: 22, Linear: 13, Drainage: 0, Water: 13, Brush: 6, Scrub: 6, Woods: 13, Field: 0, Rock: 3 } },
        Urban: { n: 128, pct: { Structure: 59, Road: 10, Linear: 3, Drainage: 3, Water: 5, Brush: 0, Scrub: 2, Woods: 8, Field: 10, Rock: 0 } },
      },
      outcomePct: { n: 1899, well: 88.7, injured: 5.4, dead: 4.9, neverFound: 1 },
      survivalDays: { n: 73, p75: 2, p50: 3, p25: 5, p05: 11.4 },
      elevationPct: { n: 462, uphill: 34, downhill: 37, same: 29 },
      notes: [
        '13% found within 100 m of the IPP and 11% at a recorded destination.',
        'Scenarios: lost 68%, investigative 13%, overdue 10%, evading 6% (n=1116).',
      ],
    },
  ] as IsridGroup[],
};

export function isridGroup(id: 'asd' | 'td-child'): IsridGroup {
  return ISRID_ASD.groups.find((g) => g.id === id)!;
}
