import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import type { Audit } from './audit.js';
import { backupDb, listBackups } from './backup.js';
import { runRetention } from './search/retention.js';
import { requireAuth, resolvePrincipal, type AuthCtx } from './auth/middleware.js';
import { timingSafeEqualStr } from './auth/password.js';
import { Invites } from './auth/invites.js';
import type { Push } from './push.js';
import { attachPushTriggers, pushRoutes } from './pushRoutes.js';
import { authRoutes } from './auth/routes.js';
import type { Sessions } from './auth/sessions.js';
import type { Users } from './auth/users.js';
import type { CalloutManager, CalloutRequest } from './callout.js';
import type { AppConfig } from './config.js';
import type { Db } from './db/index.js';
import type { Scheduler } from './scheduler.js';
import type { Settings } from './settings.js';
import type { Devices } from './search/devices.js';
import { owntracksRoutes } from './search/owntracks.js';
import { TerrainService } from './terrain/service.js';
import { searchRoutes } from './search/routes.js';
import type { SearchService } from './search/service.js';
import type { Tracking } from './search/tracking.js';
import type { StateStore } from './state.js';
import { Hub } from './ws.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export function findWebDist(): string | undefined {
  const candidates = [process.env.WEB_DIST, path.resolve(here, '../../web/dist'), path.resolve(here, '../../../web/dist'), path.resolve('web/dist')].filter(Boolean) as string[];
  return candidates.find((p) => fs.existsSync(path.join(p, 'index.html')));
}

export interface ServerDeps {
  db: Db;
  users: Users;
  sessions: Sessions;
  audit: Audit;
  devices: Devices;
  tracking: Tracking;
  /** Present when accounts + search are on. */
  search?: SearchService;
  /** Terrain for search areas; built from cfg.terrain under dataDir/terrain when not given. */
  terrain?: TerrainService;
  backupDir?: string;
  /** Runtime-editable feed settings (console → Settings → Data feeds). */
  settings?: Settings;
  /** Rebuild one provider from the current config after a setting changed. */
  rebuildProvider?: (name: string) => Promise<void>;
  /** Web push to crew phones; alerts are off when absent. */
  push?: Push;
}

export interface BuiltServer {
  app: FastifyInstance;
  hub: Hub;
}

