import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import QRCode from 'qrcode';
import type { Fix } from '../../../shared/types.js';
import type { Audit } from '../audit.js';
import { requireAuth, type AuthCtx } from '../auth/middleware.js';
import { deviceNameFromUa, Devices, toDevicePublic, type DeviceRow } from './devices.js';
import type { RawFix, Tracking } from './tracking.js';

export interface OwnTracksDeps extends AuthCtx {
  devices: Devices;
  tracking: Tracking;
  audit: Audit;
  /** Whether an incident is open right now (friends are only returned then). */
  incidentOpen: () => boolean;
  onFix: (fix: Fix) => void;
}

/** OwnTracks "location" payload (HTTP mode). Only the fields we use. */
export interface OtLocation {
  _type: 'location';
  lat: number;
  lon: number;
  tst: number;
  acc?: number;
  alt?: number;
  batt?: number;
  vel?: number; // km/h
  cog?: number;
  tid?: string;
  t?: string; // trigger: p, c, u, m, t, …
}

export function parseBasicAuth(header: string | undefined): { username: string; password: string } | undefined {
  if (!header || !header.startsWith('Basic ')) return undefined;
  let decoded: string;
  try {
    decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  } catch {
    return undefined;
  }
  const i = decoded.indexOf(':');
  if (i <= 0) return undefined;
  return { username: decoded.slice(0, i), password: decoded.slice(i + 1) };
}

const WEEK = 7 * 86400;

/** Validate and normalise an OwnTracks location message. */
export function parseLocation(body: unknown, nowSec = Math.floor(Date.now() / 1000)): RawFix | undefined {
  const b = body as Partial<OtLocation> | null;
  if (!b || typeof b !== 'object' || b._type !== 'location') return undefined;
  const lat = Number(b.lat), lon = Number(b.lon), tst = Number(b.tst);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(tst)) return undefined;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return undefined;
  if (Math.abs(tst - nowSec) > WEEK) return undefined;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  return {
    lat, lon, tst: Math.floor(tst),
    alt: num(b.alt),
    acc: num(b.acc),
    batt: num(b.batt) !== undefined ? Math.round(num(b.batt)!) : undefined,
    velKmh: num(b.vel),
    cog: num(b.cog) !== undefined && b.cog! >= 0 && b.cog! < 360 ? num(b.cog) : undefined,
    trig: typeof b.t === 'string' ? b.t.slice(0, 2) : undefined,
  };
}

/** Friends reply so OwnTracks shows the rest of the crew. */
export function friendsReply(fixes: Fix[], deviceUsernameFor: (userId: number) => string | undefined): unknown[] {
  const out: unknown[] = [];
  for (const f of fixes) {
    const user = deviceUsernameFor(f.userId) ?? `user${f.userId}`;
    const topic = `owntracks/${user}/${f.deviceId}`;
    const tid = (f.callsign ?? f.name).replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || 'CG';
    out.push({ _type: 'location', tid, lat: f.lat, lon: f.lon, tst: f.tst, alt: f.alt, acc: f.acc, batt: f.batt, topic });
    out.push({ _type: 'card', name: f.callsign ? `${f.callsign} ${f.name}` : f.name, tid, topic: `${topic}/info` });
  }
  return out;
}

