import { EventEmitter } from 'node:events';
import type { Fix } from '../../../shared/types.js';
import { now, type Db } from '../db/index.js';
import type { DeviceRow } from './devices.js';

/**
 * Tells the ingest path whether a user's fixes should be kept as track points
 * right now, and under which incident/team. The default (M2) keys off the
 * display mode only; the search service (M3) replaces it with responder/team
 * membership.
 */
export interface TrackContext {
  current(userId: number): { incidentId?: string; teamId?: number; callsign?: string } | undefined;
}

export interface RawFix {
  lat: number;
  lon: number;
  alt?: number;
  acc?: number;
  velKmh?: number;
  cog?: number;
  batt?: number;
  tst: number;
  trig?: string;
}

const KMH_TO_KT = 0.539957;

/**
 * In-memory latest-fix table + persistence of track points. Emits 'fix'.
 */
export class Tracking extends EventEmitter {
  private latest = new Map<number, Fix>();
  private fixesLastMinute: number[] = [];

  constructor(private readonly db: Db, private readonly maxAccuracyM: number, public context: TrackContext) {
    super();
  }

  /** Called by the OwnTracks ingest. Returns the normalised Fix (or undefined if dropped). */
  ingest(device: DeviceRow, user: { id: number; name: string; callsign: string | null }, raw: RawFix): Fix | undefined {
    const ctx = this.context.current(user.id);
    const fix: Fix = {
      userId: user.id,
      deviceId: device.id,
      name: user.name,
      callsign: ctx?.callsign ?? user.callsign ?? undefined,
      teamId: ctx?.teamId,
      incidentId: ctx?.incidentId,
      lat: raw.lat,
      lon: raw.lon,
      alt: raw.alt,
      acc: raw.acc,
      sogKt: raw.velKmh !== undefined ? Math.round(raw.velKmh * KMH_TO_KT * 10) / 10 : undefined,
      cogDeg: raw.cog,
      batt: raw.batt,
      tst: raw.tst,
      at: now(),
    };
    const accurate = raw.acc === undefined || raw.acc <= this.maxAccuracyM;
    if (accurate && ctx?.incidentId) {
      this.db.run(
        `INSERT OR IGNORE INTO positions (device_id, user_id, incident_id, team_id, tst, received_at, lat, lon, alt, acc, vel, cog, batt, trig)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        device.id, user.id, ctx.incidentId, ctx.teamId ?? null, raw.tst, fix.at, raw.lat, raw.lon, raw.alt ?? null, raw.acc ?? null, raw.velKmh ?? null, raw.cog ?? null, raw.batt ?? null, raw.trig ?? null,
      );
    }
    const prev = this.latest.get(user.id);
    if (!prev || prev.tst <= fix.tst) this.latest.set(user.id, fix);
    const t = Date.now();
    this.fixesLastMinute = this.fixesLastMinute.filter((x) => t - x < 60_000);
    this.fixesLastMinute.push(t);
    this.emit('fix', fix);
    return fix;
  }

  latestFor(userId: number): Fix | undefined {
    return this.latest.get(userId);
  }

  all(): Fix[] {
    return [...this.latest.values()];
  }

  /** Fixes newer than `maxAgeSec`, excluding one user. */
  recent(maxAgeSec: number, excludeUserId?: number): Fix[] {
    const cutoff = Math.floor(Date.now() / 1000) - maxAgeSec;
    return this.all().filter((f) => f.tst >= cutoff && f.userId !== excludeUserId);
  }

  rate(): number {
    const t = Date.now();
    this.fixesLastMinute = this.fixesLastMinute.filter((x) => t - x < 60_000);
    return this.fixesLastMinute.length;
  }

  /** Seed the latest table from devices.last_* after a restart. */
  warm(rows: { device: DeviceRow; user: { id: number; name: string; callsign: string | null } }[]): void {
    for (const { device, user } of rows) {
      if (device.last_lat === null || device.last_lon === null || device.last_tst === null) continue;
      const prev = this.latest.get(user.id);
      if (prev && prev.tst >= device.last_tst) continue;
      this.latest.set(user.id, {
        userId: user.id,
        deviceId: device.id,
        name: user.name,
        callsign: user.callsign ?? undefined,
        lat: device.last_lat,
        lon: device.last_lon,
        alt: device.last_alt ?? undefined,
        acc: device.last_acc ?? undefined,
        batt: device.last_batt ?? undefined,
        tst: device.last_tst,
        at: device.last_seen_at ?? now(),
      });
    }
  }
}
