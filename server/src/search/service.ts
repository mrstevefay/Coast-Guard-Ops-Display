import { EventEmitter } from 'node:events';
import type { Fix, ModeState, MusterState, ResponderRow, ResponseStatus, SearchIncident, SearchSnapshot, Target, TargetKind, TargetStatus, Team, TeamMember, TeamStatus } from '../../../shared/types.js';
import type { Users } from '../auth/users.js';
import type { AppConfig } from '../config.js';
import { now, type Db } from '../db/index.js';
import type { StateStore } from '../state.js';
import { validateGeometry } from './geometry.js';
import type { TrackContext, Tracking } from './tracking.js';

interface IncidentRow { id: string; text: string; received_at: string; lat: number | null; lon: number | null; source: string | null; started_at: string; ended_at: string | null; end_reason: string | null }
interface TeamRow { id: number; incident_id: string; name: string; colour: string; search_width_m: number; leader_user_id: number | null; status: TeamStatus; created_at: string }
interface MemberRow { team_id: number; user_id: number; position: number; name: string }
interface TargetRow { id: number; incident_id: string; team_id: number | null; name: string; kind: TargetKind; geometry: string; notes: string | null; status: TargetStatus; priority: number; created_at: string; completed_at: string | null }
interface ResponseRow { user_id: number; status: ResponseStatus; eta_min: number | null; note: string | null; updated_at: string; name: string; callsign: string | null }

const RESPONSE_STATUSES: ResponseStatus[] = ['responding', 'on-scene', 'available', 'unavailable', 'stood-down'];
const TEAM_STATUSES: TeamStatus[] = ['forming', 'tasked', 'searching', 'returned', 'stood-down'];
const TARGET_STATUSES: TargetStatus[] = ['planned', 'assigned', 'in-progress', 'done', 'cancelled'];

/**
 * The search-management domain: incidents (mirroring callout mode), who is
 * responding, teams and callsigns, targets. Emits 'change' whenever the
 * snapshot should be re-sent. Also implements TrackContext for ingest.
 */
export class SearchService extends EventEmitter implements TrackContext {
  constructor(
    private readonly db: Db,
    private readonly cfg: AppConfig,
    private readonly store: StateStore,
    private readonly users: Users,
    private readonly tracking: Tracking,
  ) {
    super();
    store.on('mode', (m: ModeState, prev: ModeState) => this.onMode(m, prev));
    tracking.on('fix', () => this.touchMuster());
    this.reconcile(store.getMode());
  }

  // ------------------------------------------------------------ incidents
  private onMode(m: ModeState, prev: ModeState): void {
    if (m.mode === 'callout' && m.incident) {
      if (!this.db.get('SELECT 1 FROM incidents WHERE id = ?', m.incident.id)) {
        // close anything still open, then open this one
        this.closeOpen('superseded');
        this.db.run('INSERT INTO incidents (id, text, received_at, lat, lon, source, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)', m.incident.id, m.incident.text, m.incident.receivedAt, m.incident.lat ?? null, m.incident.lon ?? null, m.incident.source, now());
      }
    } else if (m.mode === 'standby' && prev?.mode === 'callout') {
      this.closeOpen('standdown');
    }
    this.changed();
  }

  /** On startup, bring the DB in line with the persisted display mode. */
  private reconcile(m: ModeState): void {
    const open = this.openIncident();
    if (m.mode === 'callout' && m.incident) {
      if (!open || open.id !== m.incident.id) this.onMode(m, { mode: 'standby', changedAt: now() });
    } else if (open) {
      this.closeOpen('restart-standby');
    }
  }

  private closeOpen(reason: string): void {
    const t = now();
    this.db.tx(() => {
      const open = this.openIncident();
      if (!open) return;
      this.db.run('UPDATE incidents SET ended_at = ?, end_reason = ? WHERE id = ?', t, reason, open.id);
      this.db.run("UPDATE teams SET status = 'stood-down', updated_at = ? WHERE incident_id = ? AND status <> 'stood-down'", t, open.id);
    });
  }

  openIncident(): IncidentRow | undefined {
    return this.db.get<IncidentRow>('SELECT * FROM incidents WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1');
  }

  incidentById(id: string): IncidentRow | undefined {
    return this.db.get<IncidentRow>('SELECT * FROM incidents WHERE id = ?', id);
  }

