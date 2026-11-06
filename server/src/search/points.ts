import { PLANNING_POINT_KINDS, type PlanningPoint, type PlanningPointKind, type PlanningPointRow } from '../../../shared/types.js';
import { now, type Db } from '../db/index.js';

interface PointRow { id: number; incident_id: string; kind: PlanningPointKind; label: string | null; lat: number; lon: number; note: string | null; set_at: string; set_by: number | null }

export interface PointInput {
  kind?: string;
  label?: string | null;
  lat?: number;
  lon?: number;
  note?: string | null;
}

const LABEL_MAX = 80;
const NOTE_MAX = 500;
/** Keep points inside a sane box around Ireland: catches lat/lon swapped or a click on Null Island. */
const BOUNDS = { latMin: 49, latMax: 58, lonMin: -12, lonMax: 0 };

function checkPos(lat: unknown, lon: unknown): { lat: number; lon: number } {
  const la = Number(lat), lo = Number(lon);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) throw new Error('invalid position');
  if (la < BOUNDS.latMin || la > BOUNDS.latMax || lo < BOUNDS.lonMin || lo > BOUNDS.lonMax) throw new Error('position is outside Ireland and Britain: check lat/lon');
  return { lat: la, lon: lo };
}

function checkKind(k: unknown): PlanningPointKind {
  if (!PLANNING_POINT_KINDS.includes(k as PlanningPointKind)) throw new Error('unknown point kind');
  return k as PlanningPointKind;
}

const text = (v: string | null | undefined, max: number) => (v === undefined ? undefined : v === null || !String(v).trim() ? null : String(v).trim().slice(0, max));

/**
 * Typed planning points per incident. One `lkp` and one `pls` at most (adding another moves
 * it); any number of the other kinds. The incident's planning point (`ipp`) is the LKP, else
 * the PLS, so everything built on the single IPP keeps working.
 */
export class Points {
  constructor(private readonly db: Db) {}

  list(incidentId: string): PlanningPointRow[] {
    return this.db.all<PointRow>('SELECT * FROM planning_points WHERE incident_id = ? ORDER BY id', incidentId).map(toPoint);
  }

  get(id: number): PlanningPointRow | undefined {
    const r = this.db.get<PointRow>('SELECT * FROM planning_points WHERE id = ?', id);
    return r ? toPoint(r) : undefined;
  }

  /** The point the search is planned from. */
  planningPoint(incidentId: string): PlanningPoint | undefined {
    const r = this.db.get<PointRow>("SELECT * FROM planning_points WHERE incident_id = ? AND kind IN ('lkp','pls') ORDER BY CASE kind WHEN 'lkp' THEN 0 ELSE 1 END LIMIT 1", incidentId);
    return r ? { lat: r.lat, lon: r.lon, label: r.label ?? (r.kind === 'pls' ? 'PLS' : undefined), setAt: r.set_at } : undefined;
  }

  add(incidentId: string, input: PointInput, by?: number): PlanningPointRow {
    const kind = checkKind(input.kind);
    const { lat, lon } = checkPos(input.lat, input.lon);
    const label = text(input.label, LABEL_MAX) ?? null;
    const note = text(input.note, NOTE_MAX) ?? null;
    const t = now();
    if (kind === 'lkp' || kind === 'pls') {
      const cur = this.db.get<PointRow>('SELECT * FROM planning_points WHERE incident_id = ? AND kind = ?', incidentId, kind);
      if (cur) return this.update(cur.id, { lat, lon, label: input.label === undefined ? undefined : label, note: input.note === undefined ? undefined : note }, by);
    }
    const id = this.db.run('INSERT INTO planning_points (incident_id, kind, label, lat, lon, note, set_at, set_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', incidentId, kind, label, lat, lon, note, t, by ?? null).lastInsertRowid;
    return this.get(Number(id))!;
  }

  update(id: number, input: PointInput, by?: number): PlanningPointRow {
    const cur = this.db.get<PointRow>('SELECT * FROM planning_points WHERE id = ?', id);
    if (!cur) throw new Error('point not found');
    let kind = cur.kind;
    if (input.kind !== undefined && input.kind !== cur.kind) {
      kind = checkKind(input.kind);
      if ((kind === 'lkp' || kind === 'pls') && this.db.get('SELECT 1 FROM planning_points WHERE incident_id = ? AND kind = ? AND id <> ?', cur.incident_id, kind, id)) throw new Error(`this incident already has a ${kind.toUpperCase()}; move that one instead`);
    }
    const pos = input.lat !== undefined || input.lon !== undefined ? checkPos(input.lat ?? cur.lat, input.lon ?? cur.lon) : { lat: cur.lat, lon: cur.lon };
    const label = text(input.label, LABEL_MAX);
    const note = text(input.note, NOTE_MAX);
    this.db.run('UPDATE planning_points SET kind = ?, label = ?, lat = ?, lon = ?, note = ?, set_at = ?, set_by = ? WHERE id = ?', kind, label === undefined ? cur.label : label, pos.lat, pos.lon, note === undefined ? cur.note : note, now(), by ?? cur.set_by, id);
    return this.get(id)!;
  }

  remove(id: number): PlanningPointRow | undefined {
    const p = this.get(id);
    if (p) this.db.run('DELETE FROM planning_points WHERE id = ?', id);
    return p;
  }

  /** Legacy single-IPP API: set or clear the LKP. */
  setLkp(incidentId: string, ipp: { lat: number; lon: number; label?: string } | null, by?: number): void {
    if (ipp) this.add(incidentId, { kind: 'lkp', lat: ipp.lat, lon: ipp.lon, label: ipp.label ?? null }, by);
    else this.db.run("DELETE FROM planning_points WHERE incident_id = ? AND kind = 'lkp'", incidentId);
  }
}

function toPoint(r: PointRow): PlanningPointRow {
  return { id: r.id, incidentId: r.incident_id, kind: r.kind, label: r.label ?? undefined, lat: r.lat, lon: r.lon, note: r.note ?? undefined, setAt: r.set_at };
}
