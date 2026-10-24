import { describe, expect, it } from 'vitest';
import type { AisVessel } from '../../shared/types.js';
import { applyAisMessage, expireVessels } from '../src/providers/ais.js';

const pos = (mmsi: number, extra: Record<string, unknown> = {}) => ({
  MessageType: 'PositionReport',
  MetaData: { MMSI: mmsi, ShipName: 'HOWTH LIGHT ', latitude: 53.39, longitude: -6.05, time_utc: '2026-10-24 14:00:00 +0000 UTC' },
  Message: { PositionReport: { Sog: 5.4, Cog: 123.4, TrueHeading: 120, ...extra } },
});

describe('aisstream message handling', () => {
  it('upserts a vessel from a position report', () => {
    const t = new Map<number, AisVessel>();
    const v = applyAisMessage(t, pos(250001234), new Date('2026-10-24T14:00:00Z'))!;
    expect(v.name).toBe('HOWTH LIGHT');
    expect(v.sogKt).toBe(5.4);
    expect(v.cogDeg).toBe(123);
    expect(v.headingDeg).toBe(120);
    expect(t.size).toBe(1);
  });
  it('treats 511 heading / 102.3 SOG as unknown and keeps previous', () => {
    const t = new Map<number, AisVessel>();
    applyAisMessage(t, pos(1));
    applyAisMessage(t, pos(1, { Sog: 102.3, TrueHeading: 511, Cog: 360 }));
    const v = t.get(1)!;
    expect(v.sogKt).toBe(5.4);
    expect(v.headingDeg).toBe(120);
  });
  it('ignores junk', () => {
    const t = new Map<number, AisVessel>();
    expect(applyAisMessage(t, {} as any)).toBeUndefined();
    expect(t.size).toBe(0);
  });
  it('expires stale vessels', () => {
    const t = new Map<number, AisVessel>();
    applyAisMessage(t, pos(1), new Date('2026-10-24T13:00:00Z'));
    applyAisMessage(t, pos(2), new Date('2026-10-24T14:00:00Z'));
    expireVessels(t, 15 * 60_000, new Date('2026-10-24T14:05:00Z'));
    expect([...t.keys()]).toEqual([2]);
  });
});