  listIncidents(limit = 50): SearchIncident[] {
    return this.db.all<IncidentRow>('SELECT * FROM incidents ORDER BY started_at DESC LIMIT ?', Math.min(limit, 500)).map(toIncident);
  }

  // ------------------------------------------------------------ responses
  setResponse(incidentId: string, userId: number, status: ResponseStatus, etaMin?: number, note?: string): ResponderRow {
    if (!RESPONSE_STATUSES.includes(status)) throw new Error('invalid status');
    this.requireOpen(incidentId);
    const t = now();
    this.db.run(
      `INSERT INTO responses (incident_id, user_id, status, eta_min, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(incident_id, user_id) DO UPDATE SET status = excluded.status, eta_min = excluded.eta_min, note = excluded.note, updated_at = excluded.updated_at`,
      incidentId, userId, status, etaMin ?? null, note?.slice(0, 200) ?? null, t, t,
    );
    this.changed();
    return this.responders(incidentId).find((r) => r.userId === userId)!;
  }

  responders(incidentId: string): ResponderRow[] {
    const members = this.memberIndex(incidentId);
    return this.db
      .all<ResponseRow>('SELECT r.user_id, r.status, r.eta_min, r.note, r.updated_at, u.name, u.callsign FROM responses r JOIN users u ON u.id = r.user_id WHERE r.incident_id = ? ORDER BY r.updated_at', incidentId)
      .map((r) => {
        const m = members.get(r.user_id);
        return { userId: r.user_id, name: r.name, callsign: r.callsign ?? undefined, status: r.status, etaMin: r.eta_min ?? undefined, note: r.note ?? undefined, updatedAt: r.updated_at, teamId: m?.teamId, teamCallsign: m?.callsign };
      });
  }

  // ------------------------------------------------------------ teams
  createTeam(incidentId: string, name?: string): Team {
    this.requireOpen(incidentId);
    const existing = this.db.all<{ name: string }>('SELECT name FROM teams WHERE incident_id = ?', incidentId).map((r) => r.name);
    let teamName = name?.trim();
    if (!teamName) teamName = this.cfg.search.teamNames.find((n) => !existing.includes(n)) ?? `Team ${existing.length + 1}`;
    if (existing.includes(teamName)) throw new Error(`team ${teamName} already exists`);
    const idx = this.cfg.search.teamNames.indexOf(teamName);
    const colour = this.cfg.search.teamColours[(idx >= 0 ? idx : existing.length) % this.cfg.search.teamColours.length];
    const t = now();
    const r = this.db.run('INSERT INTO teams (incident_id, name, colour, search_width_m, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', incidentId, teamName, colour, this.cfg.search.defaultSearchWidthM, t, t);
    this.changed();
    return this.team(r.lastInsertRowid)!;
  }

