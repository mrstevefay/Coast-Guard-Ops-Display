import type { Audit } from '../audit.js';
import type { Sessions } from '../auth/sessions.js';
import type { AppConfig } from '../config.js';
import { now, type Db } from '../db/index.js';
import type { Devices } from './devices.js';

export interface RetentionResult {
  positionsDeleted: number;
  lastFixesCleared: number;
  sessionsPurged: number;
  auditPurged: number;
  ranAt: string;
}

/**
 * Data minimisation, run nightly. Everything is driven by config.retention;
 * trackDays = 0 keeps track points forever (the station's current choice).
 */
export function runRetention(db: Db, cfg: AppConfig, deps: { devices: Devices; sessions: Sessions; audit: Audit }): RetentionResult {
  const r = cfg.retention;
  let positionsDeleted = 0;
  if (r.trackDays > 0) {
    const cutoff = new Date(Date.now() - r.trackDays * 86400_000).toISOString();
    positionsDeleted = db.run('DELETE FROM positions WHERE incident_id IN (SELECT id FROM incidents WHERE ended_at IS NOT NULL AND ended_at < ?)', cutoff).changes;
  }
  const lastFixesCleared = r.lastFixHours > 0 ? deps.devices.clearStaleLast(r.lastFixHours) : 0;
  const sessionsPurged = deps.sessions.purgeExpired();
  const auditPurged = r.auditYears > 0 ? deps.audit.purgeOlderThan(new Date(Date.now() - r.auditYears * 365 * 86400_000).toISOString()) : 0;
  const result = { positionsDeleted, lastFixesCleared, sessionsPurged, auditPurged, ranAt: now() };
  deps.audit.log(undefined, undefined, 'retention.ran', undefined, result);
  return result;
}

/** Milliseconds until the next HH:MM in Europe/Dublin. */
export function msUntilLocal(hour: number, minute: number, nowMs = Date.now()): number {
  const fmt = new Intl.DateTimeFormat('en-IE', { timeZone: 'Europe/Dublin', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(nowMs)).map((p) => [p.type, Number(p.value)]));
  const nowSec = (parts.hour % 24) * 3600 + parts.minute * 60 + parts.second;
  const targetSec = hour * 3600 + minute * 60;
  let delta = targetSec - nowSec;
  if (delta <= 0) delta += 86400;
  return delta * 1000;
}

/** Schedule fn daily at a local time; returns a stopper. */
export function scheduleDaily(hour: number, minute: number, fn: () => void): () => void {
  let timer: NodeJS.Timeout | undefined;
  const arm = () => {
    timer = setTimeout(() => {
      try {
        fn();
      } finally {
        arm();
      }
    }, msUntilLocal(hour, minute));
    timer.unref?.();
  };
  arm();
  return () => timer && clearTimeout(timer);
}
