import { describe, expect, it } from 'vitest';
import { computeSunMoon, moonPhaseName } from '../src/providers/sunMoon.js';

describe('sun/moon', () => {
  const lat = 53.388, lon = -6.065;
  it('computes Howth daylight for an October afternoon', () => {
    const s = computeSunMoon(new Date('2026-10-24T14:30:00Z'), lat, lon);
    expect(s.isDaylight).toBe(true);
    expect(s.sunrise.slice(0, 13)).toBe('2026-10-24T07');
    expect(s.sunset.slice(0, 13)).toBe('2026-10-24T17');
    expect(s.daylightRemainingMin).toBeGreaterThan(150);
    expect(s.daylightRemainingMin).toBeLessThan(250);
    expect(s.untilSunriseMin).toBeUndefined();
    expect(s.moonIlluminationPct).toBeGreaterThan(90);
  });
  it('after dusk counts down to the next sunrise', () => {
    const s = computeSunMoon(new Date('2026-10-24T22:00:00Z'), lat, lon);
    expect(s.isDaylight).toBe(false);
    expect(s.daylightRemainingMin).toBe(0);
    expect(s.untilSunriseMin).toBeGreaterThan(500);
    expect(s.nextSunrise.slice(0, 10)).toBe('2026-10-25');
  });
  it('names phases', () => {
    expect(moonPhaseName(0)).toBe('New Moon');
    expect(moonPhaseName(0.5)).toBe('Full Moon');
    expect(moonPhaseName(0.25)).toBe('First Quarter');
    expect(moonPhaseName(0.99)).toBe('New Moon');
  });
});
