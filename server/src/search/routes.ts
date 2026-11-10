import fs from 'node:fs';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ResponseStatus, TargetKind, TargetStatus, TeamStatus } from '../../../shared/types.js';
import type { Audit } from '../audit.js';
import { requireAuth, type AuthCtx } from '../auth/middleware.js';
import type { CalloutManager } from '../callout.js';
import type { Db } from '../db/index.js';
import type { TerrainService } from '../terrain/service.js';
import { buildPlan } from '../../../shared/lpb/index.js';
import type { SearchService } from './service.js';
import { PHOTO_MAX_BYTES, type SubjectPatch } from './subject.js';
import { tracksFor } from './tracks.js';

export interface SearchRoutesDeps extends AuthCtx {
  db: Db;
  search: SearchService;
  callout: CalloutManager;
  audit: Audit;
  terrain?: TerrainService;
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

  app.get('/api/search', { preHandler: anyUser }, async (req) => search.snapshot(req.principal?.kind === 'display'));

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
  app.post<{ Body: { text?: string; lat?: number; lon?: number; label?: string; callout?: boolean } }>('/api/incidents', { preHandler: manager }, async (req, reply) => {
    try {
      const p = req.principal!;
      if (req.body?.callout) {
        const mode = d.callout.callout({ text: String(req.body?.text ?? ''), lat: req.body?.lat, lon: req.body?.lon, source: 'app' });
        audit.log(p, req.ip, 'incident.started', { type: 'incident', id: mode.incident!.id }, { kind: 'callout' });
        // raised from the console with a position: that is the last known position, as for a tasking
        const open = search.openIncident();
        if (open && Number.isFinite(req.body?.lat) && Number.isFinite(req.body?.lon)) search.setPlanningPoint(open.id, { lat: Number(req.body!.lat), lon: Number(req.body!.lon), label: req.body?.label?.toString().slice(0, 120) || undefined }, p.kind === 'user' ? p.userId : undefined);
        return { incident: search.openIncident() ? search.snapshot().incident : undefined, mode };
      }
      const incident = search.startTasking({ text: String(req.body?.text ?? ''), lat: req.body?.lat, lon: req.body?.lon, label: req.body?.label?.toString().slice(0, 120) || undefined, createdBy: p.kind === 'user' ? p.userId : undefined });
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
      const incident = search.setPlanningPoint(req.params.id, b.ipp ? { lat: Number(b.ipp.lat), lon: Number(b.ipp.lon), label: b.ipp.label } : null, req.principal?.kind === 'user' ? req.principal.userId : undefined);
      audit.log(req.principal, req.ip, 'incident.ipp', { type: 'incident', id: req.params.id }, b.ipp ? { lat: incident.ipp?.lat, lon: incident.ipp?.lon } : { cleared: true });
      return { incident };
    } catch (e) {
      return bad(reply, e);
    }
  });

  // ---------------------------------------------------------- typed planning points
  type PointBody = { kind?: string; label?: string | null; lat?: number; lon?: number; note?: string | null };
  const pointAudit = (p: { id: number; kind: string; lat: number; lon: number; incidentId: string }) => ({ pointId: p.id, kind: p.kind, lat: Math.round(p.lat * 1e5) / 1e5, lon: Math.round(p.lon * 1e5) / 1e5 });

  app.get<{ Params: { id: string } }>('/api/incidents/:id/points', { preHandler: member }, async (req, reply) => {
    if (!search.incidentById(req.params.id)) return bad(reply, 'incident not found', 404);
    return { points: search.points.list(req.params.id) };
  });

  app.post<{ Params: { id: string }; Body: PointBody }>('/api/incidents/:id/points', { preHandler: manager }, async (req, reply) => {
    try {
      const p = search.addPoint(req.params.id, req.body ?? {}, req.principal?.kind === 'user' ? req.principal.userId : undefined);
      audit.log(req.principal, req.ip, 'point.set', { type: 'incident', id: req.params.id }, pointAudit(p));
      return { point: p };
    } catch (e) {
      return bad(reply, e);
    }
  });

  app.patch<{ Params: { id: string }; Body: PointBody }>('/api/points/:id', { preHandler: manager }, async (req, reply) => {
    try {
      const p = search.updatePoint(Number(req.params.id), req.body ?? {}, req.principal?.kind === 'user' ? req.principal.userId : undefined);
      audit.log(req.principal, req.ip, 'point.set', { type: 'incident', id: p.incidentId }, pointAudit(p));
      return { point: p };
    } catch (e) {
      return bad(reply, e, e instanceof Error && e.message === 'point not found' ? 404 : 400);
    }
  });

  app.delete<{ Params: { id: string } }>('/api/points/:id', { preHandler: manager }, async (req, reply) => {
    try {
      const p = search.removePoint(Number(req.params.id));
      if (!p) return bad(reply, 'point not found', 404);
      audit.log(req.principal, req.ip, 'point.deleted', { type: 'incident', id: p.incidentId }, pointAudit(p));
      return { ok: true };
    } catch (e) {
      return bad(reply, e);
    }
  });

