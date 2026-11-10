import { CONTACT_ROLE_LABEL, FIND_LABEL, type ContactRole, type FindType } from '../../../shared/types.js';
import type { ConditionsSnapshot, DashboardData, IncidentReplay, IncidentSummary, ReplayEvent, ReplayFix, TeamMembership } from '../../../shared/types.js';
import type { Users } from '../auth/users.js';
import { now, type Db } from '../db/index.js';

/**
 * History of past incidents: summaries for the list, a replay bundle (fixes + timeline),
 * and the conditions snapshots taken when an incident opens and closes.
 */

const MAX_REPLAY_FIXES = 30_000;

export function listSummaries(db: Db, limit = 100): IncidentSummary[] {
  return db
    .all<{ id: string; kind: 'callout' | 'tasking'; text: string; started_at: string; ended_at: string | null; end_reason: string | null; responders: number; teams: number; targets: number; fixes: number }>(
      `SELECT i.id, i.kind, i.text, i.started_at, i.ended_at, i.end_reason,
         (SELECT COUNT(*) FROM responses r WHERE r.incident_id = i.id AND r.status IN ('responding','on-scene','stood-down')) AS responders,
         (SELECT COUNT(*) FROM teams t WHERE t.incident_id = i.id) AS teams,
         (SELECT COUNT(*) FROM targets g WHERE g.incident_id = i.id AND g.status <> 'cancelled') AS targets,
         (SELECT COUNT(*) FROM positions p WHERE p.incident_id = i.id) AS fixes
       FROM incidents i ORDER BY i.started_at DESC LIMIT ?`,
      Math.min(Math.max(limit, 1), 500),
    )
    .map((r) => ({ id: r.id, kind: r.kind ?? 'callout', text: r.text, startedAt: r.started_at, endedAt: r.ended_at ?? undefined, endReason: r.end_reason ?? undefined, responders: r.responders, teams: r.teams, targets: r.targets, fixes: r.fixes }));
}

/** Record what the weather, sea and tide looked like at this moment for the incident record. */
export function snapshotConditions(db: Db, incidentId: string, phase: 'start' | 'end', data: Readonly<DashboardData>): ConditionsSnapshot {
  const w = data.weather?.now;
  const o = data.observed;
  const sea = data.sea?.local ?? data.sea?.model ?? data.sea?.offshore;
  const t = data.tide;
  const s = data.sun;
  const snap: ConditionsSnapshot = {
    phase,
    at: now(),
    wind: w ? { speedKt: w.wind.speedKt, gustKt: w.wind.gustKt, dirName: w.wind.dirName, beaufort: w.wind.beaufort } : undefined,
    observed: o ? { stationName: o.stationName, time: o.time, speedKt: o.wind.speedKt, gustKt: o.wind.gustKt, dirName: o.wind.dirName, tempC: o.tempC, pressureHpa: o.pressureHpa } : undefined,
    visibility: w?.visibility ? `${w.visibility.label} (${w.visibility.band}, est.)` : undefined,
    precipMm: w?.precipMm,
    tempC: w?.tempC,
    pressureHpa: w?.pressureHpa ?? o?.pressureHpa,
    symbol: w?.symbol,
    sea: sea ? { source: sea.source, hsM: sea.hsM, periodS: sea.periodS, seaTempC: sea.seaTempC, gale: sea.gale } : undefined,
    tide: t ? { heightM: t.observedM ?? t.predictedNowM, rising: t.rising, next: t.next ? { kind: t.next.kind, time: t.next.time, heightM: t.next.heightM } : undefined, springNeap: t.springNeap as string | undefined } : undefined,
    sun: s ? { sunrise: s.sunrise, sunset: s.sunset, civilDusk: s.civilDusk, isDaylight: s.isDaylight, daylightRemainingMin: s.daylightRemainingMin } : undefined,
    warnings: (data.warnings?.active ?? []).map((x) => `${x.level.toUpperCase()} ${x.headline}`),
  };
  db.run('INSERT INTO incident_conditions (incident_id, phase, at, data) VALUES (?, ?, ?, ?)', incidentId, phase, snap.at, JSON.stringify(snap));
  return snap;
}

