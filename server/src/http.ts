import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import type { WsMessage } from '../../shared/types.js';
import type { CalloutManager, CalloutRequest } from './callout.js';
import type { AppConfig } from './config.js';
import type { Scheduler } from './scheduler.js';
import type { StateStore } from './state.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export function findWebDist(): string | undefined {
  const candidates = [process.env.WEB_DIST, path.resolve(here, '../../web/dist'), path.resolve(here, '../../../web/dist'), path.resolve('web/dist')].filter(Boolean) as string[];
  return candidates.find((p) => fs.existsSync(path.join(p, 'index.html')));
}

export async function buildServer(cfg: AppConfig, store: StateStore, callout: CalloutManager, scheduler: Scheduler): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, disableRequestLogging: true });
  await app.register(fastifyWebsocket, { options: { maxPayload: 64 * 1024 } });

  // ---- auth for mutating endpoints (Phase 2 WhatsApp bridge uses these) ----
  const requireToken = (req: FastifyRequest, reply: FastifyReply): boolean => {
    const token = cfg.callout.token;
    if (!token) {
      reply.code(503).send({ error: 'callout endpoints disabled: CALLOUT_TOKEN not configured' });
      return false;
    }
    const auth = req.headers.authorization ?? '';
    const given = auth.startsWith('Bearer ') ? auth.slice(7) : (req.headers['x-api-token'] as string | undefined) ?? '';
    if (!given || !timingSafeEqualStr(given, token)) {
      reply.code(401).send({ error: 'unauthorised' });
      return false;
    }
    return true;
  };

  app.get('/api/state', async () => store.get());
  app.get('/api/mode', async () => store.getMode());

  app.post<{ Body: CalloutRequest }>('/api/callout', async (req, reply) => {
    if (!requireToken(req, reply)) return;
    try {
      const body = (req.body ?? {}) as CalloutRequest;
      return callout.callout(body);
    } catch (e) {
      reply.code(400);
      return { error: e instanceof Error ? e.message : String(e) };
    }
  });

  app.post('/api/standdown', async (req, reply) => {
    if (!requireToken(req, reply)) return;
    return callout.standdown('api');
  });

  app.post<{ Querystring: { provider?: string } }>('/api/refresh', async (req, reply) => {
    if (!requireToken(req, reply)) return;
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
    return { status, mode: store.getMode().mode, uptimeSec: Math.round(process.uptime()), providers };
  });

  // ---- WebSocket push: full state on connect and on every (throttled) change ----
  const clients = new Set<import('ws').WebSocket>();
  let pending: NodeJS.Timeout | undefined;
  const broadcast = () => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = undefined;
      const msg: WsMessage = { type: 'state', state: store.get() };
      const payload = JSON.stringify(msg);
      for (const c of clients) if (c.readyState === c.OPEN) c.send(payload);
    }, 250);
  };
  store.on('change', broadcast);
  const heartbeat = setInterval(() => {
    const payload = JSON.stringify({ type: 'ping', t: Date.now() } satisfies WsMessage);
    for (const c of clients) if (c.readyState === c.OPEN) c.send(payload);
  }, 20_000);
  heartbeat.unref?.();

  app.get('/api/ws', { websocket: true }, (socket) => {
    clients.add(socket);
    socket.send(JSON.stringify({ type: 'state', state: store.get() } satisfies WsMessage));
    socket.on('close', () => clients.delete(socket));
    socket.on('error', () => clients.delete(socket));
  });

  // ---- static frontend ----
  const dist = findWebDist();
  if (dist) {
    // wildcard:true serves whatever is in dist *now* (hashed assets change on
    // every build); anything unmatched falls through to index.html below.
    await app.register(fastifyStatic, {
      root: dist,
      prefix: '/',
      wildcard: true,
      setHeaders(res, filePath) {
        res.setHeader('cache-control', filePath.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.raw.url?.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
      reply.header('cache-control', 'no-cache');
      return reply.sendFile('index.html');
    });
    app.log.info({ dist }, 'serving web build');
  } else {
    app.log.warn('web/dist not found — API only (run `npm run build -w web`)');
  }

  app.addHook('onClose', async () => {
    clearInterval(heartbeat);
    store.off('change', broadcast);
  });
  return app;
}

function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
