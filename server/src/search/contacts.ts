import { CONTACT_ROLES, PRIVATE_CONTACT_ROLES, type ContactLogEntry, type ContactRole, type IncidentContact, type StationContact } from '../../../shared/types.js';
import { now, type Db } from '../db/index.js';

interface StationRow { id: number; role: ContactRole; name: string; organisation: string | null; phone: string | null; notes: string | null; updated_at: string }
interface IncidentRow { id: number; incident_id: string; role: ContactRole; name: string; organisation: string | null; phone: string | null; reference: string | null; notes: string | null; directory_id: number | null; created_at: string; redacted_at: string | null }
interface LogRow { id: number; incident_id: string; contact_id: number | null; at: string; direction: 'in' | 'out' | 'note'; text: string; by_user: number | null; by_name?: string | null }

export interface ContactInput { role?: string; name?: string; organisation?: string | null; phone?: string | null; reference?: string | null; notes?: string | null }

const clip = (v: unknown, max: number): string | null => (v === undefined || v === null || !String(v).trim() ? null : String(v).trim().slice(0, max));
function role(v: unknown): ContactRole {
  if (!CONTACT_ROLES.includes(v as ContactRole)) throw new Error('unknown contact role');
  return v as ContactRole;
}
/** Phone numbers as typed, with only digits, spaces, + ( ) - kept: enough to dial, nothing else. */
function phone(v: unknown): string | null {
  const p = clip(v, 40);
  if (!p) return null;
  if (!/^[+0-9 ()\-]{3,40}$/.test(p)) throw new Error('phone: digits, spaces and + ( ) - only');
  return p;
}
const name = (v: unknown) => {
  const n = clip(v, 120);
  if (!n) throw new Error('name is required');
  return n;
};

const toStation = (r: StationRow): StationContact => ({ id: r.id, role: r.role, name: r.name, organisation: r.organisation ?? undefined, phone: r.phone ?? undefined, notes: r.notes ?? undefined, updatedAt: r.updated_at });
const toIncident = (r: IncidentRow): IncidentContact => ({ id: r.id, incidentId: r.incident_id, role: r.role, name: r.name, organisation: r.organisation ?? undefined, phone: r.phone ?? undefined, reference: r.reference ?? undefined, notes: r.notes ?? undefined, directoryId: r.directory_id ?? undefined, createdAt: r.created_at, redactedAt: r.redacted_at ?? undefined });
const toLog = (r: LogRow): ContactLogEntry => ({ id: r.id, incidentId: r.incident_id, contactId: r.contact_id ?? undefined, at: r.at, direction: r.direction, text: r.text, byUserId: r.by_user ?? undefined, byName: r.by_name ?? undefined });

/** The station directory, each incident's contacts, and the call log. */
export class Contacts {
  constructor(private readonly db: Db) {}

  // ---------------------------------------------------------- station directory
  directory(): StationContact[] {
    return this.db.all<StationRow>('SELECT * FROM station_contacts ORDER BY role, name').map(toStation);
  }
  addStation(input: ContactInput): StationContact {
    const t = now();
    const id = this.db.run('INSERT INTO station_contacts (role, name, organisation, phone, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', stationRole(input.role), name(input.name), clip(input.organisation, 120), phone(input.phone), clip(input.notes, 500), t, t).lastInsertRowid;
    return this.station(Number(id))!;
  }
  updateStation(id: number, input: ContactInput): StationContact {
    const cur = this.station(id);
    if (!cur) throw new Error('contact not found');
    this.db.run('UPDATE station_contacts SET role = ?, name = ?, organisation = ?, phone = ?, notes = ?, updated_at = ? WHERE id = ?',
      input.role === undefined ? cur.role : stationRole(input.role), input.name === undefined ? cur.name : name(input.name),
      input.organisation === undefined ? cur.organisation ?? null : clip(input.organisation, 120), input.phone === undefined ? cur.phone ?? null : phone(input.phone),
      input.notes === undefined ? cur.notes ?? null : clip(input.notes, 500), now(), id);
    return this.station(id)!;
  }
  removeStation(id: number): void {
    if (this.db.run('DELETE FROM station_contacts WHERE id = ?', id).changes === 0) throw new Error('contact not found');
  }
  station(id: number): StationContact | undefined {
    const r = this.db.get<StationRow>('SELECT * FROM station_contacts WHERE id = ?', id);
    return r ? toStation(r) : undefined;
  }