export async function buildServer(cfg: AppConfig, store: StateStore, callout: CalloutManager, scheduler: Scheduler, deps: ServerDeps): Promise<BuiltServer> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    disableRequestLogging: true,
    trustProxy: true, // Caddy in front on the VPS
  });
  const auth: AuthCtx = { cfg, sessions: deps.sessions, users: deps.users };

  await app.register(fastifyCookie);
  await app.register(fastifyHelmet, {
    // The TV/mobile pages load map tiles and fonts cross-origin and MapLibre uses
    // blob workers; a strict CSP is a later hardening step.
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  });
  await app.register(fastifyRateLimit, { global: true, max: 600, timeWindow: '1 minute', allowList: ['127.0.0.1', '::1'] });
  await app.register(fastifyWebsocket, { options: { maxPayload: 64 * 1024 } });

  // ---- legacy bearer token (pager / WhatsApp bridge) OR a manager session ----
  const requireTokenOrManager = (req: FastifyRequest, reply: FastifyReply): boolean => {
    const token = cfg.callout.token;
    const authz = req.headers.authorization ?? '';
    const given = authz.startsWith('Bearer ') ? authz.slice(7) : (req.headers['x-api-token'] as string | undefined) ?? '';
    if (token && given && timingSafeEqualStr(given, token)) return true;
    const p = resolvePrincipal(auth, req);
    if (p?.kind === 'user' && (p.role === 'manager' || p.role === 'admin')) {
      req.principal = p;
      return true;
    }
    // Open mode (Pi on the LAN): only the bridge token can trigger a callout.
    if (p?.kind === 'open' && !token) {
      reply.code(503).send({ error: 'callout endpoints disabled: CALLOUT_TOKEN not configured' });
      return false;
    }
    reply.code(401).send({ error: 'unauthorised' });
    return false;
  };

  // ---- read-only state: display keys, any user, or everyone in open mode ----
  const readAuth = requireAuth(auth, 'display');
  app.get('/api/state', { preHandler: readAuth }, async () => store.get());
  app.get('/api/mode', { preHandler: readAuth }, async () => store.getMode());

  app.post<{ Body: CalloutRequest }>('/api/callout', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (!requireTokenOrManager(req, reply)) return;
    try {
      const body = (req.body ?? {}) as CalloutRequest;
      const mode = callout.callout({ ...body, source: body.source ?? (req.principal?.kind === 'user' ? 'app' : 'api') });
      deps.audit.log(req.principal, req.ip, 'callout.started', { type: 'incident', id: mode.incident?.id ?? '' });
      return mode;
    } catch (e) {
      reply.code(400);
      return { error: e instanceof Error ? e.message : String(e) };
    }
  });

  app.post('/api/standdown', async (req, reply) => {
    if (!requireTokenOrManager(req, reply)) return;
    deps.audit.log(req.principal, req.ip, 'callout.standdown');
    return callout.standdown(req.principal?.kind === 'user' ? 'app' : 'api');
  });

  app.post<{ Querystring: { provider?: string } }>('/api/refresh', async (req, reply) => {
    if (!requireTokenOrManager(req, reply)) return;
    await scheduler.pollNow(req.query.provider);
    return { ok: true };
  });

  app.get('/healthz', async (_req, reply) => {
    const providers = store.getHealth();
    const enabled = Object.values(providers).filter((p) => p.status !== 'disabled' && p.status !== 'stub');
    const bad = enabled.filter((p) => p.status === 'error');
    const degraded = enabled.filter((p) => p.status === 'stale');
    const status = bad.length === enabled.length && enabled.length > 0 ? 'down' : bad.length || degraded.length ? 'degraded' : 'ok';
    reply.code(status === 'down' ? 503 : 200);
    // Provider detail only for authenticated callers when accounts are on.
    const detail = cfg.auth.open || resolvePrincipal(auth, _req) ? { providers } : {};
    return {
      status,
      mode: store.getMode().mode,
      uptimeSec: Math.round(process.uptime()),
      db: deps.db.version > 0 ? 'ok' : 'missing',
      wsClients: hub.size,
      fixesLastMin: deps.tracking.rate(),
      ...(cfg.upstream.url ? { upstream: store.upstreamFresh ? 'live' : 'fallback' } : {}),
      ...detail,
    };
  });

  // ---- admin: backups (any mode; admin session when accounts are on, bridge token otherwise) ----
  if (deps.backupDir) {
    const dir = deps.backupDir;
    app.get('/api/admin/backups', { preHandler: requireAuth(auth, 'admin') }, async () => ({ backups: listBackups(dir).map((b) => ({ file: path.basename(b.file), bytes: b.bytes, at: b.at })) }));
    app.post('/api/admin/backup', { preHandler: requireAuth(auth, 'admin') }, async (req) => {
      const b = await backupDb(deps.db, dir, cfg.retention.backupKeep);
      deps.audit.log(req.principal, req.ip, 'backup.manual', undefined, { file: path.basename(b.file), bytes: b.bytes });
      return { file: path.basename(b.file), bytes: b.bytes, at: b.at };
    });
    app.post('/api/admin/retention', { preHandler: requireAuth(auth, 'admin') }, async () => runRetention(deps.db, cfg, { devices: deps.devices, sessions: deps.sessions, audit: deps.audit }));
  }

  // ---- admin: runtime feed settings (API keys, webcam URL) ----
  if (deps.settings) {
    const settings = deps.settings;
    app.get('/api/admin/settings', { preHandler: requireAuth(auth, 'admin') }, async () => ({ settings: settings.list() }));
    app.put<{ Body: Record<string, string | null> }>('/api/admin/settings', { preHandler: requireAuth(auth, 'admin') }, async (req, reply) => {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const providers = new Set<string>();
      const changed: string[] = [];
      for (const [key, value] of Object.entries(body)) {
        const f = settings.field(key);
        if (!f) return reply.code(400).send({ error: `unknown setting ${key}` });
        try {
          providers.add(settings.set(key, value === null ? null : String(value)));
          changed.push(key);
        } catch (e) {
          return reply.code(400).send({ error: `${f.label}: ${e instanceof Error ? e.message : String(e)}` });
        }
      }
      for (const key of changed) {
        const f = settings.field(key)!;
        // Never put a secret in the audit log; URLs and labels are fine.
        deps.audit.log(req.principal, req.ip, 'settings.updated', { type: 'setting', id: key }, f.secret ? { cleared: !body[key] } : { value: body[key] ?? null });
      }
      for (const name of providers) await deps.rebuildProvider?.(name);
      return { settings: settings.list(), rebuilt: [...providers] };
    });
  }

  // ---- WebSocket hub ----
  const hub = new Hub(store, auth);
  hub.register(app);

  // ---- accounts + tracking (only when auth is on; in open mode nobody has an identity) ----
  if (!cfg.auth.open) {
    const push = deps.push;
    await app.register(async (sub) => authRoutes(sub, { ...auth, audit: deps.audit, invites: new Invites(deps.db, deps.users), push }));
    if (push) {
      await app.register(async (sub) => pushRoutes(sub, { ...auth, audit: deps.audit, push }));
      attachPushTriggers(push, store, deps.search, cfg.station.shortName);
    }
    if (cfg.search.enabled) {
      await app.register(async (sub) =>
        owntracksRoutes(sub, {
          ...auth,
          audit: deps.audit,
          devices: deps.devices,
          tracking: deps.tracking,
          incidentOpen: () => store.getMode().mode === 'callout',
          onFix: (fix) => hub.queueFix(fix),
        }),
      );
      const search = deps.search;
      if (search) {
        const terrain = deps.terrain ?? new TerrainService(path.join(cfg.server.dataDir, 'terrain'), cfg.terrain, app.log);
        await app.register(async (sub) => searchRoutes(sub, { ...auth, db: deps.db, search, callout, audit: deps.audit, terrain }));
        // snapshot to every authenticated socket on change (throttled) and on join
        let pending: NodeJS.Timeout | undefined;
        const push = () => {
          if (pending) return;
          pending = setTimeout(() => {
            pending = undefined;
            // Display keys get the snapshot without personal points (home, significant places).
            const full = { type: 'search' as const, search: search.snapshot() };
            const forDisplay = { type: 'search' as const, search: search.snapshot(true) };
            hub.send(full, (p) => p.kind === 'user' || (p.kind === 'open' && cfg.auth.open));
            hub.send(forDisplay, (p) => p.kind === 'display');
          }, 250);
          pending.unref?.();
        };
        search.on('change', push);
        hub.onJoin = (p, send) => send({ type: 'search', search: search.snapshot(p.kind === 'display') });
        app.addHook('onClose', async () => {
          search.off('change', push);
          if (pending) clearTimeout(pending);
          search.dispose();
        });
      }
    }
  } else {
    app.get('/api/auth/me', async () => ({ principal: { kind: 'open' } }));
  }

  // ---- static frontend ----
  const dist = findWebDist();
  if (dist) {
    await app.register(fastifyStatic, {
      root: dist,
      prefix: '/',
      wildcard: true,
      setHeaders(res, filePath) {
        res.setHeader('cache-control', filePath.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
    app.setNotFoundHandler((req, reply) => {
      const url = req.raw.url ?? '/';
      if (url.startsWith('/api/') || url.startsWith('/ot')) return reply.code(404).send({ error: 'not found' });
      reply.header('cache-control', 'no-cache');
      // Multi-page app: /m/... → crew PWA, /sm/... → search manager console, else TV.
      if (url.startsWith('/m/') || url === '/m') return reply.sendFile('m/index.html');
      if (url.startsWith('/sm/') || url === '/sm') return reply.sendFile('sm/index.html');
      return reply.sendFile('index.html');
    });
    app.log.info({ dist }, 'serving web build');
  } else {
    app.log.warn('web/dist not found — API only (run `npm run build -w web`)');
  }

  return { app, hub };
}