export function conditionsFor(db: Db, incidentId: string): ConditionsSnapshot[] {
  return db.all<{ data: string }>('SELECT data FROM incident_conditions WHERE incident_id = ? ORDER BY at', incidentId).map((r) => JSON.parse(r.data) as ConditionsSnapshot);
}

export function membershipsFor(db: Db, incidentId: string): Map<number, TeamMembership[]> {
  const rows = db.all<{ team_id: number; user_id: number; position: number; joined_at: string; left_at: string | null; name: string; team_name: string }>(
    'SELECT tm.team_id, tm.user_id, tm.position, tm.joined_at, tm.left_at, u.name, t.name AS team_name FROM team_members tm JOIN teams t ON t.id = tm.team_id JOIN users u ON u.id = tm.user_id WHERE t.incident_id = ? ORDER BY tm.joined_at',
    incidentId,
  );
  const m = new Map<number, TeamMembership[]>();
  for (const r of rows) {
    const arr = m.get(r.team_id) ?? [];
    arr.push({ userId: r.user_id, name: r.name, callsign: `${r.team_name}-${r.position}`, joinedAt: r.joined_at, leftAt: r.left_at ?? undefined });
    m.set(r.team_id, arr);
  }
  return m;
}

/** Fixes in time order, thinned evenly if there are too many for the browser. */
export function fixesFor(db: Db, incidentId: string): ReplayFix[] {
  const n = db.get<{ n: number }>('SELECT COUNT(*) n FROM positions WHERE incident_id = ?', incidentId)?.n ?? 0;
  const step = Math.max(1, Math.ceil(n / MAX_REPLAY_FIXES));
  const rows = db.all<{ user_id: number; team_id: number | null; tst: number; lat: number; lon: number }>('SELECT user_id, team_id, tst, lat, lon FROM positions WHERE incident_id = ? AND user_id IS NOT NULL ORDER BY tst', incidentId);
  const out: ReplayFix[] = [];
  for (let i = 0; i < rows.length; i += step) out.push({ u: rows[i].user_id, t: rows[i].tst, lat: rows[i].lat, lon: rows[i].lon, team: rows[i].team_id });
  return out;
}

interface AuditRow { at: string; actor_user_id: number | null; action: string; target_type: string | null; target_id: string | null; detail: string | null }

