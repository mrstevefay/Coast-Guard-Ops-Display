import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { Principal, Role } from '../../../shared/types.js';
import type { AppConfig } from '../config.js';
import type { Sessions } from './sessions.js';
import { hasRole, type Users } from './users.js';

export const SESSION_COOKIE = 'cg_s';

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
    sessionToken?: string;
  }
}

export interface AuthCtx {
  cfg: AppConfig;
  sessions: Sessions;
  users: Users;
}

/** Extract the raw token from cookie, `X-Display-Key` header or `?key=` (WS/kiosk). */
export function tokenFrom(req: FastifyRequest): string | undefined {
  const cookie = (req as any).cookies?.[SESSION_COOKIE] as string | undefined;
  if (cookie) return cookie;
  const hdr = req.headers['x-display-key'];
  if (typeof hdr === 'string' && hdr) return hdr;
  const q = (req.query as Record<string, unknown> | undefined)?.key;
  if (typeof q === 'string' && q) return q;
  return undefined;
}

export function resolvePrincipal(ctx: AuthCtx, req: FastifyRequest): Principal | undefined {
  if (ctx.cfg.auth.open) return { kind: 'open' };
  const token = tokenFrom(req);
  const r = ctx.sessions.resolve(token, ctx.users);
  if (!r) return undefined;
  req.sessionToken = token;
  return r.principal;
}

/**
 * Browser CSRF guard for cookie-authenticated mutating requests: modern browsers
 * always send Sec-Fetch-Site; cross-site values are rejected. Non-browser
 * clients (no such header) pass, as do same-origin Origin headers.
 */
export function csrfOk(req: FastifyRequest, publicUrl: string): boolean {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return true;
  const sfs = req.headers['sec-fetch-site'];
  if (typeof sfs === 'string') return sfs === 'same-origin' || sfs === 'none';
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin) {
    const host = req.headers.host ?? '';
    try {
      const o = new URL(origin);
      if (o.host === host) return true;
      if (publicUrl && o.origin === new URL(publicUrl).origin) return true;
    } catch {
      return false;
    }
    return false;
  }
  return true;
}

/** Minimum role; 'display' accepts display keys (read-only) and any user. */
export type Need = Role | 'display';

export function requireAuth(ctx: AuthCtx, need: Need = 'member'): preHandlerHookHandler {
  return (req: FastifyRequest, reply: FastifyReply, done) => {
    const p = resolvePrincipal(ctx, req);
    if (!p) {
      reply.code(401).send({ error: 'unauthorised' });
      return;
    }
    req.principal = p;
    if (!allowed(p, need)) {
      reply.code(403).send({ error: 'forbidden' });
      return;
    }
    if (p.kind === 'user' && req.sessionToken && !csrfOk(req, ctx.cfg.auth.publicUrl)) {
      reply.code(403).send({ error: 'cross-site request rejected' });
      return;
    }
    done();
  };
}

export function allowed(p: Principal, need: Need): boolean {
  if (p.kind === 'open') return true;
  if (p.kind === 'display') return need === 'display';
  if (need === 'display') return true;
  return hasRole(p.role, need);
}

export function cookieOptions(cfg: AppConfig, maxAgeSec: number) {
  const secure = cfg.auth.publicUrl.startsWith('https://') || process.env.NODE_ENV === 'production';
  return { path: '/', httpOnly: true, sameSite: 'lax' as const, secure, maxAge: maxAgeSec };
}
