import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Audit } from '../audit.js';
import { csrfOk, resolvePrincipal, type AuthCtx } from '../auth/middleware.js';
import { timingSafeEqualStr } from '../auth/password.js';
import { WifiError, type WifiManager } from './wifi.js';

/**
 * /api/device/* — the station Pi's own settings (Wi-Fi), for the page at /device/.
 *
 * The Pi runs in open mode (no accounts), so these need the device password:
 * `Authorization: Bearer <DEVICE_PASSWORD>`, falling back to CALLOUT_TOKEN. With
 * accounts on, an admin session works too. Only mounted when `device.wifi` is on.
 */
export interface DeviceRouteDeps extends AuthCtx {
  audit: Audit;
  wifi: WifiManager;
}

/** The secret for /device/: DEVICE_PASSWORD, else the bridge token unless it is still the template placeholder. */
export function devicePassword(cfg: AuthCtx['cfg']): string {
  if (cfg.device?.password) return cfg.device.password;
  const t = cfg.callout.token;
  return t && !/^change-me/i.test(t) ? t : '';
}

const FAIL_WINDOW_MS = 15 * 60_000;
const FAIL_MAX = 10;

export async function deviceRoutes(app: FastifyInstance, deps: DeviceRouteDeps): Promise<void> {
  const { wifi, audit } = deps;
  const failures = new Map<string, number[]>();

  const guard = async (req: FastifyRequest, reply: FastifyReply) => {
    const p = resolvePrincipal(deps, req);
    if (p?.kind === 'user' && p.role === 'admin') {
      if (req.sessionToken && !csrfOk(req, deps.cfg.auth.publicUrl)) return reply.code(403).send({ error: 'cross-site request rejected' });
      req.principal = p;
      return;
    }
    const secret = devicePassword(deps.cfg);
    if (!secret) return reply.code(503).send({ error: 'No device password set. Put DEVICE_PASSWORD=… in howth-cg.env on the SD card (boot partition) and restart.' });
    const now = Date.now();
    const recent = (failures.get(req.ip) ?? []).filter((t) => now - t < FAIL_WINDOW_MS);
    if (recent.length >= FAIL_MAX) return reply.code(429).send({ error: 'Too many wrong passwords. Try again in 15 minutes.' });
    const authz = req.headers.authorization ?? '';
    const given = authz.startsWith('Bearer ') ? authz.slice(7) : '';
    if (!given || !timingSafeEqualStr(given, secret)) {
      if (given) failures.set(req.ip, [...recent, now]);
      return reply.code(401).send({ error: given ? 'Wrong device password' : 'Device password required' });
    }
    failures.delete(req.ip);
  };

  const fail = (reply: FastifyReply, e: unknown) => {
    const status = e instanceof WifiError ? e.status : 502;
    return reply.code(status).send({ error: e instanceof Error ? e.message : String(e) });
  };

  const opts = { preHandler: guard, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } };

  app.get('/api/device/wifi', opts, async () => wifi.status());

  app.post('/api/device/wifi/scan', opts, async (_req, reply) => {
    try {
      return { networks: await wifi.scan() };
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post<{ Body: { ssid?: string; password?: string; hidden?: boolean } }>('/api/device/wifi/connect', opts, async (req, reply) => {
    const b = req.body ?? {};
    try {
      const attempt = await wifi.connect({ ssid: b.ssid ?? '', password: b.password, hidden: Boolean(b.hidden) });
      audit.log(req.principal, req.ip, 'wifi.connect', { type: 'wifi', id: attempt.ssid }, { hidden: Boolean(b.hidden) });
      return reply.code(202).send({ attempt });
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post<{ Params: { uuid: string } }>('/api/device/wifi/saved/:uuid/connect', opts, async (req, reply) => {
    try {
      const attempt = await wifi.activate(req.params.uuid);
      audit.log(req.principal, req.ip, 'wifi.connect', { type: 'wifi', id: attempt.ssid }, { saved: true });
      return reply.code(202).send({ attempt });
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.delete<{ Params: { uuid: string } }>('/api/device/wifi/saved/:uuid', opts, async (req, reply) => {
    try {
      const before = (await wifi.saved()).find((s) => s.uuid === req.params.uuid);
      await wifi.forget(req.params.uuid);
      audit.log(req.principal, req.ip, 'wifi.forget', { type: 'wifi', id: before?.ssid ?? req.params.uuid });
      return { ok: true };
    } catch (e) {
      return fail(reply, e);
    }
  });
}