  // ---------------------------------------------------------- per incident
  list(incidentId: string): IncidentContact[] {
    return this.db.all<IncidentRow>('SELECT * FROM incident_contacts WHERE incident_id = ? ORDER BY id', incidentId).map(toIncident);
  }
  get(id: number): IncidentContact | undefined {
    const r = this.db.get<IncidentRow>('SELECT * FROM incident_contacts WHERE id = ?', id);
    return r ? toIncident(r) : undefined;
  }
  /** Add a contact to an incident, typed in or copied from the station directory (`directoryId`). */
  add(incidentId: string, input: ContactInput & { directoryId?: number }, by?: number): IncidentContact {
    let base: ContactInput = input;
    if (input.directoryId) {
      const d = this.station(Number(input.directoryId));
      if (!d) throw new Error('directory contact not found');
      base = { role: d.role, name: d.name, organisation: d.organisation, phone: d.phone, notes: d.notes, ...strip(input) };
    }
    const id = this.db.run('INSERT INTO incident_contacts (incident_id, role, name, organisation, phone, reference, notes, directory_id, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      incidentId, role(base.role), name(base.name), clip(base.organisation, 120), phone(base.phone), clip(base.reference, 80), clip(base.notes, 500), input.directoryId ?? null, now(), by ?? null).lastInsertRowid;
    return this.get(Number(id))!;
  }
  update(id: number, input: ContactInput): IncidentContact {
    const cur = this.get(id);
    if (!cur) throw new Error('contact not found');
    if (cur.redactedAt) throw new Error('this contact was cleared under the retention policy');
    const pick = <T>(v: T | undefined, fallback: T) => (v === undefined ? fallback : v);
    this.db.run('UPDATE incident_contacts SET role = ?, name = ?, organisation = ?, phone = ?, reference = ?, notes = ? WHERE id = ?',
      input.role === undefined ? cur.role : role(input.role), input.name === undefined ? cur.name : name(input.name),
      pick(input.organisation === undefined ? undefined : clip(input.organisation, 120), cur.organisation ?? null), pick(input.phone === undefined ? undefined : phone(input.phone), cur.phone ?? null),
      pick(input.reference === undefined ? undefined : clip(input.reference, 80), cur.reference ?? null), pick(input.notes === undefined ? undefined : clip(input.notes, 500), cur.notes ?? null), id);
    return this.get(id)!;
  }
  remove(id: number): IncidentContact {
    const cur = this.get(id);
    if (!cur) throw new Error('contact not found');
    this.db.run('DELETE FROM incident_contacts WHERE id = ?', id);
    return cur;
  }

  // ---------------------------------------------------------- call log
  log(incidentId: string): ContactLogEntry[] {
    return this.db.all<LogRow>('SELECT l.*, u.name AS by_name FROM contact_log l LEFT JOIN users u ON u.id = l.by_user WHERE l.incident_id = ? ORDER BY l.at, l.id', incidentId).map(toLog);
  }
  addLog(incidentId: string, input: { contactId?: number | null; direction?: string; text?: string }, by?: number): ContactLogEntry {
    const direction = input.direction ?? 'out';
    if (!['in', 'out', 'note'].includes(direction)) throw new Error('direction must be in, out or note');
    const text = clip(input.text, 1000);
    if (!text) throw new Error('say what was said');
    if (input.contactId) {
      const c = this.get(Number(input.contactId));
      if (!c || c.incidentId !== incidentId) throw new Error('contact not found for this incident');
    }
    const id = this.db.run('INSERT INTO contact_log (incident_id, contact_id, at, direction, text, by_user) VALUES (?, ?, ?, ?, ?, ?)', incidentId, input.contactId ?? null, now(), direction, text, by ?? null).lastInsertRowid;
    return this.log(incidentId).find((x) => x.id === Number(id))!;
  }

  /**
   * Retention: clear the details of next of kin and reporting persons, and the call notes about
   * them, once their incident has been closed for `days`. The entries stay, marked removed, so
   * the timeline still shows that a call happened.
   */
  redactPrivate(days: number): number {
    if (days <= 0) return 0;
    const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
    const roles = PRIVATE_CONTACT_ROLES.map((r) => `'${r}'`).join(',');
    const ids = this.db.all<{ id: number }>(
      `SELECT c.id FROM incident_contacts c JOIN incidents i ON i.id = c.incident_id WHERE c.role IN (${roles}) AND c.redacted_at IS NULL AND i.ended_at IS NOT NULL AND i.ended_at < ?`, cutoff).map((r) => r.id);
    const t = now();
    this.db.tx(() => {
      for (const id of ids) {
        this.db.run("UPDATE incident_contacts SET name = '(removed)', organisation = NULL, phone = NULL, reference = NULL, notes = NULL, redacted_at = ? WHERE id = ?", t, id);
        this.db.run("UPDATE contact_log SET text = '(removed under the retention policy)' WHERE contact_id = ?", id);
      }
    });
    return ids.length;
  }
}

/** The directory holds agencies and units; private people are only ever added to an incident. */
function stationRole(v: unknown): ContactRole {
  const r = role(v);
  if (PRIVATE_CONTACT_ROLES.includes(r)) throw new Error('the station directory is for agencies and units: add next of kin to the incident');
  return r;
}

/** Fields the caller actually sent, so a directory copy only overrides what was typed. */
function strip(input: ContactInput): ContactInput {
  return Object.fromEntries(Object.entries(input).filter(([k, v]) => v !== undefined && k !== 'directoryId')) as ContactInput;
}