export async function owntracksRoutes(app: FastifyInstance, d: OwnTracksDeps): Promise<void> {
  const { cfg, devices, tracking, users, audit } = d;

  // ------------------------------------------------------------ ingest
  app.post('/ot', { config: { rateLimit: { max: 240, timeWindow: '1 minute', keyGenerator: (req: FastifyRequest) => parseBasicAuth(req.headers.authorization)?.username ?? req.ip } } }, async (req, reply) => {
    const creds = parseBasicAuth(req.headers.authorization);
    const device = creds ? devices.authenticate(creds.username, creds.password) : undefined;
    if (!device) {
      reply.header('www-authenticate', 'Basic realm="owntracks"');
      return reply.code(401).send({ error: 'unauthorised' });
    }
    const body = req.body as { _type?: string } | undefined;
    if (!body || typeof body !== 'object' || typeof body._type !== 'string') return reply.send([]);
    if (body._type !== 'location') return reply.send([]); // transition/waypoint/status/lwt/beacon: acknowledged, dropped
    const raw = parseLocation(body);
    if (!raw) {
      req.log.warn({ device: device.username }, 'owntracks: invalid location dropped');
      return reply.send([]);
    }
    const user = users.byId(device.user_id);
    if (!user) return reply.code(401).send({ error: 'unauthorised' });
    devices.updateLast(device.id, raw, req.ip);
    const fix = tracking.ingest(device, { id: user.id, name: user.name, callsign: user.callsign }, raw);
    if (fix) d.onFix(fix);
    if (!cfg.search.owntracksFriends || !d.incidentOpen()) return reply.send([]);
    const others = tracking.recent(3600, user.id);
    return reply.send(friendsReply(others, (uid) => devices.listForUser(uid).find((x) => !x.revoked_at)?.username));
  });

  // ------------------------------------------------------------ device management
  const own = (req: FastifyRequest, reply: FastifyReply, dev: DeviceRow | undefined): dev is DeviceRow => {
    const p = req.principal!;
    if (!dev) {
      reply.code(404).send({ error: 'device not found' });
      return false;
    }
    if (p.kind === 'user' && (p.userId === dev.user_id || p.role === 'admin')) return true;
    reply.code(403).send({ error: 'forbidden' });
    return false;
  };

  app.get<{ Querystring: { userId?: string } }>('/api/devices', { preHandler: requireAuth(d) }, async (req, reply) => {
    const p = req.principal!;
    if (p.kind !== 'user') return reply.code(403).send({ error: 'forbidden' });
    const target = req.query.userId ? Number(req.query.userId) : p.userId;
    if (target !== p.userId && p.role === 'member') return reply.code(403).send({ error: 'forbidden' });
    return { devices: devices.listForUser(target).map(toDevicePublic) };
  });

  const publicUrl = (req: FastifyRequest) => cfg.auth.publicUrl || `${req.protocol}://${req.headers.host}`;

  const createDevice = (req: FastifyRequest, reply: FastifyReply, name: string | undefined) => {
    const p = req.principal!;
    if (p.kind !== 'user') {
      reply.code(403).send({ error: 'forbidden' });
      return undefined;
    }
    const user = users.byId(p.userId)!;
    if (devices.listForUser(user.id).filter((x) => !x.revoked_at).length >= 5) {
      reply.code(400).send({ error: 'device limit reached (5); revoke one first' });
      return undefined;
    }
    const { device, secret } = devices.create(user, name?.trim() || deviceNameFromUa(req.headers['user-agent']));
    const otrc = devices.config(device, secret, publicUrl(req));
    audit.log(p, req.ip, 'device.created', { type: 'device', id: device.id }, { username: device.username });
    return { device: toDevicePublic(device), secret, otrc, configLink: devices.configLink(otrc), expiresAt: devices.fresh(device.id)!.expiresAt };
  };

  app.post<{ Body: { name?: string } }>('/api/devices', { preHandler: requireAuth(d) }, async (req, reply) => createDevice(req, reply, req.body?.name));

  /**
   * One-tap setup from the phone itself: credentials for *this* phone, handed straight to the
   * OwnTracks app via the config link. Live devices that never reported are revoked first so
   * repeating the setup does not accumulate dead logins; a phone already sending fixes is kept.
   */
  app.post<{ Body: { name?: string } }>('/api/devices/link', { preHandler: requireAuth(d), config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const p = req.principal!;
    if (p.kind !== 'user') return reply.code(403).send({ error: 'forbidden' });
    const revoked = devices.revokeUnseenForUser(p.userId);
    if (revoked) audit.log(p, req.ip, 'device.revoked', { type: 'user', id: p.userId }, { unseen: revoked });
    return createDevice(req, reply, req.body?.name);
  });

  /** The config link again while the secret is still held (page reloaded before the tap). */
  app.get<{ Params: { id: string } }>('/api/devices/:id/link', { preHandler: requireAuth(d) }, async (req, reply) => {
    const dev = devices.byId(Number(req.params.id));
    if (!own(req, reply, dev)) return;
    const f = devices.fresh(dev.id);
    if (!f || dev.revoked_at) return reply.code(410).send({ error: 'secret no longer available; link the phone again' });
    reply.header('cache-control', 'no-store');
    return { device: toDevicePublic(dev), configLink: devices.configLink(devices.config(dev, f.secret, publicUrl(req))), expiresAt: f.expiresAt };
  });

  app.get<{ Params: { id: string } }>('/api/devices/:id/qr.svg', { preHandler: requireAuth(d) }, async (req, reply) => {
    const dev = devices.byId(Number(req.params.id));
    if (!own(req, reply, dev)) return;
    const secret = devices.freshSecret(dev.id);
    if (!secret) return reply.code(410).send({ error: 'secret no longer available; create a new device' });
    const link = devices.configLink(devices.config(dev, secret, publicUrl(req)));
    const svg = await QRCode.toString(link, { type: 'svg', errorCorrectionLevel: 'M', margin: 1, width: 320 });
    reply.header('cache-control', 'no-store').type('image/svg+xml');
    return svg;
  });

  app.get<{ Params: { id: string } }>('/api/devices/:id/config.otrc', { preHandler: requireAuth(d) }, async (req, reply) => {
    const dev = devices.byId(Number(req.params.id));
    if (!own(req, reply, dev)) return;
    const secret = devices.freshSecret(dev.id);
    if (!secret) return reply.code(410).send({ error: 'secret no longer available; create a new device' });
    reply.header('cache-control', 'no-store').header('content-disposition', `attachment; filename="howth-cg-${dev.username}.otrc"`).type('application/json');
    return devices.config(dev, secret, publicUrl(req));
  });

  app.delete<{ Params: { id: string } }>('/api/devices/:id', { preHandler: requireAuth(d) }, async (req, reply) => {
    const dev = devices.byId(Number(req.params.id));
    if (!own(req, reply, dev)) return;
    devices.revoke(dev.id);
    audit.log(req.principal, req.ip, 'device.revoked', { type: 'device', id: dev.id });
    return { ok: true };
  });

  app.get('/api/positions/latest', { preHandler: requireAuth(d, 'display') }, async () => ({ fixes: tracking.all() }));
}
