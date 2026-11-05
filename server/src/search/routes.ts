import fs from 'node:fs';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ResponseStatus, TargetKind, TargetStatus, TeamStatus } from '../../../shared/types.js';
import type { Audit } from '../audit.js';
import { requireAuth, type AuthCtx } from '../auth/middleware.js';
import type { CalloutManager } from '../callout.js';
import type { Db } from '../db/index.js';
import type { SearchService } from './service.js';
import { PHOTO_MAX_BYTES, type SubjectPatch } from './subject.js';
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
  // ---------------------------------------------------------- history
  app.get<{ Querystring: { limit?: string } }>('/api/incidents', { preHandler: manager }, async (req) => ({ incidents: search.history(req.query.limit ? Number(req.query.limit) : 100) }));

  app.get<{ Params: { id: string } }>('/api/incidents/:id/replay', { preHandler: manager }, async (req, reply) => {
    const r = search.replay(req.params.id);
    return r ?? bad(reply, 'incident not found', 404);
  });

  app.get<{ Params: { id: string } }>('/api/incidents/:id/report', { preHandler: manager }, async (req, reply) => {
    const r = search.report(req.params.id);
    return r ? { report: r.report } : bad(reply, 'incident not found', 404);
  });

  /** Printable end-of-mission report. `?download=1` sends it as a file for mailing to HQ. */
  app.get<{ Params: { id: string }; Querystring: { download?: string } }>('/api/incidents/:id/report.html', { preHandler: manager }, async (req, reply) => {
    const html = search.reportHtml(req.params.id);
    if (!html) return bad(reply, 'incident not found', 404);
    const inc = search.incidentById(req.params.id)!;
    const name = `${inc.kind}-report-${inc.started_at.slice(0, 16).replace(/[:T]/g, '-')}.html`;
    audit.log(req.principal, req.ip, 'report.generated', { type: 'incident', id: req.params.id }, { download: Boolean(req.query.download) });
    reply.header('cache-control', 'private, no-store').header('content-disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${name}"`).type('text/html; charset=utf-8');
    return html;
  });

  /**
   * Start a search. Default is a *tasking*: the search opens (teams, targets, tracking,
   * responders) but the display stays in standby and nobody is paged. `callout: true`
   * raises a callout instead (TV to callout mode, crew app alert), as the pager bridge does.
   */
  app.post<{ Body: { text?: string; lat?: number; lon?: number; callout?: boolean } }>('/api/incidents', { preHandler: manager }, async (req, reply) => {
    try {
      const p = req.principal!;
      if (req.body?.callout) {
        const mode = d.callout.callout({ text: String(req.body?.text ?? ''), lat: req.body?.lat, lon: req.body?.lon, source: 'app' });
        audit.log(p, req.ip, 'incident.started', { type: 'incident', id: mode.incident!.id }, { kind: 'callout' });
        return { incident: search.openIncident() ? search.snapshot().incident : undefined, mode };
      }
      const incident = search.startTasking({ text: String(req.body?.text ?? ''), lat: req.body?.lat, lon: req.body?.lon, createdBy: p.kind === 'user' ? p.userId : undefined });
      audit.log(p, req.ip, 'incident.started', { type: 'incident', id: incident.id }, { kind: 'tasking' });
      return { incident };
    } catch (e) {
      return bad(reply, e);
    }
  });

  app.post<{ Params: { id: string } }>('/api/incidents/:id/close', { preHandler: manager }, async (req, reply) => {
    const open = search.openIncident();
    if (!open || open.id !== req.params.id) return bad(reply, 'incident is not open', 409);
    if (open.kind === 'tasking') search.closeTasking(open.id);
    else d.callout.standdown('app');
    audit.log(req.principal, req.ip, 'incident.closed', { type: 'incident', id: req.params.id }, { kind: open.kind });
    return { ok: true };
  });

  /** Search planning point (IPP). `ipp: null` clears it. */
  app.patch<{ Params: { id: string }; Body: { ipp?: { lat?: number; lon?: number; label?: string } | null } }>('/api/incidents/:id', { preHandler: manager }, async (req, reply) => {
    try {
      const b = req.body ?? {};
      if (b.ipp === undefined) return bad(reply, 'nothing to update');
      const incident = search.setPlanningPoint(req.params.id, b.ipp ? { lat: Number(b.ipp.lat), lon: Number(b.ipp.lon), label: b.ipp.label } : null);
      audit.log(req.principal, req.ip, 'incident.ipp', { type: 'incident', id: req.params.id }, b.ipp ? { lat: incident.ipp?.lat, lon: incident.ipp?.lon } : { cleared: true });
      return { incident };
    } catch (e) {
      return bad(reply, e);
    }
  });

  // ---------------------------------------------------------- subject (who we are looking for)
  // Logged-in crew only: display keys (the TV) never see these details.
  const subjectIncident = (id: string, reply: FastifyReply) => {
    const inc = search.incidentById(id);
    if (!inc) return void bad(reply, 'incident not found', 404);
    return inc;
  };
  app.get<{ Params: { id: string } }>('/api/incidents/:id/subject', { preHandler: member }, async (req, reply) => {
    if (!subjectIncident(req.params.id, reply)) return;
    return { subject: search.subjects.get(req.params.id) ?? null };
  });

  app.put<{ Params: { id: string }; Body: SubjectPatch }>('/api/incidents/:id/subject', { preHandler: manager }, async (req, reply) => {
    if (!subjectIncident(req.params.id, reply)) return;
    try {
      const p = req.principal!;
      const b = req.body ?? {};
      const subject = search.subjects.set(req.params.id, b, p.kind === 'user' ? p.userId : undefined);
      search.subjectChanged();
      // No personal details in the audit log: just which fields changed.
      audit.log(p, req.ip, 'subject.updated', { type: 'incident', id: req.params.id }, { fields: Object.keys(b) });
      return { subject };
    } catch (e) {
      return bad(reply, e);
    }
  });

  // Photo: raw image body (the console resizes to ~1280 px before upload).
  app.addContentTypeParser(['image/jpeg', 'image/png', 'image/webp'], { parseAs: 'buffer', bodyLimit: PHOTO_MAX_BYTES }, (_req, body, done) => done(null, body));
  app.put<{ Params: { id: string }; Body: Buffer }>('/api/incidents/:id/subject/photo', { preHandler: manager, bodyLimit: PHOTO_MAX_BYTES }, async (req, reply) => {
    if (!subjectIncident(req.params.id, reply)) return;
    try {
      const p = req.principal!;
      const mime = String(req.headers['content-type'] ?? '').split(';')[0].trim();
      if (!Buffer.isBuffer(req.body)) return bad(reply, 'send the image as the request body with an image/* content-type');
      const subject = search.subjects.setPhoto(req.params.id, req.body, mime, p.kind === 'user' ? p.userId : undefined);
      search.subjectChanged();
      audit.log(p, req.ip, 'subject.photo', { type: 'incident', id: req.params.id }, { bytes: req.body.length });
      return { subject };
    } catch (e) {
      return bad(reply, e);
    }
  });

  app.get<{ Params: { id: string } }>('/api/incidents/:id/subject/photo', { preHandler: member }, async (req, reply) => {
    if (!subjectIncident(req.params.id, reply)) return;
    const photo = search.subjects.photoPath(req.params.id);
    if (!photo) return bad(reply, 'no photo', 404);
    reply.header('cache-control', 'private, no-store').type(photo.mime);
    return reply.send(fs.createReadStream(photo.file));
  });

  app.delete<{ Params: { id: string } }>('/api/incidents/:id/subject/photo', { preHandler: manager }, async (req, reply) => {
    if (!subjectIncident(req.params.id, reply)) return;
    const subject = search.subjects.deletePhoto(req.params.id, req.principal?.kind === 'user' ? req.principal.userId : undefined);
    search.subjectChanged();
    audit.log(req.principal, req.ip, 'subject.photo.deleted', { type: 'incident', id: req.params.id });
    return { subject: subject ?? null };
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
