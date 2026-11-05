import type { DevicePublic } from '../../../shared/types.js';
import { randomToken, sha256Hex } from '../auth/password.js';
import type { UserRow } from '../auth/users.js';
import { now, type Db } from '../db/index.js';

export interface DeviceRow {
  id: number;
  user_id: number;
  name: string;
  username: string;
  secret_hash: string;
  tid: string;
  created_at: string;
  last_seen_at: string | null;
  last_ip: string | null;
  revoked_at: string | null;
  last_lat: number | null;
  last_lon: number | null;
  last_alt: number | null;
  last_acc: number | null;
  last_batt: number | null;
  last_tst: number | null;
}

export interface OwnTracksConfig {
  _type: 'configuration';
  mode: 3;
  url: string;
  username: string;
  password: string;
  deviceId: string;
  tid: string;
  auth: true;
  monitoring: number;
  locatorInterval: number;
  locatorDisplacement: number;
  pubExtendedData: true;
  ignoreInaccurateLocations: number;
  ignoreStaleLocations: number;
  autostartOnBoot: true;
  cleanSession: true;
}

const SECRET_TTL_MS = 10 * 60_000;

export function slug(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'device';
}

/** Two-letter tracker id OwnTracks shows on the map: callsign letters, else initials. */
export function tidFor(user: Pick<UserRow, 'name' | 'callsign'>): string {
  const cs = (user.callsign ?? '').replace(/[^A-Za-z0-9]/g, '');
  if (cs.length >= 2) return cs.slice(0, 2).toUpperCase();
  const parts = user.name.trim().split(/\s+/);
  const ini = (parts[0]?.[0] ?? 'X') + (parts[1]?.[0] ?? parts[0]?.[1] ?? 'X');
  return ini.toUpperCase();
}

export class Devices {
  /** Plain secrets kept only briefly so the QR/config can be shown after creation. */
  private freshSecrets = new Map<number, { secret: string; expires: number }>();
  /** Verified Basic-auth cache: username → { hash, deviceId } (avoids a DB hit per fix). */
  private authCache = new Map<string, { secretHash: string; device: DeviceRow; cachedAt: number }>();

  constructor(private readonly db: Db) {}

  byId(id: number): DeviceRow | undefined {
    return this.db.get<DeviceRow>('SELECT * FROM devices WHERE id = ?', id);
  }

  byUsername(username: string): DeviceRow | undefined {
    return this.db.get<DeviceRow>('SELECT * FROM devices WHERE username = ?', username);
  }

  listForUser(userId: number): DeviceRow[] {
    return this.db.all<DeviceRow>('SELECT * FROM devices WHERE user_id = ? ORDER BY created_at', userId);
  }

  listAll(): DeviceRow[] {
    return this.db.all<DeviceRow>('SELECT * FROM devices ORDER BY user_id, created_at');
  }

  create(user: UserRow, name: string): { device: DeviceRow; secret: string } {
    const clean = name.trim().slice(0, 40) || 'phone';
    const base = `${slug(user.name)}-${slug(clean)}`;
    let username = base;
    for (let i = 2; this.byUsername(username); i++) username = `${base}-${i}`;
    const secret = randomToken(24);
    const r = this.db.run(
      'INSERT INTO devices (user_id, name, username, secret_hash, tid, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      user.id, clean, username, sha256Hex(secret), tidFor(user), now(),
    );
    const device = this.byId(r.lastInsertRowid)!;
    this.freshSecrets.set(device.id, { secret, expires: Date.now() + SECRET_TTL_MS });
    return { device, secret };
  }

  /** The plain secret, only while fresh (for QR / config download right after creation). */
  freshSecret(deviceId: number): string | undefined {
    const f = this.freshSecrets.get(deviceId);
    if (!f) return undefined;
    if (f.expires < Date.now()) {
      this.freshSecrets.delete(deviceId);
      return undefined;
    }
    return f.secret;
  }

  revoke(id: number): void {
    const d = this.byId(id);
    if (!d) return;
    this.db.run('UPDATE devices SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?', now(), id);
    this.authCache.delete(d.username);
    this.freshSecrets.delete(id);
  }

  /** Basic-auth check for /ot. Returns the device when username+secret match and it is live. */
  authenticate(username: string, secret: string): DeviceRow | undefined {
    const hash = sha256Hex(secret);
    const cached = this.authCache.get(username);
    if (cached && cached.secretHash === hash && Date.now() - cached.cachedAt < 60_000) return cached.device;
    const d = this.byUsername(username);
    if (!d || d.revoked_at || d.secret_hash !== hash) return undefined;
    const user = this.db.get<{ active: number }>('SELECT active FROM users WHERE id = ?', d.user_id);
    if (!user || user.active !== 1) return undefined;
    this.authCache.set(username, { secretHash: hash, device: d, cachedAt: Date.now() });
    return d;
  }

  updateLast(id: number, fix: { lat: number; lon: number; alt?: number; acc?: number; batt?: number; tst: number }, ip?: string): void {
    this.db.run(
      'UPDATE devices SET last_seen_at = ?, last_ip = ?, last_lat = ?, last_lon = ?, last_alt = ?, last_acc = ?, last_batt = ?, last_tst = ? WHERE id = ?',
      now(), ip ?? null, fix.lat, fix.lon, fix.alt ?? null, fix.acc ?? null, fix.batt ?? null, fix.tst, id,
    );
  }

  clearStaleLast(olderThanHours: number): number {
    const cutoff = Math.floor(Date.now() / 1000) - olderThanHours * 3600;
    return this.db.run('UPDATE devices SET last_lat = NULL, last_lon = NULL, last_alt = NULL, last_acc = NULL WHERE last_tst IS NOT NULL AND last_tst < ?', cutoff).changes;
  }

  /** OwnTracks configuration for this device (HTTP mode). */
  config(device: DeviceRow, secret: string, publicUrl: string): OwnTracksConfig {
    return {
      _type: 'configuration',
      mode: 3,
      url: `${publicUrl.replace(/\/$/, '')}/ot`,
      username: device.username,
      password: secret,
      deviceId: slug(device.name),
      tid: device.tid,
      auth: true,
      monitoring: 2,
      locatorInterval: 30,
      locatorDisplacement: 20,
      pubExtendedData: true,
      ignoreInaccurateLocations: 100,
      ignoreStaleLocations: 1,
      autostartOnBoot: true,
      cleanSession: true,
    };
  }

  /** One-tap import link understood by the OwnTracks app (iOS and Android). */
  configLink(cfg: OwnTracksConfig): string {
    return `owntracks:///config?inline=${Buffer.from(JSON.stringify(cfg)).toString('base64')}`;
  }
}

export function toDevicePublic(d: DeviceRow): DevicePublic {
  return {
    id: d.id,
    userId: d.user_id,
    name: d.name,
    username: d.username,
    tid: d.tid,
    createdAt: d.created_at,
    lastSeenAt: d.last_seen_at ?? undefined,
    revokedAt: d.revoked_at ?? undefined,
  };
}