/** Human timeline: responses, teams, targets, planning point, open/close. */
export function eventsFor(db: Db, incidentId: string, users: Users): ReplayEvent[] {
  const who = (id: number | null | undefined) => (id ? (users.byId(id)?.name ?? `user ${id}`) : 'system');
  const teamIds = db.all<{ id: number; name: string }>('SELECT id, name FROM teams WHERE incident_id = ?', incidentId);
  const targetIds = db.all<{ id: number; name: string }>('SELECT id, name FROM targets WHERE incident_id = ?', incidentId);
  const teamName = new Map(teamIds.map((t) => [String(t.id), t.name]));
  const targetName = new Map(targetIds.map((t) => [String(t.id), t.name]));
  const events: ReplayEvent[] = [];
  for (const r of db.all<{ user_id: number; status: string; eta_min: number | null; at: string }>('SELECT user_id, status, eta_min, at FROM response_events WHERE incident_id = ? ORDER BY at', incidentId)) {
    events.push({ at: r.at, kind: 'response', text: `${who(r.user_id)}: ${r.status}${r.eta_min ? ` (ETA ${r.eta_min} min)` : ''}` });
  }
  const audit = db.all<AuditRow>(
    `SELECT at, actor_user_id, action, target_type, target_id, detail FROM audit_log
     WHERE (target_type = 'incident' AND target_id = ?) OR (target_type = 'team' AND target_id IN (SELECT CAST(id AS TEXT) FROM teams WHERE incident_id = ?)) OR (target_type = 'target' AND target_id IN (SELECT CAST(id AS TEXT) FROM targets WHERE incident_id = ?))
     ORDER BY at`,
    incidentId, incidentId, incidentId,
  );
  for (const a of audit) {
    let d: Record<string, unknown> = {};
    try { d = a.detail ? JSON.parse(a.detail) : {}; } catch { /* ignore */ }
    const actor = who(a.actor_user_id);
    const t = (a.target_type === 'team' ? teamName.get(a.target_id ?? '') : a.target_type === 'target' ? targetName.get(a.target_id ?? '') : undefined) ?? '';
    const text: string | undefined = {
      'incident.started': `${actor} started the ${d.kind ?? 'incident'}`,
      'incident.closed': `${actor} closed the ${d.kind ?? 'incident'}`,
      'callout.started': `Callout received`,
      'callout.standdown': `Stand down`,
      'incident.ipp': d.cleared ? `${actor} cleared the planning point` : `${actor} set the planning point`,
      'point.set': d.kind === 'find' ? `${actor} reported a find: ${FIND_LABEL[d.find as FindType] ?? 'find'}` : `${actor} set a ${String(d.kind ?? 'point').toUpperCase()} point`,
      'point.deleted': `${actor} removed a ${String(d.kind ?? 'point').toUpperCase()} point`,
      'team.created': `${actor} created team ${d.name ?? t}`,
      'team.updated': `${actor} updated team ${t}${d.searchWidthM ? ` (sweep ${d.searchWidthM} m)` : ''}${d.status ? ` → ${d.status}` : ''}`,
      'team.members': `${actor} set ${t} members`,
      'team.deleted': `${actor} deleted team ${t}`,
      'target.created': `${actor} created target ${d.name ?? t} (${d.kind ?? ''})`,
      'target.updated': d.by === 'crew' ? `${actor} ${d.status === 'done' ? 'finished searching' : 'started searching'} ${t}` : `${actor} updated target ${t}${d.status ? ` → ${d.status}` : ''}`,
      'target.deleted': `${actor} deleted target ${t}`,
      'subject.updated': `${actor} updated subject details`,
      'subject.photo': `${actor} added a subject photo`,
    }[a.action];
    if (text) events.push({ at: a.at, kind: a.action.split('.')[0], text });
  }
  // the call log, from its own table so retention's clearing shows here too
  for (const c of db.all<{ at: string; direction: string; text: string; by_user: number | null; name: string | null; role: ContactRole | null }>(
    'SELECT l.at, l.direction, l.text, l.by_user, c.name, c.role FROM contact_log l LEFT JOIN incident_contacts c ON c.id = l.contact_id WHERE l.incident_id = ? ORDER BY l.at', incidentId)) {
    const them = c.name ? `${c.name}${c.role ? ` (${CONTACT_ROLE_LABEL[c.role]})` : ''}` : '';
    const lead = c.direction === 'in' ? `${who(c.by_user)} took a call${them ? ` from ${them}` : ''}` : c.direction === 'out' ? `${who(c.by_user)} called${them ? ` ${them}` : ''}` : `${who(c.by_user)} noted${them ? ` (${them})` : ''}`;
    events.push({ at: c.at, kind: 'contact', text: `${lead}: ${c.text}` });
  }
  return events.sort((x, y) => x.at.localeCompare(y.at));
}

export function usersIndex(users: Users, ids: Iterable<number>): Record<number, { name: string; callsign?: string }> {
  const out: Record<number, { name: string; callsign?: string }> = {};
  for (const id of new Set(ids)) {
    const u = users.byId(id);
    out[id] = { name: u?.name ?? `user ${id}`, callsign: u?.callsign ?? undefined };
  }
  return out;
}

export type ReplayParts = Omit<IncidentReplay, 'incident' | 'teams' | 'targets' | 'responders'> & { memberships: Map<number, TeamMembership[]> };

export function replayParts(db: Db, incidentId: string, users: Users, responderIds: number[]): ReplayParts {
  const fixes = fixesFor(db, incidentId);
  const memberships = membershipsFor(db, incidentId);
  const ids = [...responderIds, ...fixes.map((f) => f.u), ...[...memberships.values()].flat().map((m) => m.userId)];
  return { memberships, users: usersIndex(users, ids), fixes, events: eventsFor(db, incidentId, users), conditions: conditionsFor(db, incidentId) };
}