  // ---------------------------------------------------------- terrain-shaped search areas
  /** Regions the subject's category distances can reach over this ground, from the planning point. */
  app.get<{ Params: { id: string } }>('/api/incidents/:id/search-area', { preHandler: member }, async (req, reply) => {
    const terrain = d.terrain;
    if (!terrain) return bad(reply, 'terrain is not available on this server', 404);
    const inc = search.incident(req.params.id);
    if (!inc) return bad(reply, 'incident not found', 404);
    const point = inc.points?.find((p) => p.kind === 'lkp') ?? inc.points?.find((p) => p.kind === 'pls');
    if (!point) return bad(reply, 'set the last known position (or place last seen) first', 409);
    const s = search.subjects.get(inc.id);
    if (!s?.category) return bad(reply, 'set a behaviour category on the Subject tab first', 409);
    const plan = buildPlan({ category: s.category, terrain: s.terrain, sex: s.sex, age: s.age, suicideThreatened: s.suicideThreatened, previousAttempts: s.selfHarmHistory, depression: s.depression, significantPlaceKnown: s.significantPlaceKnown || Boolean(inc.points?.some((p) => p.kind === 'significant')) });
    if (!plan) return bad(reply, 'unknown behaviour category', 409);
    try {
      const shares: Record<string, number> = {};
      for (const sh of plan.locations.shares) if (sh.key !== 'Not Found') shares[sh.key] = sh.pct;
      const significant = (inc.points ?? []).filter((p) => p.kind === 'significant').map((p) => ({ lat: p.lat, lon: p.lon, label: p.label }));
      const area = await terrain.searchArea({ lat: point.lat, lon: point.lon, kind: point.kind }, plan.rings.items, { zeroPct: plan.rings.zeroSharePct, shares, significant });
      return { area };
    } catch (e) {
      const code = (e as { code?: string }).code;
      return bad(reply, e, code === 'NOT_BUILT' ? 503 : code === 'OUTSIDE' || code === 'NO_START' ? 422 : 500);
    }
  });

  /** Place search for the console: named places, roads and paths from the terrain build (no internet needed). */
  app.get<{ Querystring: { q?: string; lat?: string; lon?: string } }>('/api/places', { preHandler: manager }, async (req) => {
    const q = String(req.query.q ?? '').slice(0, 80);
    const lat = Number(req.query.lat), lon = Number(req.query.lon);
    const near = Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : { lat: cfg.station.lat, lon: cfg.station.lon };
    const places = d.terrain ? d.terrain.searchPlaces(q, near) : [];
    return { places: places.map(([name, kind, plat, plon]) => ({ name, kind, lat: plat, lon: plon })), indexed: Boolean(d.terrain?.hasPlaces()) };
  });

