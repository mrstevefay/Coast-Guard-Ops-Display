import type { FastifyInstance, FastifyRequest } from 'fastify';
import QRCode from 'qrcode';
import type { Role } from '../../../shared/types.js';
import type { Audit } from '../audit.js';
import { cookieOptions, requireAuth, SESSION_COOKIE, type AuthCtx } from './middleware.js';
import { InviteError, type Invites } from './invites.js';
import { toPublic } from './users.js';

export interface AuthRoutesDeps extends AuthCtx {
  audit: Audit;
  invites: Invites;
}

/** Per-email login throttle (20/hour) on top of the per-IP rate limit. */
const loginAttempts = new Map<string, number[]>();
function emailThrottled(email: string): boolean {
  const key = email.toLowerCase();
  const nowMs = Date.now();
  const arr = (loginAttempts.get(key) ?? []).filter((t) => nowMs - t < 3600_000);
  arr.push(nowMs);
  loginAttempts.set(key, arr);
  if (loginAttempts.size > 5000) loginAttempts.clear();
  return arr.length > 20;
}

export async function authRoutes(app: FastifyInstance, d: AuthRoutesDeps): Promise<void> {
  const { cfg, sessions, users, audit, invites } = d;
  const cookieMaxAge = cfg.auth.sessionDays * 86400;
  const errorJson = (e: unknown) => ({ error: e instanceof Error ? e.message : String(e) });

  app.post<{ Body: { email?: string; password?: string } }>(
    '/api/auth/login',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const email = String(req.body?.email ?? '').trim();
      const password = String(req.body?.password ?? '');
      if (!email || !password) return reply.code(400).send({ error: 'email and password required' });
      if (emailThrottled(email)) return reply.code(429).send({ error: 'too many attempts, try later' });
      const user = users.authenticate(email, password);
      if (!user && users.pendingMatch(email, password)) {
        return reply.code(403).send({ error: 'Your account is waiting for the station officer to approve it.' });
      }
      if (!user) {
        audit.log(undefined, req.ip, 'auth.login.failed', undefined, { email });
        return reply.code(401).send({ error: 'invalid email or password' });
      }
      const token = sessions.create(user, { userAgent: req.headers['user-agent'], ip: req.ip });
      reply.setCookie(SESSION_COOKIE, token, cookieOptions(cfg, cookieMaxAge));
      audit.log({ kind: 'user', userId: user.id, role: user.role, name: user.name }, req.ip, 'auth.login');
      return { user: toPublic(user) };
    },
  );

  app.post('/api/auth/logout', { preHandler: requireAuth(d, 'display') }, async (req, reply) => {
    if (req.sessionToken && req.principal?.kind === 'user') sessions.revoke(req.sessionToken);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', { preHandler: requireAuth(d, 'display') }, async (req) => {
    const p = req.principal!;
    if (p.kind === 'user') return { principal: p, user: toPublic(users.byId(p.userId)!) };
    return { principal: p };
  });

  app.post<{ Body: { current?: string; new?: string } }>('/api/auth/password', { preHandler: requireAuth(d) }, async (req, reply) => {
    const p = req.principal!;
    if (p.kind !== 'user') return reply.code(403).send({ error: 'forbidden' });
    const u = users.byId(p.userId)!;
    if (!users.authenticate(u.email, String(req.body?.current ?? ''))) return reply.code(401).send({ error: 'current password is wrong' });
    try {
      users.setPassword(u.id, String(req.body?.new ?? ''), false);
    } catch (e) {
      return reply.code(400).send(errorJson(e));
    }
    sessions.revokeAllForUser(u.id, req.sessionToken);
    audit.log(p, req.ip, 'auth.password.changed', { type: 'user', id: u.id });
    return { ok: true };
  });

  app.post('/api/auth/privacy-accept', { preHandler: requireAuth(d) }, async (req, reply) => {
    const p = req.principal!;
    if (p.kind !== 'user') return reply.code(403).send({ error: 'forbidden' });
    users.acceptPrivacy(p.userId);
    audit.log(p, req.ip, 'auth.privacy.accepted');
    return { ok: true };
  });

  /** Kiosk: exchange a display key for a cookie so the plain TV page can load. */
  app.post<{ Body: { key?: string } }>('/api/auth/display', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const key = String(req.body?.key ?? '');
    const r = sessions.resolve(key, users);
    if (!r || r.principal.kind !== 'display') return reply.code(401).send({ error: 'invalid display key' });
    reply.setCookie(SESSION_COOKIE, key, cookieOptions(cfg, 10 * 365 * 86400));
    return { principal: r.principal };
  });

  // ---------------------------------------------------------------- users
  app.get('/api/users', { preHandler: requireAuth(d, 'manager') }, async () => {
    const counts = users.deviceCounts();
    const via = invites.labelsByUser();
    return { users: users.list().map((u) => toPublic(u, { deviceCount: counts.get(u.id) ?? 0, invitedVia: via.get(u.id) })) };
  });

  app.post<{ Body: { name?: string; email?: string; callsign?: string; role?: Role; password?: string } }>('/api/users', { preHandler: requireAuth(d, 'admin') }, async (req, reply) => {
    try {
      const { user, tempPassword } = users.create({
        name: String(req.body?.name ?? ''),
        email: String(req.body?.email ?? ''),
        callsign: req.body?.callsign,
        role: (req.body?.role ?? 'member') as Role,
        password: req.body?.password,
      });
      audit.log(req.principal, req.ip, 'user.created', { type: 'user', id: user.id }, { email: user.email, role: user.role });
      return { user: toPublic(user), tempPassword };
    } catch (e) {
      return reply.code(400).send(errorJson(e));
    }
  });

  app.patch<{ Params: { id: string }; Body: { name?: string; email?: string; callsign?: string | null; role?: Role; active?: boolean } }>(
    '/api/users/:id',
    { preHandler: requireAuth(d, 'admin') },
    async (req, reply) => {
      const id = Number(req.params.id);
      const me = req.principal!;
      if (me.kind === 'user' && me.userId === id && (req.body?.active === false || (req.body?.role && req.body.role !== 'admin'))) {
        return reply.code(400).send({ error: 'you cannot demote or deactivate yourself' });
      }
      try {
        const user = users.update(id, req.body ?? {});
        if (req.body?.active === false) sessions.revokeAllForUser(id);
        audit.log(me, req.ip, 'user.updated', { type: 'user', id }, req.body);
        return { user: toPublic(user) };
      } catch (e) {
        return reply.code(400).send(errorJson(e));
      }
    },
  );

  app.post<{ Params: { id: string } }>('/api/users/:id/approve', { preHandler: requireAuth(d, 'admin') }, async (req, reply) => {
    try {
      const user = users.approve(Number(req.params.id));
      audit.log(req.principal, req.ip, 'user.approved', { type: 'user', id: user.id });
      return { user: toPublic(user) };
    } catch (e) {
      return reply.code(400).send(errorJson(e));
    }
  });

  app.post<{ Params: { id: string } }>('/api/users/:id/reject', { preHandler: requireAuth(d, 'admin') }, async (req, reply) => {
    try {
      users.reject(Number(req.params.id));
      audit.log(req.principal, req.ip, 'user.rejected', { type: 'user', id: Number(req.params.id) });
      return { ok: true };
    } catch (e) {
      return reply.code(400).send(errorJson(e));
    }
  });

  app.post<{ Params: { id: string } }>('/api/users/:id/reset-password', { preHandler: requireAuth(d, 'admin') }, async (req, reply) => {
    const id = Number(req.params.id);
    if (!users.byId(id)) return reply.code(404).send({ error: 'user not found' });
    const tempPassword = users.resetPassword(id);
    sessions.revokeAllForUser(id);
    audit.log(req.principal, req.ip, 'user.password.reset', { type: 'user', id });
    return { tempPassword };
  });

  app.delete<{ Params: { id: string } }>('/api/users/:id', { preHandler: requireAuth(d, 'admin') }, async (req, reply) => {
    const id = Number(req.params.id);
    const me = req.principal!;
    if (me.kind === 'user' && me.userId === id) return reply.code(400).send({ error: 'you cannot delete yourself' });
    if (!users.byId(id)) return reply.code(404).send({ error: 'user not found' });
    users.anonymise(id);
    audit.log(me, req.ip, 'user.anonymised', { type: 'user', id });
    return { ok: true };
  });

  // ---------------------------------------------------------------- invite links
  const publicUrl = (req: FastifyRequest) => cfg.auth.publicUrl || `${req.protocol}://${req.headers.host}`;

  app.get('/api/invites', { preHandler: requireAuth(d, 'admin') }, async () => ({ invites: invites.list() }));

  app.post<{ Body: { label?: string; maxUses?: number; days?: number; needsApproval?: boolean } }>('/api/invites', { preHandler: requireAuth(d, 'admin') }, async (req, reply) => {
    try {
      const me = req.principal;
      const { invite, token } = invites.create(req.body ?? {}, me?.kind === 'user' ? me.userId : undefined);
      // the token goes in the fragment: it stays in the browser and never reaches a server log
      const url = `${publicUrl(req)}/m/#/join/${token}`;
      const qrSvg = await QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 1, width: 280 });
      audit.log(me, req.ip, 'invite.created', { type: 'invite', id: invite.id }, { label: invite.label, maxUses: invite.maxUses, needsApproval: invite.needsApproval, expiresAt: invite.expiresAt });
      return { invite, url, qrSvg };
    } catch (e) {
      return reply.code(400).send(errorJson(e));
    }
  });

  app.delete<{ Params: { id: string } }>('/api/invites/:id', { preHandler: requireAuth(d, 'admin') }, async (req, reply) => {
    if (!invites.revoke(req.params.id)) return reply.code(404).send({ error: 'not found' });
    audit.log(req.principal, req.ip, 'invite.revoked', { type: 'invite', id: req.params.id });
    return { ok: true };
  });

  /** Public: is this link usable? What the join page shows before the form. */
  app.get<{ Params: { token: string } }>('/api/join/:token', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    try {
      const inv = invites.check(req.params.token);
      return { station: cfg.station.name, needsApproval: inv.needsApproval, expiresAt: inv.expiresAt };
    } catch (e) {
      const ie = e instanceof InviteError ? e : new InviteError('invite check failed', 500);
      return reply.code(ie.status).send({ error: ie.message });
    }
  });

  /** Public: make an account from an invite link. Signs in straight away unless approval is needed. */
  app.post<{ Params: { token: string }; Body: { name?: string; email?: string; callsign?: string; password?: string } }>(
    '/api/join/:token',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req, reply) => {
      try {
        const { user, pending } = invites.accept(req.params.token, {
          name: String(req.body?.name ?? ''),
          email: String(req.body?.email ?? ''),
          callsign: req.body?.callsign ? String(req.body.callsign) : undefined,
          password: String(req.body?.password ?? ''),
        });
        audit.log(undefined, req.ip, 'invite.accepted', { type: 'user', id: user.id }, { invite: user.invite_id, pending });
        if (pending) return { pending: true };
        const token = sessions.create(user, { userAgent: req.headers['user-agent'], ip: req.ip });
        reply.setCookie(SESSION_COOKIE, token, cookieOptions(cfg, cookieMaxAge));
        return { user: toPublic(user) };
      } catch (e) {
        const ie = e instanceof InviteError ? e : new InviteError('could not create the account', 500);
        return reply.code(ie.status).send({ error: ie.message });
      }
    },
  );

  // ---------------------------------------------------------------- admin
  app.get('/api/admin/display-keys', { preHandler: requireAuth(d, 'admin') }, async () => ({ keys: sessions.listDisplayKeys() }));
  app.post<{ Body: { label?: string } }>('/api/admin/display-keys', { preHandler: requireAuth(d, 'admin') }, async (req) => {
    const { id, key } = sessions.createDisplayKey(String(req.body?.label ?? 'display'));
    audit.log(req.principal, req.ip, 'displaykey.created', { type: 'displaykey', id });
    return { id, label: req.body?.label ?? 'display', key };
  });
  app.delete<{ Params: { id: string } }>('/api/admin/display-keys/:id', { preHandler: requireAuth(d, 'admin') }, async (req, reply) => {
    if (!sessions.deleteById(req.params.id)) return reply.code(404).send({ error: 'not found' });
    audit.log(req.principal, req.ip, 'displaykey.deleted', { type: 'displaykey', id: req.params.id });
    return { ok: true };
  });
  app.get<{ Querystring: { since?: string; limit?: string } }>('/api/admin/audit', { preHandler: requireAuth(d, 'admin') }, async (req) => ({
    entries: audit.list({ since: req.query.since, limit: req.query.limit ? Number(req.query.limit) : undefined }),
  }));
}
