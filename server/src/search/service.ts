import { splitTeams } from '../../../shared/teamsplit.js';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { FIND_LABEL, FIND_TYPES, FOUND_BY_LABEL, FOUND_LOCATIONS, OUTCOME_KINDS, PRIVATE_POINT_KINDS, type FindType, type FoundBy, type FoundLocation, type IncidentOutcome, type OutcomeKind, type TargetCoverage } from '../../../shared/types.js';
import { coverageFromTracks, distanceM } from '../../../shared/searchtheory.js';
import type { Fix, IncidentKind, IncidentReplay, IncidentSummary, ModeState, MusterState, ResponderRow, ResponseStatus, SearchIncident, SearchSnapshot, Target, TargetKind, TargetStatus, Team, TeamMember, TeamStatus } from '../../../shared/types.js';
import type { Users } from '../auth/users.js';
import type { AppConfig } from '../config.js';
import { now, type Db } from '../db/index.js';
import type { StateStore } from '../state.js';
import { validateGeometry } from './geometry.js';
import { listSummaries, replayParts, snapshotConditions } from './history.js';
import { buildReport, renderReportHtml, type IncidentReport } from './report.js';
import { Points } from './points.js';
import { Contacts } from './contacts.js';
import { Subjects } from './subject.js';
import type { TrackContext, Tracking } from './tracking.js';

interface IncidentRow { id: string; kind: IncidentKind; text: string; received_at: string; lat: number | null; lon: number | null; source: string | null; started_at: string; ended_at: string | null; end_reason: string | null; ipp_lat: number | null; ipp_lon: number | null; ipp_label: string | null; ipp_set_at: string | null }
interface TeamRow { id: number; incident_id: string; name: string; colour: string; search_width_m: number; leader_user_id: number | null; status: TeamStatus; created_at: string }
interface MemberRow { team_id: number; user_id: number; position: number; name: string; sm_qualified: number }
interface TargetRow { id: number; incident_id: string; team_id: number | null; name: string; kind: TargetKind; geometry: string; notes: string | null; status: TargetStatus; priority: number; created_at: string; completed_at: string | null; segment_id: string | null; pod: number | null }
interface ResponseRow { user_id: number; status: ResponseStatus; eta_min: number | null; note: string | null; updated_at: string; name: string; callsign: string | null; sm_qualified: number }

const RESPONSE_STATUSES: ResponseStatus[] = ['responding', 'on-scene', 'available', 'unavailable', 'stood-down'];
const TEAM_STATUSES: TeamStatus[] = ['forming', 'tasked', 'searching', 'returned', 'stood-down'];
const TARGET_STATUSES: TargetStatus[] = ['planned', 'assigned', 'in-progress', 'done', 'cancelled'];

/**
 * The search-management domain: incidents (mirroring callout mode), who is
 * responding, teams and callsigns, targets. Emits 'change' whenever the
 * snapshot should be re-sent. Also implements TrackContext for ingest.
 */
export class SearchService extends EventEmitter implements TrackContext {
  readonly subjects: Subjects;
  readonly points: Points;
  readonly contacts: Contacts;

  constructor(
    private readonly db: Db,
    private readonly cfg: AppConfig,
    private readonly store: StateStore,
    private readonly users: Users,
    private readonly tracking: Tracking,
  ) {
    super();
    this.subjects = new Subjects(db, path.join(cfg.server.dataDir, 'subjects'));
    this.points = new Points(db);
    this.contacts = new Contacts(db);
    store.on('mode', (m: ModeState, prev: ModeState) => this.onMode(m, prev));
    tracking.on('fix', () => this.touchMuster());
    this.reconcile(store.getMode());
  }

  // ------------------------------------------------------------ incidents
  private onMode(m: ModeState, prev: ModeState): void {
    if (m.mode === 'callout' && m.incident) {
      if (!this.db.get('SELECT 1 FROM incidents WHERE id = ?', m.incident.id)) {
        // close anything still open (a callout supersedes a tasking), then open this one
        this.closeOpen('superseded');
        this.db.run("INSERT INTO incidents (id, kind, text, received_at, lat, lon, source, started_at) VALUES (?, 'callout', ?, ?, ?, ?, ?, ?)", m.incident.id, m.incident.text, m.incident.receivedAt, m.incident.lat ?? null, m.incident.lon ?? null, m.incident.source, now());
        this.recordConditions(m.incident.id, 'start');
      }
    } else if (m.mode === 'standby' && prev?.mode === 'callout') {
      // Stand-down closes the callout only; a tasking opened meanwhile is unaffected.
      this.closeOpen('standdown', prev.incident?.id);
    }
    this.changed();
  }