  const admin = requireAuth(d, 'admin');
  app.get('/api/admin/terrain', { preHandler: admin }, async (_req, reply) => (d.terrain ? d.terrain.status() : bad(reply, 'terrain is not available on this server', 404)));
  app.post<{ Body: { refreshOsm?: boolean; refreshLidar?: boolean } }>('/api/admin/terrain/build', { preHandler: admin }, async (req, reply) => {
    if (!d.terrain) return bad(reply, 'terrain is not available on this server', 404);
    const started = d.terrain.startBuild({ refreshOsm: Boolean(req.body?.refreshOsm), refreshLidar: Boolean(req.body?.refreshLidar) });
    if (!started) return bad(reply, 'a terrain build is already running', 409);
    audit.log(req.principal, req.ip, 'terrain.build', { type: 'system', id: 'terrain' }, { refreshOsm: Boolean(req.body?.refreshOsm) });
    return { ok: true, status: d.terrain.status() };
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

  // ---------------------------------------------------------- contacts (managers only; never in the snapshot)
  type ContactBody = { role?: string; name?: string; organisation?: string | null; phone?: string | null; reference?: string | null; notes?: string | null; directoryId?: number };
  const contactAudit = (c: { id: number; role: string }) => ({ contactId: c.id, role: c.role });
  const by = (req: { principal?: { kind: string; userId?: number } }) => (req.principal?.kind === 'user' ? req.principal.userId : undefined);

  app.get('/api/contacts', { preHandler: manager }, async () => ({ contacts: search.contacts.directory() }));
  app.post<{ Body: ContactBody }>('/api/contacts', { preHandler: manager }, async (req, reply) => {
    try {
      const c = search.contacts.addStation(req.body ?? {});
      audit.log(req.principal, req.ip, 'directory.added', { type: 'contact', id: c.id }, { role: c.role, name: c.name });
      return { contact: c };
    } catch (e) {
      return bad(reply, e);
    }
  });
  app.patch<{ Params: { id: string }; Body: ContactBody }>('/api/contacts/:id', { preHandler: manager }, async (req, reply) => {
    try {
      const c = search.contacts.updateStation(Number(req.params.id), req.body ?? {});
      audit.log(req.principal, req.ip, 'directory.updated', { type: 'contact', id: c.id }, { role: c.role, name: c.name });
      return { contact: c };
    } catch (e) {
      return bad(reply, e, /not found/.test(String((e as Error).message)) ? 404 : 400);
    }
  });
  app.delete<{ Params: { id: string } }>('/api/contacts/:id', { preHandler: manager }, async (req, reply) => {
    try {
      search.contacts.removeStation(Number(req.params.id));
      audit.log(req.principal, req.ip, 'directory.removed', { type: 'contact', id: req.params.id });
      return { ok: true };
    } catch (e) {
      return bad(reply, e, 404);
    }
  });

  /** The incident's contacts and call log. Every read is audited: it can hold next-of-kin details. */
  app.get<{ Params: { id: string } }>('/api/incidents/:id/contacts', { preHandler: manager }, async (req, reply) => {
    if (!search.incidentById(req.params.id)) return bad(reply, 'incident not found', 404);
    audit.log(req.principal, req.ip, 'contacts.viewed', { type: 'incident', id: req.params.id });
    return { contacts: search.contacts.list(req.params.id), log: search.contacts.log(req.params.id) };
  });
  app.post<{ Params: { id: string }; Body: ContactBody }>('/api/incidents/:id/contacts', { preHandler: manager }, async (req, reply) => {
    if (!search.incidentById(req.params.id)) return bad(reply, 'incident not found', 404);
    try {
      const c = search.contacts.add(req.params.id, req.body ?? {}, by(req));
      audit.log(req.principal, req.ip, 'contact.added', { type: 'incident', id: req.params.id }, contactAudit(c));
      search.contactsChanged();
      return { contact: c };
    } catch (e) {
      return bad(reply, e);
    }
  });
  app.patch<{ Params: { id: string }; Body: ContactBody }>('/api/incident-contacts/:id', { preHandler: manager }, async (req, reply) => {
    try {
      const c = search.contacts.update(Number(req.params.id), req.body ?? {});
      audit.log(req.principal, req.ip, 'contact.updated', { type: 'incident', id: c.incidentId }, contactAudit(c));
      search.contactsChanged();
      return { contact: c };
    } catch (e) {
      return bad(reply, e, /not found/.test(String((e as Error).message)) ? 404 : 400);
    }
  });
  app.delete<{ Params: { id: string } }>('/api/incident-contacts/:id', { preHandler: manager }, async (req, reply) => {
    try {
      const c = search.contacts.remove(Number(req.params.id));
      audit.log(req.principal, req.ip, 'contact.removed', { type: 'incident', id: c.incidentId }, contactAudit(c));
      search.contactsChanged();
      return { ok: true };
    } catch (e) {
      return bad(reply, e, 404);
    }
  });
  /** One line in the call log: who rang whom and what was said. The text stays out of the audit log. */
  app.post<{ Params: { id: string }; Body: { contactId?: number | null; direction?: string; text?: string } }>('/api/incidents/:id/contact-log', { preHandler: manager }, async (req, reply) => {
    if (!search.incidentById(req.params.id)) return bad(reply, 'incident not found', 404);
    try {
      const entry = search.contacts.addLog(req.params.id, req.body ?? {}, by(req));
      audit.log(req.principal, req.ip, 'contact.logged', { type: 'incident', id: req.params.id }, { logId: entry.id, contactId: entry.contactId, direction: entry.direction });
      search.contactsChanged();
      return { entry };
    } catch (e) {
      return bad(reply, e);
    }
  });

  // ---------------------------------------------------------- crew in the field
  /** A team member starts or finishes their own team's target (the console sees it at once). */
  app.post<{ Params: { id: string }; Body: { status?: string } }>('/api/targets/:id/progress', { preHandler: member }, async (req, reply) => {
    const p = req.principal!;
    if (p.kind !== 'user') return bad(reply, 'forbidden', 403);
    try {
      const target = search.crewTargetProgress(Number(req.params.id), p.userId, String(req.body?.status ?? ''));
      audit.log(p, req.ip, 'target.updated', { type: 'target', id: target.id }, { status: target.status, by: 'crew' });
      return { target };
    } catch (e) {
      const code = (e as { code?: string }).code;
      return bad(reply, e, code === 'FORBIDDEN' ? 403 : /not found/.test(String((e as Error).message)) ? 404 : 400);
    }
  });

  /** A crew member reports a find: the subject, a sighting, an item or a clue, at their position. */
  app.post<{ Params: { id: string }; Body: { type?: string; note?: string; lat?: number; lon?: number } }>('/api/incidents/:id/finds', { preHandler: member }, async (req, reply) => {
    const p = req.principal!;
    if (p.kind !== 'user') return bad(reply, 'forbidden', 403);
    try {
      const point = search.reportFind(req.params.id, p.userId, req.body ?? {});
      audit.log(p, req.ip, 'point.set', { type: 'incident', id: req.params.id }, { pointId: point.id, kind: 'find', find: req.body?.type, lat: Math.round(point.lat * 1e5) / 1e5, lon: Math.round(point.lon * 1e5) / 1e5 });
      return { point };
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