  updateTeam(id: number, patch: { name?: string; colour?: string; searchWidthM?: number; status?: TeamStatus; leaderUserId?: number | null }): Team {
    const tr = this.teamRow(id);
    if (!tr) throw new Error('team not found');
    if (patch.status && !TEAM_STATUSES.includes(patch.status)) throw new Error('invalid status');
    if (patch.searchWidthM !== undefined && !(patch.searchWidthM >= 1 && patch.searchWidthM <= 200)) throw new Error('search width must be 1–200 m');
    if (patch.colour !== undefined && !/^#[0-9a-fA-F]{6}$/.test(patch.colour)) throw new Error('colour must be #rrggbb');
    const name = patch.name?.trim() || tr.name;
    this.db.tx(() => {
      this.db.run('UPDATE teams SET name = ?, colour = ?, search_width_m = ?, status = ?, updated_at = ? WHERE id = ?', name, patch.colour ?? tr.colour, patch.searchWidthM ?? tr.search_width_m, patch.status ?? tr.status, now(), id);
      if (patch.leaderUserId !== undefined) this.setLeader(id, patch.leaderUserId);
    });
    this.changed();
    return this.team(id)!;
  }

  deleteTeam(id: number): void {
    if (!this.teamRow(id)) throw new Error('team not found');
    this.db.tx(() => {
      this.db.run('UPDATE targets SET team_id = NULL WHERE team_id = ?', id);
      this.db.run('DELETE FROM teams WHERE id = ?', id);
    });
    this.changed();
  }

  /** Full-replace membership. Leader gets position 0; others keep their number if already in; new ones append. */
  setMembers(teamId: number, userIds: number[], leaderUserId?: number | null): Team {
    const tr = this.teamRow(teamId);
    if (!tr) throw new Error('team not found');
    const ids = [...new Set(userIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    for (const uid of ids) if (!this.users.byId(uid)) throw new Error(`user ${uid} not found`);
    const leader = leaderUserId === undefined ? (tr.leader_user_id && ids.includes(tr.leader_user_id) ? tr.leader_user_id : null) : leaderUserId;
    if (leader && !ids.includes(leader)) throw new Error('leader must be a member');
    const t = now();
    this.db.tx(() => {
      const current = this.db.all<{ user_id: number; position: number }>('SELECT user_id, position FROM team_members WHERE team_id = ? AND left_at IS NULL', teamId);
      const curMap = new Map(current.map((c) => [c.user_id, c.position]));
      // leave this team
      for (const c of current) if (!ids.includes(c.user_id)) this.db.run('UPDATE team_members SET left_at = ? WHERE team_id = ? AND user_id = ?', t, teamId, c.user_id);
      // leave other teams in this incident
      for (const uid of ids) this.db.run('UPDATE team_members SET left_at = ? WHERE user_id = ? AND team_id <> ? AND left_at IS NULL AND team_id IN (SELECT id FROM teams WHERE incident_id = ?)', t, uid, teamId, tr.incident_id);
      // assign numbers: leader 0, existing keep theirs (unless they were 0 and are no longer leader), new get next free
      const used = new Set<number>();
      const assign = new Map<number, number>();
      if (leader) { assign.set(leader, 0); used.add(0); }
      for (const uid of ids) {
        if (assign.has(uid)) continue;
        const prev = curMap.get(uid);
        if (prev !== undefined && prev !== 0 && !used.has(prev)) { assign.set(uid, prev); used.add(prev); }
      }
      let next = 1;
      for (const uid of ids) {
        if (assign.has(uid)) continue;
        while (used.has(next)) next++;
        assign.set(uid, next);
        used.add(next);
      }
      for (const [uid, pos] of assign) {
        this.db.run('DELETE FROM team_members WHERE team_id = ? AND user_id = ?', teamId, uid);
        this.db.run('INSERT INTO team_members (team_id, user_id, position, joined_at) VALUES (?, ?, ?, ?)', teamId, uid, pos, t);
      }
      this.db.run('UPDATE teams SET leader_user_id = ?, updated_at = ? WHERE id = ?', leader ?? null, t, teamId);
      // anyone assigned to a team is at least "responding"
      for (const uid of ids) {
        this.db.run(
          `INSERT INTO responses (incident_id, user_id, status, created_at, updated_at) VALUES (?, ?, 'responding', ?, ?)
           ON CONFLICT(incident_id, user_id) DO NOTHING`,
          tr.incident_id, uid, t, t,
        );
      }
    });
    this.changed();
    return this.team(teamId)!;
  }

  private setLeader(teamId: number, leaderUserId: number | null): void {
    const members = this.db.all<{ user_id: number }>('SELECT user_id FROM team_members WHERE team_id = ? AND left_at IS NULL ORDER BY position', teamId).map((m) => m.user_id);
    this.setMembers(teamId, members, leaderUserId);
  }

  teams(incidentId: string): Team[] {
    const rows = this.db.all<TeamRow>('SELECT * FROM teams WHERE incident_id = ? ORDER BY created_at', incidentId);
    const members = this.db.all<MemberRow>(
      'SELECT tm.team_id, tm.user_id, tm.position, u.name FROM team_members tm JOIN teams t ON t.id = tm.team_id JOIN users u ON u.id = tm.user_id WHERE t.incident_id = ? AND tm.left_at IS NULL ORDER BY tm.position',
      incidentId,
    );
    return rows.map((r) => ({
      id: r.id,
      incidentId: r.incident_id,
      name: r.name,
      colour: r.colour,
      searchWidthM: r.search_width_m,
      status: r.status,
      leaderUserId: r.leader_user_id ?? undefined,
      createdAt: r.created_at,
      members: members.filter((m) => m.team_id === r.id).map((m): TeamMember => ({ userId: m.user_id, name: m.name, position: m.position, callsign: `${r.name}-${m.position}` })),
    }));
  }

  team(id: number): Team | undefined {
    const tr = this.teamRow(id);
    return tr ? this.teams(tr.incident_id).find((t) => t.id === id) : undefined;
  }

  private teamRow(id: number): TeamRow | undefined {
    return this.db.get<TeamRow>('SELECT * FROM teams WHERE id = ?', id);
  }

  /** userId → { teamId, callsign } for the incident's active memberships. */
  private memberIndex(incidentId: string): Map<number, { teamId: number; callsign: string }> {
    const m = new Map<number, { teamId: number; callsign: string }>();
    for (const t of this.teams(incidentId)) for (const mem of t.members) m.set(mem.userId, { teamId: t.id, callsign: mem.callsign });
    return m;
  }

  // ------------------------------------------------------------ targets
  createTarget(incidentId: string, input: { name?: string; kind: TargetKind; geometry: unknown; notes?: string; priority?: number; teamId?: number | null }, createdBy?: number): Target {
    this.requireOpen(incidentId);
    if (!['point', 'area', 'line'].includes(input.kind)) throw new Error('kind must be point, area or line');
    const geometry = validateGeometry(input.geometry, input.kind);
    if (input.teamId) this.requireTeamIn(input.teamId, incidentId);
    const n = (this.db.get<{ n: number }>('SELECT COUNT(*) n FROM targets WHERE incident_id = ?', incidentId)?.n ?? 0) + 1;
    const name = input.name?.trim() || `T${n}`;
    const t = now();
    const r = this.db.run(
      'INSERT INTO targets (incident_id, team_id, name, kind, geometry, notes, status, priority, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      incidentId, input.teamId ?? null, name, input.kind, JSON.stringify(geometry), input.notes?.slice(0, 500) ?? null, input.teamId ? 'assigned' : 'planned', clampPriority(input.priority), createdBy ?? null, t, t,
    );
    this.changed();
    return this.target(r.lastInsertRowid)!;
  }

  updateTarget(id: number, patch: { name?: string; geometry?: unknown; notes?: string; status?: TargetStatus; priority?: number; teamId?: number | null }): Target {
    const tr = this.db.get<TargetRow>('SELECT * FROM targets WHERE id = ?', id);
    if (!tr) throw new Error('target not found');
    if (patch.status && !TARGET_STATUSES.includes(patch.status)) throw new Error('invalid status');
    if (patch.teamId) this.requireTeamIn(patch.teamId, tr.incident_id);
    const geometry = patch.geometry !== undefined ? JSON.stringify(validateGeometry(patch.geometry, tr.kind)) : tr.geometry;
    let status = patch.status ?? tr.status;
    const teamId = patch.teamId === undefined ? tr.team_id : patch.teamId;
    if (patch.teamId !== undefined && !patch.status) status = teamId ? (status === 'planned' ? 'assigned' : status) : status === 'assigned' ? 'planned' : status;
    const t = now();
    this.db.run(
      'UPDATE targets SET name = ?, geometry = ?, notes = ?, status = ?, priority = ?, team_id = ?, updated_at = ?, completed_at = ? WHERE id = ?',
      patch.name?.trim() || tr.name, geometry, patch.notes === undefined ? tr.notes : patch.notes.slice(0, 500), status, patch.priority === undefined ? tr.priority : clampPriority(patch.priority), teamId, t,
      status === 'done' ? (tr.completed_at ?? t) : null, id,
    );
    this.changed();
    return this.target(id)!;
  }

  deleteTarget(id: number): void {
    if (this.db.run('DELETE FROM targets WHERE id = ?', id).changes === 0) throw new Error('target not found');
    this.changed();
  }

  targets(incidentId: string): Target[] {
    return this.db.all<TargetRow>('SELECT * FROM targets WHERE incident_id = ? ORDER BY priority, created_at', incidentId).map(toTarget);
  }

  target(id: number): Target | undefined {
    const r = this.db.get<TargetRow>('SELECT * FROM targets WHERE id = ?', id);
    return r ? toTarget(r) : undefined;
  }

  // ------------------------------------------------------------ snapshot
  snapshot(): SearchSnapshot {
    const inc = this.openIncident();
    if (!inc) return { responders: [], teams: [], targets: [], latest: {}, updatedAt: now() };
    const members = this.memberIndex(inc.id);
    const latest: Record<number, Fix> = {};
    for (const f of this.tracking.all()) {
      const m = members.get(f.userId);
      latest[f.userId] = { ...f, teamId: m?.teamId, callsign: m?.callsign ?? f.callsign };
    }
    return { incident: toIncident(inc), responders: this.responders(inc.id), teams: this.teams(inc.id), targets: this.targets(inc.id), latest, updatedAt: now() };
  }

  // ------------------------------------------------------------ TrackContext
  current(userId: number): { incidentId?: string; teamId?: number; callsign?: string } | undefined {
    const inc = this.openIncident();
    if (!inc) return undefined;
    const m = this.memberIndex(inc.id).get(userId);
    if (m) return { incidentId: inc.id, teamId: m.teamId, callsign: m.callsign };
    const resp = this.db.get<{ status: ResponseStatus }>('SELECT status FROM responses WHERE incident_id = ? AND user_id = ?', inc.id, userId);
    if (resp && (resp.status === 'responding' || resp.status === 'on-scene')) return { incidentId: inc.id };
    return undefined;
  }

  // ------------------------------------------------------------ muster bridge
  /** Feed the existing TV muster panel from responses/teams. */
  musterState(): MusterState {
    const inc = this.openIncident();
    const responders = inc ? this.responders(inc.id) : [];
    const teams = inc ? this.teams(inc.id) : [];
    const roles: Record<string, string[]> = {};
    for (const t of teams) roles[t.name] = t.members.map((m) => String(m.userId));
    return {
      responders: responders.map((r) => ({
        id: String(r.userId),
        name: r.teamCallsign ? `${r.teamCallsign} ${r.name}` : r.name,
        status: r.status === 'stood-down' ? 'unavailable' : r.status,
        etaMin: r.etaMin,
        roles: r.teamId ? [teams.find((t) => t.id === r.teamId)!.name] : [],
        updatedAt: r.updatedAt,
        source: 'app',
      })),
      roles,
      minimumCrew: this.cfg.providers.muster.minimumCrew,
      requiredRoles: teams.length ? teams.map((t) => t.name) : this.cfg.providers.muster.requiredRoles,
      source: 'app',
      updatedAt: now(),
    };
  }

  private musterTimer?: NodeJS.Timeout;
  private touchMuster(): void {
    /* positions alone don't change the muster panel; hook kept for later */
  }

  private disposed = false;
  private changed(): void {
    if (this.disposed) return;
    this.emit('change');
    if (this.musterTimer) return;
    this.musterTimer = setTimeout(() => {
      this.musterTimer = undefined;
      if (this.disposed) return;
      try {
        this.store.merge({ muster: this.musterState() });
      } catch {
        /* DB closed during shutdown */
      }
    }, 100);
    this.musterTimer.unref?.();
  }

  /** Stop timers and listeners (server shutdown / tests) before the DB is closed. */
  dispose(): void {
    this.disposed = true;
    if (this.musterTimer) clearTimeout(this.musterTimer);
    this.musterTimer = undefined;
    this.removeAllListeners();
  }

  private requireOpen(incidentId: string): IncidentRow {
    const inc = this.openIncident();
    if (!inc || inc.id !== incidentId) throw new Error('incident is not open');
    return inc;
  }

  private requireTeamIn(teamId: number, incidentId: string): void {
    const t = this.teamRow(teamId);
    if (!t || t.incident_id !== incidentId) throw new Error('team not in this incident');
  }
}

function clampPriority(p: number | undefined): number {
  const n = Number(p ?? 2);
  return Number.isFinite(n) ? Math.min(3, Math.max(1, Math.round(n))) : 2;
}

function toIncident(r: IncidentRow): SearchIncident {
  return { id: r.id, text: r.text, receivedAt: r.received_at, lat: r.lat ?? undefined, lon: r.lon ?? undefined, source: r.source ?? undefined, startedAt: r.started_at, endedAt: r.ended_at ?? undefined };
}

function toTarget(r: TargetRow): Target {
  return { id: r.id, incidentId: r.incident_id, teamId: r.team_id ?? undefined, name: r.name, kind: r.kind, geometry: JSON.parse(r.geometry), notes: r.notes ?? undefined, status: r.status, priority: r.priority, createdAt: r.created_at, completedAt: r.completed_at ?? undefined };
}
