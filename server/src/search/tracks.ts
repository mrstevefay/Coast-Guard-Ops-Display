import type { Db } from '../db/index.js';

export interface TrackFeature {
  type: 'Feature';
  properties: { userId: number | null; deviceId: number; teamId: number | null; name?: string; callsign?: string; from: number; to: number; points: number };
  geometry: { type: 'LineString'; coordinates: [number, number, number | null][] };
}

export interface TrackCollection {
  type: 'FeatureCollection';
  features: TrackFeature[];
}

interface PosRow {
  device_id: number;
  user_id: number | null;
  team_id: number | null;
  tst: number;
  lat: number;
  lon: number;
  alt: number | null;
}

/**
 * Track lines per (device, team) for an incident. A gap longer than `gapSec`
 * starts a new feature so a phone that went dark does not draw a straight line
 * across the bay.
 */
export function tracksFor(db: Db, incidentId: string, opts: { teamId?: number; userId?: number; sinceTst?: number; untilTst?: number; gapSec: number; names?: (userId: number) => { name?: string; callsign?: string } }): TrackCollection {
  const where = ['incident_id = ?'];
  const params: (string | number)[] = [incidentId];
  if (opts.teamId !== undefined) { where.push('team_id = ?'); params.push(opts.teamId); }
  if (opts.userId !== undefined) { where.push('user_id = ?'); params.push(opts.userId); }
  if (opts.sinceTst !== undefined) { where.push('tst >= ?'); params.push(opts.sinceTst); }
  if (opts.untilTst !== undefined) { where.push('tst <= ?'); params.push(opts.untilTst); }
  const rows = db.all<PosRow>(`SELECT device_id, user_id, team_id, tst, lat, lon, alt FROM positions WHERE ${where.join(' AND ')} ORDER BY device_id, team_id, tst`, ...params);

  const features: TrackFeature[] = [];
  let cur: TrackFeature | undefined;
  let lastKey = '';
  let lastTst = 0;
  for (const r of rows) {
    const key = `${r.device_id}:${r.team_id ?? ''}`;
    if (!cur || key !== lastKey || r.tst - lastTst > opts.gapSec) {
      const nm = r.user_id !== null ? opts.names?.(r.user_id) : undefined;
      cur = { type: 'Feature', properties: { userId: r.user_id, deviceId: r.device_id, teamId: r.team_id, name: nm?.name, callsign: nm?.callsign, from: r.tst, to: r.tst, points: 0 }, geometry: { type: 'LineString', coordinates: [] } };
      features.push(cur);
    }
    cur.geometry.coordinates.push([r.lon, r.lat, r.alt]);
    cur.properties.to = r.tst;
    cur.properties.points++;
    lastKey = key;
    lastTst = r.tst;
  }
  // a single point is not a line; keep it anyway so a stationary responder still "has a track"
  for (const f of features) if (f.geometry.coordinates.length === 1) f.geometry.coordinates.push([...f.geometry.coordinates[0]] as [number, number, number | null]);
  return { type: 'FeatureCollection', features };
}
