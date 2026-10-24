import { describe, expect, it } from 'vitest';
import { estimateVisibility, parseForecastXml } from '../src/providers/metForecast.js';
import { fixture } from './helpers.js';

describe('Met Éireann location forecast parser', () => {
  const xml = fixture('met_forecast.xml');
  const now = new Date('2026-10-24T14:30:00Z');

  it('picks the current hour and the next N hours', () => {
    const w = parseForecastXml(xml, now, 6);
    expect(w.now.time).toBe('2026-10-24T15:00:00Z'); // forecast starts 15:00Z
    expect(w.hourly).toHaveLength(6);
    expect(w.hourly[0].time).toBe('2026-10-24T16:00:00Z');
    expect(w.modelRun).toBe('2026-10-24T06:00:00Z');
  });

  it('converts m/s to knots and derives compass + beaufort', () => {
    const w = parseForecastXml(xml, now, 6);
    expect(w.now.wind.speedKt).toBe(24); // 12.1 m/s
    expect(w.now.wind.gustKt).toBe(41); // 21.3 m/s
    expect(w.now.wind.dirDeg).toBe(247);
    expect(w.now.wind.dirName).toBe('WSW');
    expect(w.now.wind.beaufort).toBe(6);
    expect(w.now.tempC).toBe(14);
    expect(w.now.pressureHpa).toBe(984);
  });

  it('attaches the 1-hour precipitation span starting at that hour', () => {
    const w = parseForecastXml(xml, now, 6);
    // span 15:00→16:00 has 0.3 mm / 66.6 %, LightRain
    expect(w.now.precipMm).toBe(0.3);
    expect(w.now.precipProbPct).toBe(67);
    expect(w.now.symbol).toBe('LightRain');
    expect(w.now.visibility.estimated).toBe(true);
  });

  it('falls back to the last hour when now is after the forecast', () => {
    const w = parseForecastXml(xml, new Date('2030-01-01T00:00:00Z'), 6);
    expect(w.hourly).toHaveLength(0);
    expect(w.now).toBeDefined();
  });

  it('rejects an empty document', () => {
    expect(() => parseForecastXml('<weatherdata/>', now, 6)).toThrow();
  });
});

describe('visibility estimate', () => {
  it('maps fog symbol to fog band', () => expect(estimateVisibility('Fog').band).toBe('fog'));
  it('maps heavy rain to poor', () => expect(estimateVisibility('HeavyRain').band).toBe('poor'));
  it('maps clear sky to good', () => expect(estimateVisibility('Sun', 70, 5).band).toBe('good'));
  it('downgrades saturated air', () => expect(estimateVisibility('Cloud', 98, 0.5).band).toBe('poor'));
  it('maps light rain to moderate', () => expect(estimateVisibility('LightRain', 80).label).toBe('2–5 NM'));
});
