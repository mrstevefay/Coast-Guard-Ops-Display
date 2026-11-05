import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ResponseStatus, TargetKind, TargetStatus, TeamStatus } from '../../../shared/types.js';
import type { Audit } from '../audit.js';
import { requireAuth, type AuthCtx } from '../auth/middleware.js';
import type { CalloutManager } from '../callout.js';
import type { Db } from '../db/index.js';
import type { SearchService } from './service.js';
import { tracksFor } from './tracks.js';

export interface SearchRoutesDeps extends AuthCtx {
  db: Db;
  search: SearchService;
  callout: CalloutManager;
  audit: Audit;
}

export async function searchRoutes(app: FastifyInstance, d: SearchRoutesDeps): Promise<void> {
  const { cfg, search, users, audit } = d;
  const bad = (reply: FastifyReply, e: unknown, code = 400) => reply.code(code).send({ error: e instanceof Error ? e.message : String(e) });
  const anyUser = requireAuth(d, 'display');
  const member = requireAuth(d, 'member');
  const manager = requireAuth(d, 'manager');
  const names = (uid: number) => {
    const u = users.byId(uid);
    return { name: u?.name, callsign: u?.callsign ?? undefined };
  };

  app.get('/api/search', { preHandler: anyUser }, async () => search.snapshot());

  // ---------------------------------------------------------- incidents
  app.get<{ Querystring: { limit?: string } }>('/api/incidents', { preHandler: manager }, async (req) => ({ incidents: search.listIncidents(req.query.limit ? Number(req.query.limit) : 50) }));

  app.post<{ Body: { text?: string; lat?: number; lon?: number } }>('/api/incidents', { preHandler: manager }, async (req, reply) => {
    try {
      const mode = d.callout.callout({ text: String(req.body?.text ?? ''), lat: req.body?.lat, lon: req.body?.lon, source: 'app' });
      audit.log(req.principal, req.ip, 'incident.started', { type: 'incident', id: mode.incident!.id });
      return { incident: search.openIncident() ? search.snapshot().incident : undefined, mode };
    } catch (e) {
      return bad(reply, e);
    }
  });

  app.post<{ Params: { id: string } }>('/api/incidents/:id/close', { preHandler: manager }, async (req, reply) => {
    const open = search.openIncident();
    if (!open || open.id !== req.params.id) return bad(reply, 'incident is not open', 409);
    d.callout.standdown('app');
    audit.log(req.principal, req.ip, 'incident.closed', { type: 'incident', id: req.params.id });
    return { ok: true };
  });

  app.get<{ Params: { id: string }; Querystring: { teamId?: string; userId?: string; since?: string; until?: string } }>('/api/incidents/:id/tracks', { preHandler: anyUser }, async (req, reply) => {
    if (!search.incidentById(req.params.id)) return bad(reply, 'incident not found', 404);
    const q = req.query;
    return tracksFor(d.db, req.params.id, {
      teamId: q.teamId ? Number(q.teamId) : undefined,
      userId: q.userId ? Number(q.userId) : undefined,
      sinceTst: q.since ? Math.floor(Date.parse(q.since) / 1000) : undefined,
      untilTst: q.until ? Math.floor(Date.parse(q.until) / 1000) : undefined,
      gapSec: cfg.search.trackGapSec,
      names,
    });
  });

  app.get<{ Params: { id: string } }>('/api/incidents/:id/export.geojson', { preHandler: manager }, async (req, reply) => {
    const inc = search.incidentById(req.params.id);
    if (!inc) return bad(reply, 'incident not found', 404);
    const teams = search.teams(inc.id);
    const targets = search.targets(inc.id);
    const tracks = tracksFor(d.db, inc.id, { gapSec: cfg.search.trackGapSec, names });
    const features: unknown[] = [];
    if (inc.lat !== null && inc.lon !== null) features.push({ type: 'Feature', properties: { kind: 'incident', text: inc.text, receivedAt: inc.received_at }, geometry: { type: 'Point', coordinates: [inc.lon, inc.lat] } });
    for (const t of targets) features.push({ type: 'Feature', properties: { kind: 'target', id: t.id, name: t.name, status: t.status, priority: t.priority, team: teams.find((x) => x.id === t.teamId)?.name }, geometry: t.geometry });
    for (const f of tracks.features) features.push({ ...f, properties: { kind: 'track', ...f.properties, team: teams.find((x) => x.id === f.properties.teamId)?.name, searchWidthM: teams.find((x) => x.id === f.properties.teamId)?.searchWidthM } });
    reply.header('content-disposition', `attachment; filename="incident-${inc.id.slice(0, 8)}.geojson"`).type('application/geo+json');
    return { type: 'FeatureCollection', properties: { incident: inc.id, text: inc.text, startedAt: inc.started_at, endedAt: inc.ended_at, exportedAt: new Date().toISOString() }, features };
  });

  // ---------------------------------------------------------- responses
  app.put<{ Params: { id: string }; Body: { status?: ResponseStatus; etaMin?: number; note?: string } }>('/api/incidents/:id/response', { preHandler: member }, async (req, reply) => {
    const p = req.principal!;
    if (p.kind !== 'user') return bad(reply, 'forbidden', 403);
    try {
      const r = search.setResponse(req.params.id, p.userId, req.body?.status as ResponseStatus, req.body?.etaMin !== undefined ? Number(req.body.etaMin) : undefined, req.body?.note);
      audit.log(p, req.ip, 'response.set', { type: 'incident', id: req.params.id }, { status: r.status, etaMin: r.etaMin });
      return { response: r };
    } catch (e) {
      return bad(reply, e);
    }
  });

  // ---------------------------------------------------------- teams
  app.post<{ Params: { id: string }; Body: { name?: string } }>('/api/incidents/:id/teams', { preHandler: manager }, async (req, reply) => {
    try {
      const team = search.createTeam(req.params.id, req.body?.name);
      audit.log(req.principal, req.ip, 'team.created', { type: 'team', id: team.id }, { name: team.name });
      return { team };
    } catch (e) {
      return bad(reply, e);
    }
  });

  app.patch<{ Params: { id: string }; Body: { name?: string; colour?: string; searchWidthM?: number; status?: TeamStatus; leaderUserId?: number | null } }>('/api/teams/:id', { preHandler: manager }, async (req, reply) => {
    try {
      const team = search.updateTeam(Number(req.params.id), req.body ?? {});
      audit.log(req.principal, req.ip, 'team.updated', { type: 'team', id: team.id }, req.body);
      return { team };
    } catch (e) {
      return bad(reply, e);
    }
  });

  app.put<{ Params: { id: string }; Body: { userIds?: number[]; leaderUserId?: number | null } }>('/api/teams/:id/members', { preHandler: manager }, async (req, reply) => {
    try {
      const team = search.setMembers(Number(req.params.id), req.body?.userIds ?? [], req.body?.leaderUserId);
      audit.log(req.principal, req.ip, 'team.members', { type: 'team', id: team.id }, { userIds: req.body?.userIds, leader: req.body?.leaderUserId });
      return { team };
    } catch (e) {
      return bad(reply, e);
    }
  });

  app.delete<{ Params: { id: string } }>('/api/teams/:id', { preHandler: manager }, async (req, reply) => {
    try {
      search.deleteTeam(Number(req.params.id));
      audit.log(req.principal, req.ip, 'team.deleted', { type: 'team', id: req.params.id });
      return { ok: true };
    } catch (e) {
      return bad(reply, e, 404);
    }
  });

  // ---------------------------------------------------------- targets
  app.post<{ Params: { id: string }; Body: { name?: string; kind?: TargetKind; geometry?: unknown; notes?: string; priority?: number; teamId?: number | null } }>('/api/incidents/:id/targets', { preHandler: manager }, async (req, reply) => {
    try {
      const p = req.principal!;
      const b = req.body ?? {};
      const target = search.createTarget(req.params.id, { name: b.name, kind: b.kind as TargetKind, geometry: b.geometry, notes: b.notes, priority: b.priority, teamId: b.teamId }, p.kind === 'user' ? p.userId : undefined);
      audit.log(p, req.ip, 'target.created', { type: 'target', id: target.id }, { name: target.name, kind: target.kind, teamId: target.teamId });
      return { target };
    } catch (e) {
      return bad(reply, e);
    }
  });

  app.patch<{ Params: { id: string }; Body: { name?: string; geometry?: unknown; notes?: string; status?: TargetStatus; priority?: number; teamId?: number | null } }>('/api/targets/:id', { preHandler: manager }, async (req, reply) => {
    try {
      const target = search.updateTarget(Number(req.params.id), req.body ?? {});
      audit.log(req.principal, req.ip, 'target.updated', { type: 'target', id: target.id }, { status: target.status, teamId: target.teamId });
      return { target };
    } catch (e) {
      return bad(reply, e);
    }
  });

  app.delete<{ Params: { id: string } }>('/api/targets/:id', { preHandler: manager }, async (req, reply) => {
    try {
      search.deleteTarget(Number(req.params.id));
      audit.log(req.principal, req.ip, 'target.deleted', { type: 'target', id: req.params.id });
      return { ok: true };
    } catch (e) {
      return bad(reply, e, 404);
    }
  });
}