  /** On startup, bring the DB in line with the persisted display mode. Taskings survive restarts. */
  private reconcile(m: ModeState): void {
    const open = this.openIncident();
    if (m.mode === 'callout' && m.incident) {
      if (!open || open.id !== m.incident.id) this.onMode(m, { mode: 'standby', changedAt: now() });
    } else if (open && open.kind === 'callout') {
      this.closeOpen('restart-standby');
    }
  }

  private closeOpen(reason: string, onlyId?: string): void {
    const t = now();
    this.db.tx(() => {
      const open = this.openIncident();
      if (!open || (onlyId && open.id !== onlyId)) return;
      this.db.run('UPDATE incidents SET ended_at = ?, end_reason = ? WHERE id = ?', t, reason, open.id);
      this.db.run("UPDATE teams SET status = 'stood-down', updated_at = ? WHERE incident_id = ? AND status <> 'stood-down'", t, open.id);
      this.recordConditions(open.id, 'end');
    });
  }

  private recordConditions(incidentId: string, phase: 'start' | 'end'): void {
    try {
      snapshotConditions(this.db, incidentId, phase, this.store.getData());
    } catch {
      /* conditions are best-effort; never block an incident on them */
    }
  }

  /**
   * Open a search without a callout: the display stays in standby and nobody is paged, but
   * responders, teams, targets and tracking all work. Refused while any incident is open.
   */
  startTasking(input: { text: string; lat?: number; lon?: number; label?: string; createdBy?: number }): SearchIncident {
    const text = (input.text ?? '').toString().trim();
    if (!text) throw new Error('title is required');
    const open = this.openIncident();
    if (open) throw new Error(open.kind === 'callout' ? 'a callout is in progress; stand it down first' : 'a tasking is already open; close it first');
    const id = randomUUID();
    const t = now();
    this.db.run("INSERT INTO incidents (id, kind, text, received_at, lat, lon, source, started_at, created_by) VALUES (?, 'tasking', ?, ?, ?, ?, 'app', ?, ?)", id, text.slice(0, 2000), t, finite(input.lat), finite(input.lon), t, input.createdBy ?? null);
    this.recordConditions(id, 'start');
    // A position given when the tasking is opened is where the subject was last known to be.
    const lat = finite(input.lat), lon = finite(input.lon);
    if (lat !== null && lon !== null) this.points.setLkp(id, { lat, lon, label: input.label }, input.createdBy);
    this.changed();
    return toIncident(this.incidentById(id)!, this.subjects, this.points);
  }

  /** Close the open tasking (callouts are closed by stand-down). */
  closeTasking(id: string, reason = 'closed'): void {
    const open = this.openIncident();
    if (!open || open.id !== id) throw new Error('incident is not open');
    if (open.kind !== 'tasking') throw new Error('this is a callout: stand it down instead');
    this.closeOpen(reason, id);
    this.changed();
  }

  /** Set or clear the last known position (the planning point shown on every map). */
  setPlanningPoint(incidentId: string, ipp: { lat: number; lon: number; label?: string } | null, by?: number): SearchIncident {
    this.requireOpen(incidentId);
    this.points.setLkp(incidentId, ipp, by);
    this.changed();
    return this.incident(incidentId)!;
  }

  /** Add a typed point (LKP / PLS replace the existing one). */
  addPoint(incidentId: string, input: Parameters<Points['add']>[1], by?: number) {
    this.requireOpen(incidentId);
    const p = this.points.add(incidentId, input, by);
    this.changed();
    return p;
  }

  updatePoint(id: number, input: Parameters<Points['update']>[1], by?: number) {
    const cur = this.points.get(id);
    if (!cur) throw new Error('point not found');
    this.requireOpen(cur.incidentId);
    const p = this.points.update(id, input, by);
    this.changed();
    return p;
  }

