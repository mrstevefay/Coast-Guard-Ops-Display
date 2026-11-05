import { describe, expect, it } from 'vitest';
import { parseDirection, parseForce, parseIrishDateTime, parseSeaAreaPage, visibilityBand } from '../src/providers/metSeaArea.js';
import { fixture } from './helpers.js';

describe('Met Éireann Sea Area Forecast page parser', () => {
  const f = parseSeaAreaPage(fixture('met_sea_area.html'), 'Howth Head');

  it('reads validity, issue time, warnings and situation', () => {
    expect(f.issuedAt).toBe('2026-11-05T11:30:00.000Z'); // GMT in November
    expect(f.validTo).toBe('2026-11-06T12:00:00.000Z');
    expect(f.smallCraft).toMatch(/Malin Head to Belfast Lough to Howth Head/);
    expect(f.galeWarning).toBeUndefined(); // "nil"
    expect(f.situation).toMatch(/anticyclone of 1037hPa/);
    expect(f.outlook).toMatch(/light to moderate easterly/);
  });

  it('picks the section covering Howth and parses wind/visibility', () => {
    expect(f.sections).toHaveLength(1);
    expect(f.area.title).toMatch(/all Irish coastal waters/);
    expect(f.area.forceMin).toBe(4);
    expect(f.area.forceMax).toBe(6);
    expect(f.area.direction).toBe('NE–E');
    expect(f.area.visibility).toMatch(/moderate or poor/);
    expect(f.area.visibilityBand).toBe('poor');
    expect(f.area.weather).toMatch(/scattered showers/);
  });

  it('selects the right stretch when the forecast is split by coast', () => {
    const html = fixture('met_sea_area.html').replace(
      '<div class="sea-area-short-coastal sea-area-forecast">',
      `<div class="sea-area-short-coastal sea-area-forecast">
        <h2>Forecast for Irish coastal waters from Mizen Head to Loop Head to Erris Head</h2>
        <p><strong>Wind: </strong> Southwest force 7 to gale force 8.</p>
        <p><strong>Weather: </strong> Rain.</p>
        <p><strong>Visibility: </strong>Poor.</p>
      </div>
      <div class="sea-area-short-coastal sea-area-forecast">
        <h2>Forecast for Irish coastal waters from Carlingford Lough to Howth Head to Wicklow Head and on the Irish Sea</h2>
        <p><strong>Wind: </strong> Easterly force 3 or 4.</p>
        <p><strong>Weather: </strong> Fair.</p>
        <p><strong>Visibility: </strong>Good.</p>
      </div>
      <div class="sea-area-short-coastal sea-area-forecast" style="display:none">`,
    );
    const g = parseSeaAreaPage(html, 'Howth Head');
    expect(g.sections).toHaveLength(3);
    expect(g.area.title).toMatch(/Carlingford Lough to Howth Head/);
    expect(g.area.forceMin).toBe(3);
    expect(g.area.forceMax).toBe(4);
    expect(g.area.direction).toBe('E');
    expect(g.area.visibilityBand).toBe('good');
  });

  it('throws when the layout changes', () => {
    expect(() => parseSeaAreaPage('<html><body>nothing</body></html>', 'Howth Head')).toThrow(/layout/);
  });
});

describe('sea area helpers', () => {
  it('parses force phrases', () => {
    expect(parseForce('Southwest force 7 to gale force 8')).toEqual({ min: 7, max: 8 });
    expect(parseForce('Variable force 2 or 3, occasionally 4')).toEqual({ min: 2, max: 3 });
    expect(parseForce('Northwest force 5')).toEqual({ min: 5, max: 5 });
    expect(parseForce('calm')).toBeUndefined();
  });
  it('parses direction words', () => {
    expect(parseDirection('West to northwest force 5 or 6')).toBe('W–NW');
    expect(parseDirection('Southerly force 4, veering southwesterly')).toBe('S');
    expect(parseDirection('Variable force 2')).toBe('VAR');
  });
  it('bands visibility text', () => {
    expect(visibilityBand('Good')).toBe('good');
    expect(visibilityBand('Moderate, occasionally poor')).toBe('poor');
    expect(visibilityBand('Fog')).toBe('fog');
    expect(visibilityBand('Good, with isolated fog patches')).toBe('good');
  });
  it('parses Irish local timestamps with DST', () => {
    expect(parseIrishDateTime('11:30, Thursday 05 November 2026')).toBe('2026-11-05T11:30:00.000Z');
    expect(parseIrishDateTime('06:00, Saturday 04 July 2026')).toBe('2026-07-04T05:00:00.000Z');
  });
});
