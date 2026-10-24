import { describe, expect, it } from 'vitest';
import { dublinOffsetMs, parseObservations } from '../src/providers/metObservations.js';
import { fixtureJson } from './helpers.js';

describe('Met Éireann observations parser', () => {
  const rows = fixtureJson('met_observations.json');

  it('returns the newest Dublin Airport row in knots and UTC', () => {
    const o = parseObservations(rows, 'Dublin Airport');
    expect(o.stationName).toBe('Dublin Airport');
    expect(o.time).toBe('2026-10-24T14:00:00.000Z'); // 15:00 IST
    expect(o.wind.speedKt).toBe(14); // 26 km/h
    expect(o.wind.gustKt).toBe(29); // 54 km/h
    expect(o.wind.dirName).toBe('SW');
    expect(o.tempC).toBe(15);
    expect(o.pressureHpa).toBe(982);
    expect(o.humidityPct).toBe(91);
    expect(o.rainfallMm).toBe(0.5);
  });

  it('throws when the station is missing', () => {
    expect(() => parseObservations(rows, 'Nowhere')).toThrow(/no rows/);
  });

  it('knows Irish summer/winter time', () => {
    expect(dublinOffsetMs(new Date('2026-07-01T12:00:00Z'))).toBe(3600_000);
    expect(dublinOffsetMs(new Date('2026-01-15T12:00:00Z'))).toBe(0);
  });
});