  removePoint(id: number) {
    const cur = this.points.get(id);
    if (!cur) return undefined;
    this.requireOpen(cur.incidentId);
    this.points.remove(id);
    this.changed();
    return cur;
  }

  incident(id: string): SearchIncident | undefined {
    const r = this.incidentById(id);
    return r ? toIncident(r, this.subjects, this.points) : undefined;
  }

  /** Subject details changed: bump the snapshot so phones refetch. */
  /** Contacts or the call log changed: push a snapshot so other consoles refetch them. */
  contactsChanged(): void {
    this.changed();
  }

  subjectChanged(): void {
    this.changed();
  }

  openIncident(): IncidentRow | undefined {
    return this.db.get<IncidentRow>('SELECT * FROM incidents WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1');
  }

  incidentById(id: string): IncidentRow | undefined {
    return this.db.get<IncidentRow>('SELECT * FROM incidents WHERE id = ?', id);
  }

  listIncidents(limit = 50): SearchIncident[] {
    return this.db.all<IncidentRow>('SELECT * FROM incidents ORDER BY started_at DESC LIMIT ?', Math.min(limit, 500)).map((r) => toIncident(r, this.subjects, this.points));
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
    // Full status history for response-time reporting (the responses row only keeps the latest).
    this.db.run('INSERT INTO response_events (incident_id, user_id, status, eta_min, at) VALUES (?, ?, ?, ?, ?)', incidentId, userId, status, etaMin ?? null, t);
    this.changed();
    return this.responders(incidentId).find((r) => r.userId === userId)!;
  }

  // ------------------------------------------------------------ history / replay / report
  history(limit = 100): IncidentSummary[] {
    return listSummaries(this.db, limit);
  }

  replay(incidentId: string): IncidentReplay | undefined {
    const row = this.incidentById(incidentId);
    if (!row) return undefined;
    const responders = this.responders(incidentId);
    const parts = replayParts(this.db, incidentId, this.users, responders.map((r) => r.userId));
    const teams = this.teams(incidentId).map((t) => ({ ...t, memberships: parts.memberships.get(t.id) ?? [] }));
    return { incident: toIncident(row, this.subjects, this.points), teams, targets: this.targets(incidentId), responders, users: parts.users, fixes: parts.fixes, events: parts.events, conditions: parts.conditions };
  }

  report(incidentId: string): { report: IncidentReport; replay: IncidentReplay } | undefined {
    const replay = this.replay(incidentId);
    if (!replay) return undefined;
    const responseEvents = this.db
      .all<{ user_id: number; status: string; eta_min: number | null; at: string }>('SELECT user_id, status, eta_min, at FROM response_events WHERE incident_id = ? ORDER BY at', incidentId)
      .map((e) => ({ userId: e.user_id, status: e.status, etaMin: e.eta_min ?? undefined, at: e.at }));
    const subj = this.subjects.get(incidentId);
    const report = buildReport(replay, { station: this.cfg.station.name, cfg: this.cfg, responseEvents, subject: subj ? { name: subj.name, sex: subj.sex, age: subj.age, category: subj.category, terrain: subj.terrain } : undefined });
    return { report, replay };
  }

  reportHtml(incidentId: string): string | undefined {
    const r = this.report(incidentId);
    return r ? renderReportHtml(r.report, r.replay, this.cfg.station, this.contacts.list(incidentId), this.outcome(incidentId)) : undefined;
  }

