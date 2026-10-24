import { describe, expect, it } from 'vitest';
import { filterActive, parseCap, parseWarningsRss } from '../src/providers/metWarnings.js';
import { fixture } from './helpers.js';

const loc = { localRegionCodes: ['EI07'], localMarineCodes: [], marineHeadland: 'Howth Head' };

describe('Met Éireann warnings RSS', () => {
  it('lists CAP links', () => {
    const links = parseWarningsRss(fixture('met_warnings_rss.xml'));
    expect(links).toHaveLength(8);
    expect(links.every((l) => l.startsWith('https://cap.met.ie/'))).toBe(true);
  });
});

describe('CAP parser', () => {
  it('parses a marine gale warning covering all coasts as local', () => {
    const w = parseCap(fixture('cap_yellow_gale.xml'), loc)!;
    expect(w.level).toBe('yellow');
    expect(w.type).toBe('Gale');
    expect(w.marine).toBe(true);
    expect(w.local).toBe(true);
    expect(w.headline).toMatch(/Marine Gale warning/);
    expect(w.onset).toBe('2026-10-24T03:00:00.000Z');
    expect(w.expires).toBe('2026-10-25T22:00:00.000Z');
    expect(w.regionCodes).toContain('EI811');
    expect(w.description).toBe('Storm Boelo: Southerly winds veering westerly will reach gale force 8 or higher at times.');
  });

  it('parses a Small Craft warning as advisory level, marine, local', () => {
    const w = parseCap(fixture('cap_small_craft.xml'), loc)!;
    expect(w.level).toBe('advisory');
    expect(w.type).toBe('Small Craft');
    expect(w.marine).toBe(true);
    expect(w.local).toBe(true);
  });

  it('marks a Dublin land warning local and a Donegal-coast storm not local', () => {
    const dub = parseCap(fixture('cap_yellow_wind_dublin.xml'), loc)!;
    expect(dub.marine).toBe(false);
    expect(dub.local).toBe(true);
    expect(dub.areas[0]).toMatch(/Dublin/);
    const red = parseCap(fixture('cap_red_gale.xml'), loc)!;
    expect(red.level).toBe('red');
    expect(red.marine).toBe(true);
    expect(red.local).toBe(false); // Rossan Point → Bloody Foreland → Fair Head
  });

  it('honours explicit marine EMMA codes when configured', () => {
    const red = parseCap(fixture('cap_red_gale.xml'), { ...loc, localMarineCodes: ['EI805'] })!;
    expect(red.local).toBe(true);
  });

  it('ignores cancellations and tests', () => {
    const xml = fixture('cap_small_craft.xml').replace('<msgType>Update</msgType>', '<msgType>Cancel</msgType>');
    expect(parseCap(xml, loc)).toBeUndefined();
    const test = fixture('cap_small_craft.xml').replace('<status>Actual</status>', '<status>Test</status>');
    expect(parseCap(test, loc)).toBeUndefined();
  });
});

describe('filterActive', () => {
  const base = parseCap(fixture('cap_yellow_gale.xml'), loc)!;
  it('drops expired and far-future warnings, sorts by level', () => {
    const expired = { ...base, id: 'x', expires: '2026-10-24T00:00:00Z' };
    const future = { ...base, id: 'f', onset: '2026-10-27T00:00:00Z' };
    const red = { ...base, id: 'r', level: 'red' as const };
    const out = filterActive([base, expired, future, red], new Date('2026-10-24T12:00:00Z'));
    expect(out.map((w) => w.id)).toEqual(['r', base.id]);
  });
});
