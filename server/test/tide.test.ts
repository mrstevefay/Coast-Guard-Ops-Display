import { describe, expect, it } from 'vitest';
import { derive, interpolate } from '../src/derive.js';
import { parseGaugeRows } from '../src/providers/tideGauge.js';
import { buildTidePrediction } from '../src/providers/tidePrediction.js';
import { erddapRows } from './helpers.js';

describe('tide gauge parser', () => {
  it('returns the latest QC-ok level with trend', () => {
    const r = parseGaugeRows(erddapRows('tide_gauge_howth.json'));
    expect(r.time).toBe('2026-10-24T14:10:00Z');
    expect(r.levelLatM).toBe(1.67);
    expect(r.levelOdMalinM).toBe(-0.89);
    expect(r.rising).toBe(false);
  });
  it('skips bad-QC rows', () => {
    const rows = erddapRows('tide_gauge_howth.json').map((r, i, a) => (i === a.length - 1 ? { ...r, QC_Flag: 4 } : r));
    const r = parseGaugeRows(rows);
    expect(r.time).toBe('2026-10-24T14:05:00Z');
  });
  it('throws with no usable rows', () => {
    expect(() => parseGaugeRows([])).toThrow();
  });
});

describe('tide prediction', () => {
  const now = new Date('2026-10-24T14:30:00Z');
  const pred = buildTidePrediction({
    highLow: erddapRows('tide_highlow_howth.json'),
    curve: erddapRows('tide_curve_howth.json'),
    now,
    stationId: 'Howth',
    springRangeM: 3.3,
    neapRangeM: 2.3,
  });

  it('learns the OD Malin → LAT offset from the curve', () => {
    expect(pred.odMalinToLatM).toBe(2.56);
  });
  it('finds next/following/previous events in LAT', () => {
    expect(pred.next).toEqual({ kind: 'LW', time: '2026-10-24T15:40:00Z', heightM: 1.04 });
    expect(pred.following).toEqual({ kind: 'HW', time: '2026-10-24T22:05:00Z', heightM: 4.3 });
    expect(pred.previous?.kind).toBe('HW');
    expect(pred.rising).toBe(false);
    expect(pred.rangeM).toBe(3.04);
  });
  it('flags springs around full moon', () => {
    expect(pred.springNeap).toBe('springs');
  });
  it('builds a 15-minute curve around now', () => {
    expect(pred.curve.length).toBeGreaterThan(20);
    expect(pred.curve.every((p) => new Date(p.time).getUTCMinutes() % 15 === 0)).toBe(true);
    expect(pred.curve[0].heightM).toBeGreaterThan(0);
  });
  it('interpolates predicted height and surge in derive()', () => {
    const d = derive({ tide: { ...pred, observedM: 1.67, observedAt: '2026-10-24T14:10:00Z' } });
    expect(d.tide!.surgeM).toBeDefined();
    expect(Math.abs(d.tide!.surgeM!)).toBeLessThan(1);
    expect(interpolate(pred.curve, Date.parse(pred.curve[3].time))).toBe(pred.curve[3].heightM);
    const mid = (Date.parse(pred.curve[3].time) + Date.parse(pred.curve[4].time)) / 2;
    const h = interpolate(pred.curve, mid)!;
    expect(h).toBeGreaterThanOrEqual(Math.min(pred.curve[3].heightM, pred.curve[4].heightM));
    expect(h).toBeLessThanOrEqual(Math.max(pred.curve[3].heightM, pred.curve[4].heightM));
  });
});