  responders(incidentId: string): ResponderRow[] {
    const members = this.memberIndex(incidentId);
    return this.db
      .all<ResponseRow>('SELECT r.user_id, r.status, r.eta_min, r.note, r.updated_at, u.name, u.callsign, u.sm_qualified FROM responses r JOIN users u ON u.id = r.user_id WHERE r.incident_id = ? ORDER BY r.updated_at', incidentId)
      .map((r) => {
        const m = members.get(r.user_id);
        return { userId: r.user_id, name: r.name, callsign: r.callsign ?? undefined, status: r.status, etaMin: r.eta_min ?? undefined, note: r.note ?? undefined, updatedAt: r.updated_at, teamId: m?.teamId, teamCallsign: m?.callsign, ...(r.sm_qualified ? { sm: true } : {}) };
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
    // Sweep width: narrower after sunset (torchlight). Adjustable per team afterwards.
    const daylight = this.store.getData().sun?.isDaylight ?? true;
    const width = daylight ? this.cfg.search.defaultSearchWidthM : this.cfg.search.nightSearchWidthM;
    const r = this.db.run('INSERT INTO teams (incident_id, name, colour, search_width_m, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', incidentId, teamName, colour, width, t, t);
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
    for (const uid of ids) {
      const u = this.users.byId(uid);
      if (!u) throw new Error(`user ${uid} not found`);
      if (u.active !== 1) throw new Error(`${u.name} does not have an active account`);
    }
    const leader = leaderUserId === undefined ? (tr.leader_user_id && ids.includes(tr.leader_user_id) ? tr.leader_user_id : null) : leaderUserId;
    if (leader && !ids.includes(leader)) throw new Error('leader must be a member');
    const t = now();
    this.db.tx(() => {
      const current = this.db.all<{ user_id: number; position: number }>('SELECT user_id, position FROM team_members WHERE team_id = ? AND left_at IS NULL', teamId);
      const curMap = new Map(current.map((c) => [c.user_id, c.position]));
      // leave this team
      for (const c of current) if (!ids.includes(c.user_id)) this.db.run('UPDATE team_members SET left_at = ? WHERE team_id = ? AND user_id = ?', t, teamId, c.user_id);
      // leave other teams in this incident; a team whose leader moved away has no leader until one is chosen
      for (const uid of ids) this.db.run('UPDATE teams SET leader_user_id = NULL, updated_at = ? WHERE incident_id = ? AND id <> ? AND leader_user_id = ?', t, tr.incident_id, teamId, uid);
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

  /**
   * Add people to a team without touching who is already in it (they leave any other team).
   * A team with nobody in it gets a leader: a search-management-qualified person if one is being added.
   */
  addMembers(teamId: number, userIds: number[]): Team {
    const team = this.team(teamId);
    if (!team) throw new Error('team not found');
    const existing = team.members.map((m) => m.userId);
    const fresh = [...new Set(userIds.map(Number))].filter((id) => !existing.includes(id));
    if (!fresh.length) return team;
    const leader = existing.length ? undefined : fresh.find((id) => this.users.byId(id)?.sm_qualified === 1) ?? fresh[0];
    return this.setMembers(teamId, [...existing, ...fresh], leader);
  }

  /** Take one person out of a team; if they led it, it has no leader until one is chosen. */
  removeMember(teamId: number, userId: number): Team {
    const team = this.team(teamId);
    if (!team) throw new Error('team not found');
    if (!team.members.some((m) => m.userId === userId)) return team;
    return this.setMembers(teamId, team.members.filter((m) => m.userId !== userId).map((m) => m.userId), team.leaderUserId === userId ? null : undefined);
  }

  /**
   * Split crew into teams of about `size`: the given users, or everyone responding or on scene who
   * is not in a team. Search-management-qualified crew lead. Empty teams are filled before new ones are made.
   */
  splitIntoTeams(incidentId: string, size: number, userIds?: number[]): Team[] {
    this.requireOpen(incidentId);
    if (!(size >= 1 && size <= 12)) throw new Error('team size must be 1 to 12');
    const inTeam = this.memberIndex(incidentId);
    const waiting = this.responders(incidentId).filter((r) => !inTeam.has(r.userId));
    const wanted = userIds?.length ? new Set(userIds.map(Number)) : undefined;
    const pool = wanted ? [...wanted].filter((id) => !inTeam.has(id)).map((id) => ({ userId: id, sm: this.users.byId(id)?.sm_qualified === 1 })) : waiting.filter((r) => r.status === 'responding' || r.status === 'on-scene').map((r) => ({ userId: r.userId, sm: r.sm }));
    if (!pool.length) throw new Error('nobody is waiting for a team');
    const plan = splitTeams(pool, size);
    const empty = this.teams(incidentId).filter((t) => !t.members.length && t.status === 'forming');
    return plan.map((p) => this.setMembers((empty.shift() ?? this.createTeam(incidentId)).id, p.userIds, p.leaderUserId));
  }

  private setLeader(teamId: number, leaderUserId: number | null): void {
    const members = this.db.all<{ user_id: number }>('SELECT user_id FROM team_members WHERE team_id = ? AND left_at IS NULL ORDER BY position', teamId).map((m) => m.user_id);
    this.setMembers(teamId, members, leaderUserId);
  }

  teams(incidentId: string): Team[] {
    const rows = this.db.all<TeamRow>('SELECT * FROM teams WHERE incident_id = ? ORDER BY created_at', incidentId);
    const members = this.db.all<MemberRow>(
      'SELECT tm.team_id, tm.user_id, tm.position, u.name, u.sm_qualified FROM team_members tm JOIN teams t ON t.id = tm.team_id JOIN users u ON u.id = tm.user_id WHERE t.incident_id = ? AND tm.left_at IS NULL ORDER BY tm.position',
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
      members: members.filter((m) => m.team_id === r.id).map((m): TeamMember => ({ userId: m.user_id, name: m.name, position: m.position, callsign: `${r.name}-${m.position}`, ...(m.sm_qualified ? { sm: true } : {}) })),
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
  createTarget(incidentId: string, input: { name?: string; kind: TargetKind; geometry: unknown; notes?: string; priority?: number; teamId?: number | null; segmentId?: string }, createdBy?: number): Target {
    this.requireOpen(incidentId);
    if (!['point', 'area', 'line'].includes(input.kind)) throw new Error('kind must be point, area or line');
    const geometry = validateGeometry(input.geometry, input.kind);
    if (input.teamId) this.requireTeamIn(input.teamId, incidentId);
    const n = (this.db.get<{ n: number }>('SELECT COUNT(*) n FROM targets WHERE incident_id = ?', incidentId)?.n ?? 0) + 1;
    const name = input.name?.trim() || `T${n}`;
    const t = now();
    const r = this.db.run(
      'INSERT INTO targets (incident_id, team_id, name, kind, geometry, notes, status, priority, created_by, created_at, updated_at, segment_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      incidentId, input.teamId ?? null, name, input.kind, JSON.stringify(geometry), input.notes?.slice(0, 500) ?? null, input.teamId ? 'assigned' : 'planned', clampPriority(input.priority), createdBy ?? null, t, t,
      input.segmentId && /^S\d{1,3}$/.test(input.segmentId) ? input.segmentId : null,
    );
    if (input.teamId) this.syncTeamStatus(input.teamId);
    this.changed();
    if (input.teamId) this.announceTarget(r.lastInsertRowid, name, input.teamId);
    return this.target(r.lastInsertRowid)!;
  }

  /**
   * A team's status follows its targets: a target being searched means searching, one waiting
   * means tasked, all done means returned. Forming and stood-down teams with no live target,
   * and manual changes between target moves, are left alone.
   */
  private syncTeamStatus(teamId: number | null): void {
    if (!teamId) return;
    const tr = this.teamRow(teamId);
    if (!tr || tr.status === 'stood-down') return;
    const st = this.db.all<{ status: TargetStatus }>("SELECT status FROM targets WHERE team_id = ? AND status != 'cancelled'", teamId).map((r) => r.status);
    if (!st.length) return;
    const next: TeamStatus = st.includes('in-progress') ? 'searching' : st.some((x) => x === 'assigned' || x === 'planned') ? 'tasked' : 'returned';
    if (next !== tr.status) this.db.run('UPDATE teams SET status = ?, updated_at = ? WHERE id = ?', next, now(), teamId);
  }

  updateTarget(id: number, patch: { name?: string; geometry?: unknown; notes?: string; status?: TargetStatus; priority?: number; teamId?: number | null; pod?: number | null }): Target {
    const tr = this.db.get<TargetRow>('SELECT * FROM targets WHERE id = ?', id);
    if (!tr) throw new Error('target not found');
    if (patch.status && !TARGET_STATUSES.includes(patch.status)) throw new Error('invalid status');
    if (patch.teamId) this.requireTeamIn(patch.teamId, tr.incident_id);
    const geometry = patch.geometry !== undefined ? JSON.stringify(validateGeometry(patch.geometry, tr.kind)) : tr.geometry;
    let status = patch.status ?? tr.status;
    const teamId = patch.teamId === undefined ? tr.team_id : patch.teamId;
    if (patch.teamId !== undefined && !patch.status) status = teamId ? (status === 'planned' ? 'assigned' : status) : status === 'assigned' ? 'planned' : status;
    if (patch.pod !== undefined && patch.pod !== null && !(Number(patch.pod) >= 0 && Number(patch.pod) <= 1)) throw new Error('pod must be between 0 and 1');
    const pod = patch.pod === undefined ? tr.pod : patch.pod === null ? null : Math.round(Number(patch.pod) * 100) / 100;
    const t = now();
    this.db.run('UPDATE targets SET pod = ? WHERE id = ?', pod, id);
    this.db.run(
      'UPDATE targets SET name = ?, geometry = ?, notes = ?, status = ?, priority = ?, team_id = ?, updated_at = ?, completed_at = ? WHERE id = ?',
      patch.name?.trim() || tr.name, geometry, patch.notes === undefined ? tr.notes : patch.notes.slice(0, 500), status, patch.priority === undefined ? tr.priority : clampPriority(patch.priority), teamId, t,
      status === 'done' ? (tr.completed_at ?? t) : null, id,
    );
    this.syncTeamStatus(teamId);
    if (tr.team_id && tr.team_id !== teamId) this.syncTeamStatus(tr.team_id);
    this.changed();
    if (teamId && teamId !== tr.team_id) this.announceTarget(id, patch.name?.trim() || tr.name, teamId);
    return this.target(id)!;
  }

  /** A team has a new target: tell whoever alerts the crew (push). */
  private announceTarget(targetId: number, targetName: string, teamId: number): void {
    const team = this.team(teamId);
    if (team?.members.length) this.emit('target-assigned', { targetId, targetName, teamName: team.name, userIds: team.members.map((m) => m.userId) });
  }

  deleteTarget(id: number): void {
    const teamId = this.db.get<{ team_id: number | null }>('SELECT team_id FROM targets WHERE id = ?', id)?.team_id ?? null;
    if (this.db.run('DELETE FROM targets WHERE id = ?', id).changes === 0) throw new Error('target not found');
    this.syncTeamStatus(teamId);
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
  /** `forDisplay`: a display key (TV, Pi mirror) is asking; personal points (home, significant places) are left out. */
  snapshot(forDisplay = false): SearchSnapshot {
    const inc = this.openIncident();
    if (!inc) return { responders: [], teams: [], targets: [], latest: {}, updatedAt: now() };
    const members = this.memberIndex(inc.id);
    const latest: Record<number, Fix> = {};
    for (const f of this.tracking.all()) {
      const m = members.get(f.userId);
      latest[f.userId] = { ...f, teamId: m?.teamId, callsign: m?.callsign ?? f.callsign };
    }
    const incident = toIncident(inc, this.subjects, this.points);
    if (forDisplay) incident.points = incident.points?.filter((p) => !PRIVATE_POINT_KINDS.includes(p.kind));
    // contacts never travel in the snapshot: managers fetch them, and this tells them when to
    else incident.contactsRev = this.db.get<{ r: string }>("SELECT (SELECT COUNT(*) || '.' || COALESCE(MAX(id), 0) FROM incident_contacts WHERE incident_id = ?) || ':' || (SELECT COUNT(*) FROM contact_log WHERE incident_id = ?) AS r", inc.id, inc.id)?.r;
    return { incident, responders: this.responders(inc.id), teams: this.teams(inc.id), targets: this.targets(inc.id), latest, updatedAt: now() };
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

  // ------------------------------------------------------------ crew in the field
  /**
   * A crew member reports a find. Where no position is given, their phone's last fix is used.
   * It becomes a 'find' planning point labelled with what was found and who found it.
   */
  reportFind(incidentId: string, userId: number, input: { type?: string; note?: string; lat?: number; lon?: number }) {
    const open = this.requireOpen(incidentId);
    const type = input.type as FindType;
    if (!FIND_TYPES.includes(type)) throw new Error('type must be subject, sighting, item or clue');
    if (!this.current(userId)) throw new Error('only crew responding to this incident can report a find');
    let lat = finite(input.lat), lon = finite(input.lon);
    if (lat === null || lon === null) {
      const fix = this.tracking.all().find((f) => f.userId === userId);
      if (!fix) throw new Error('no position: allow location on this phone, or check OwnTracks is sending');
      lat = fix.lat;
      lon = fix.lon;
    }
    const who = this.memberIndex(open.id).get(userId)?.callsign ?? this.users.byId(userId)?.name ?? 'crew';
    const p = this.points.add(open.id, { kind: 'find', label: `${FIND_LABEL[type]} · ${who}`, note: input.note ?? null, lat, lon }, userId);
    this.changed();
    return p;
  }

  /** A crew member starts or finishes their own team's target. Only members of that team may. */
  crewTargetProgress(targetId: number, userId: number, status: string, pod?: number): Target {
    const t = this.target(targetId);
    if (!t) throw new Error('target not found');
    if (status !== 'in-progress' && status !== 'done') throw new Error('status must be in-progress or done');
    const mine = t.teamId ? this.memberIndex(this.db.get<{ incident_id: string }>('SELECT incident_id FROM targets WHERE id = ?', targetId)!.incident_id).get(userId)?.teamId === t.teamId : false;
    if (!mine) throw Object.assign(new Error('this target is not your team’s'), { code: 'FORBIDDEN' });
    return this.updateTarget(targetId, { status: status as TargetStatus, ...(status === 'done' && pod !== undefined ? { pod } : {}) });
  }

  /**
   * How well a target has been covered so far: the team's tracks inside it since it was created,
   * times twice the team's sweep width, over its area; and the POD that suggests. Area targets only.
   */
  targetCoverage(targetId: number): TargetCoverage | undefined {
    const t = this.target(targetId);
    if (!t || t.kind !== 'area' || !t.teamId) return undefined;
    const team = this.team(t.teamId);
    const ring = (t.geometry as { coordinates: [number, number][][] }).coordinates[0];
    const from = Math.floor(Date.parse(t.createdAt) / 1000), to = t.completedAt ? Math.floor(Date.parse(t.completedAt) / 1000) : Math.floor(Date.now() / 1000);
    const rows = this.db.all<{ user_id: number; tst: number; lat: number; lon: number }>('SELECT user_id, tst, lat, lon FROM positions WHERE incident_id = ? AND team_id = ? AND tst BETWEEN ? AND ? ORDER BY user_id, tst', t.incidentId, t.teamId, from, to);
    const byUser = new Map<number, { tst: number; lat: number; lon: number }[]>();
    for (const r of rows) byUser.set(r.user_id, [...(byUser.get(r.user_id) ?? []), r]);
    const sweep = team?.searchWidthM ?? this.cfg.search.defaultSearchWidthM;
    return { ...coverageFromTracks(ring, [...byUser.values()], sweep, this.cfg.search.trackGapSec), sweepEachSideM: sweep };
  }

  // ------------------------------------------------------------ outcomes
  outcome(incidentId: string): IncidentOutcome | undefined {
    const r = this.db.get<{ incident_id: string; outcome: OutcomeKind; found_at: string | null; lat: number | null; lon: number | null; distance_km: number | null; location_type: FoundLocation | null; found_by: FoundBy | null; notes: string | null; recorded_at: string }>('SELECT * FROM incident_outcomes WHERE incident_id = ?', incidentId);
    return r ? { incidentId: r.incident_id, outcome: r.outcome, foundAt: r.found_at ?? undefined, lat: r.lat ?? undefined, lon: r.lon ?? undefined, distanceKm: r.distance_km ?? undefined, locationType: r.location_type ?? undefined, foundBy: r.found_by ?? undefined, notes: r.notes ?? undefined, recordedAt: r.recorded_at } : undefined;
  }

  /** Record (or correct) how an incident ended. The distance from the planning point is worked out here. */
  setOutcome(incidentId: string, input: { outcome?: string; foundAt?: string | null; lat?: number | null; lon?: number | null; locationType?: string | null; foundBy?: string | null; notes?: string | null }, by?: number): IncidentOutcome {
    if (!this.incidentById(incidentId)) throw new Error('incident not found');
    if (!OUTCOME_KINDS.includes(input.outcome as OutcomeKind)) throw new Error('unknown outcome');
    const lat = finite(input.lat ?? undefined), lon = finite(input.lon ?? undefined);
    if ((lat === null) !== (lon === null)) throw new Error('give both lat and lon, or neither');
    if (lat !== null && (lat < 49 || lat > 58 || lon! < -12 || lon! > 0)) throw new Error('position is outside Ireland and Britain: check lat/lon');
    if (input.locationType && !FOUND_LOCATIONS.includes(input.locationType as FoundLocation)) throw new Error('unknown location type');
    if (input.foundBy && !Object.keys(FOUND_BY_LABEL).includes(input.foundBy)) throw new Error('unknown found-by');
    const ipp = this.points.planningPoint(incidentId);
    const dist = lat !== null && ipp ? Math.round((distanceM([ipp.lon, ipp.lat], [lon!, lat]) / 1000) * 100) / 100 : null;
    const foundAt = input.foundAt && !Number.isNaN(Date.parse(input.foundAt)) ? new Date(input.foundAt).toISOString() : null;
    this.db.run(`INSERT INTO incident_outcomes (incident_id, outcome, found_at, lat, lon, distance_km, location_type, found_by, notes, recorded_at, recorded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(incident_id) DO UPDATE SET outcome = excluded.outcome, found_at = excluded.found_at, lat = excluded.lat, lon = excluded.lon, distance_km = excluded.distance_km, location_type = excluded.location_type, found_by = excluded.found_by, notes = excluded.notes, recorded_at = excluded.recorded_at, recorded_by = excluded.recorded_by`,
      incidentId, String(input.outcome), foundAt, lat, lon, dist, input.locationType || null, input.foundBy || null, input.notes?.toString().trim().slice(0, 1000) || null, now(), by ?? null);
    return this.outcome(incidentId)!;
  }

  /**
   * Every recorded outcome with the subject's profile, for the Irish evidence base: no names,
   * no positions, no free text; month, not date; age in ten-year bands.
   */
  outcomesCsv(): string {
    const rows = this.db.all<{ started_at: string; ended_at: string | null; outcome: string; distance_km: number | null; location_type: string | null; found_by: string | null; found_at: string | null; category: string | null; sex: string | null; age: number | null; terrain: string | null }>(
      `SELECT i.started_at, i.ended_at, o.outcome, o.distance_km, o.location_type, o.found_by, o.found_at, s.category, s.sex, s.age, s.terrain
       FROM incident_outcomes o JOIN incidents i ON i.id = o.incident_id LEFT JOIN incident_subjects s ON s.incident_id = o.incident_id ORDER BY i.started_at`);
    const q = (v: unknown) => (v === null || v === undefined ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const head = ['month', 'category', 'sex', 'age_band', 'terrain', 'outcome', 'distance_km', 'found_location', 'found_by', 'hours_to_find', 'hours_open'];
    const lines = rows.map((r) => {
      const hrs = (a?: string | null) => (a ? Math.round(((Date.parse(a) - Date.parse(r.started_at)) / 3_600_000) * 10) / 10 : '');
      const band = r.age === null || r.age === undefined ? '' : `${Math.floor(r.age / 10) * 10}-${Math.floor(r.age / 10) * 10 + 9}`;
      return [r.started_at.slice(0, 7), r.category, r.sex, band, r.terrain, r.outcome, r.distance_km, r.location_type, r.found_by, hrs(r.found_at), hrs(r.ended_at)].map(q).join(',');
    });
    return [head.join(','), ...lines].join('\n') + '\n';
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

function finite(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function toIncident(r: IncidentRow, subjects: Subjects, points: Points): SearchIncident {
  const ipp = points.planningPoint(r.id);
  return {
    id: r.id,
    kind: r.kind ?? 'callout',
    text: r.text,
    receivedAt: r.received_at,
    lat: r.lat ?? undefined,
    lon: r.lon ?? undefined,
    source: r.source ?? undefined,
    startedAt: r.started_at,
    endedAt: r.ended_at ?? undefined,
    endReason: r.end_reason ?? undefined,
    ipp,
    points: points.list(r.id),
    subjectUpdatedAt: subjects.updatedAt(r.id),
  };
}

function toTarget(r: TargetRow): Target {
  return { id: r.id, incidentId: r.incident_id, teamId: r.team_id ?? undefined, name: r.name, kind: r.kind, geometry: JSON.parse(r.geometry), notes: r.notes ?? undefined, status: r.status, priority: r.priority, createdAt: r.created_at, completedAt: r.completed_at ?? undefined, segmentId: r.segment_id ?? undefined, pod: r.pod ?? undefined };
}
