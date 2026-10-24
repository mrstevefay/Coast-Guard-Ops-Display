import { describe, expect, it } from 'vitest';
import { parseWaveModel } from '../src/providers/waveModel.js';
import { parseBuoyRows } from '../src/providers/weatherBuoy.js';
import { erddapRows } from './helpers.js';

describe('SWAN wave model point', () => {
  it('picks the hour nearest now', () => {
    const r = parseWaveModel(erddapRows('swan_howth.json'), new Date('2026-10-24T14:20:00Z'), 'Howth approaches (SWAN model)');
    expect(r.isModel).toBe(true);
    expect(r.time).toBe('2026-10-24T14:00:00.000Z');
    expect(r.hsM).toBe(2.1);
    expect(r.periodS).toBe(8);
    expect(r.dirDeg).toBe(161);
    expect(r.lat).toBeCloseTo(53.3875);
  });
  it('throws on empty', () => expect(() => parseWaveModel([], new Date(), 'x')).toThrow());
});

describe('M2 weather buoy', () => {
  it('returns latest row with knots and metres', () => {
    const r = parseBuoyRows(erddapRows('buoy_m2.json'), 'M2');
    expect(r.time).toBe('2026-10-24T13:00:00.000Z');
    expect(r.hsM).toBe(2.7);
    expect(r.periodS).toBe(5);
    expect(r.seaTempC).toBe(14.3);
    expect(r.wind?.speedKt).toBe(30);
    expect(r.wind?.gustKt).toBe(42);
    expect(r.wind?.dirName).toBe('SSW');
    expect(r.pressureHpa).toBe(985);
    expect(r.hmaxM).toBeUndefined(); // 0 = missing
  });
  it('ignores other stations', () => expect(() => parseBuoyRows(erddapRows('buoy_m2.json'), 'M5')).toThrow());
});
