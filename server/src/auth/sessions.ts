import type { Principal } from '../../../shared/types.js';
import { now, type Db } from '../db/index.js';
import { randomToken, sha256Hex } from './password.js';
import type { UserRow } from './users.js';

export interface SessionRow {
  id: string;
  user_id: number | null;
  kind: 'user' | 'display';
  label: string | null;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  user_agent: string | null;
  ip: string | null;
}

export interface Resolved {
  session: SessionRow;
  user?: UserRow;
  principal: Principal;
}

const DISPLAY_KEY_YEARS = 10;

/**
 * Opaque session tokens. The DB stores sha256(token); the token itself only
 * ever lives in the cookie (users) or the kiosk/Pi config (display keys).
 */
export class Sessions {
  constructor(private readonly db: Db, private readonly sessionDays: number) {}

  create(user: UserRow, meta: { userAgent?: string; ip?: string } = {}): string {
    const token = randomToken();
    const t = new Date();
    this.db.run(
      `INSERT INTO sessions (id, user_id, kind, label, created_at, last_seen_at, expires_at, user_agent, ip)
       VALUES (?, ?, 'user', NULL, ?, ?, ?, ?, ?)`,
      sha256Hex(token), user.id, t.toISOString(), t.toISOString(), new Date(t.getTime() + this.sessionDays * 86400_000).toISOString(),
      (meta.userAgent ?? '').slice(0, 200), meta.ip ?? null,
    );
    return token;
  }

  createDisplayKey(label: string): { id: string; key: string } {
    const key = `dk_${randomToken(24)}`;
    const t = new Date();
    const id = sha256Hex(key);
    this.db.run(
      `INSERT INTO sessions (id, user_id, kind, label, created_at, last_seen_at, expires_at) VALUES (?, NULL, 'display', ?, ?, ?, ?)`,
      id, label.trim().slice(0, 60) || 'display', t.toISOString(), t.toISOString(), new Date(t.getTime() + DISPLAY_KEY_YEARS * 365 * 86400_000).toISOString(),
    );
    return { id, key };
  }

  listDisplayKeys(): { id: string; label: string; createdAt: string; lastSeenAt: string }[] {
    return this.db
      .all<SessionRow>(`SELECT * FROM sessions WHERE kind = 'display' ORDER BY created_at`)
      .map((s) => ({ id: s.id, label: s.label ?? '', createdAt: s.created_at, lastSeenAt: s.last_seen_at }));
  }

  deleteById(id: string): boolean {
    return this.db.run('DELETE FROM sessions WHERE id = ?', id).changes > 0;
  }

  /** Resolve a raw token (cookie or display key). Touches last_seen and slides expiry for users. */
  resolve(token: string | undefined, users: { byId(id: number): UserRow | undefined }): Resolved | undefined {
    if (!token || token.length < 20 || token.length > 200) return undefined;
    const id = sha256Hex(token);
    const s = this.db.get<SessionRow>('SELECT * FROM sessions WHERE id = ?', id);
    if (!s) return undefined;
    const nowMs = Date.now();
    if (Date.parse(s.expires_at) < nowMs) {
      this.db.run('DELETE FROM sessions WHERE id = ?', id);
      return undefined;
    }
    if (s.kind === 'display') {
      if (nowMs - Date.parse(s.last_seen_at) > 60_000) this.db.run('UPDATE sessions SET last_seen_at = ? WHERE id = ?', now(), id);
      return { session: s, principal: { kind: 'display', label: s.label ?? 'display' } };
    }
    const user = s.user_id ? users.byId(s.user_id) : undefined;
    if (!user || user.active !== 1) {
      this.db.run('DELETE FROM sessions WHERE id = ?', id);
      return undefined;
    }
    // sliding expiry, touched at most once a day
    if (nowMs - Date.parse(s.last_seen_at) > 86400_000) {
      this.db.run('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?', now(), new Date(nowMs + this.sessionDays * 86400_000).toISOString(), id);
    }
    return { session: s, user, principal: { kind: 'user', userId: user.id, role: user.role, name: user.name } };
  }

  revoke(token: string): void {
    this.db.run('DELETE FROM sessions WHERE id = ?', sha256Hex(token));
  }

  revokeAllForUser(userId: number, exceptToken?: string): number {
    if (exceptToken) return this.db.run('DELETE FROM sessions WHERE user_id = ? AND id <> ?', userId, sha256Hex(exceptToken)).changes;
    return this.db.run('DELETE FROM sessions WHERE user_id = ?', userId).changes;
  }

  purgeExpired(): number {
    return this.db.run('DELETE FROM sessions WHERE expires_at < ?', now()).changes;
  }
}
