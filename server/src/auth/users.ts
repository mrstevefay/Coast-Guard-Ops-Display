import type { Role, UserPublic } from '../../../shared/types.js';
import { now, type Db } from '../db/index.js';
import { hashPassword, tempPassword, verifyPassword } from './password.js';

export interface UserRow {
  id: number;
  email: string;
  name: string;
  callsign: string | null;
  role: Role;
  password_hash: string;
  must_change_password: number;
  active: number;
  privacy_accepted_at: string | null;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
}

export const ROLE_RANK: Record<Role, number> = { member: 1, manager: 2, admin: 3 };
export const hasRole = (have: Role, need: Role) => ROLE_RANK[have] >= ROLE_RANK[need];

export function toPublic(u: UserRow, extra: Partial<UserPublic> = {}): UserPublic {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    callsign: u.callsign ?? undefined,
    role: u.role,
    active: u.active === 1,
    mustChangePassword: u.must_change_password === 1,
    privacyAcceptedAt: u.privacy_accepted_at ?? undefined,
    lastLoginAt: u.last_login_at ?? undefined,
    ...extra,
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class Users {
  constructor(private readonly db: Db) {}

  count(): number {
    return (this.db.get<{ n: number }>('SELECT COUNT(*) n FROM users')?.n) ?? 0;
  }

  byId(id: number): UserRow | undefined {
    return this.db.get<UserRow>('SELECT * FROM users WHERE id = ?', id);
  }

  byEmail(email: string): UserRow | undefined {
    return this.db.get<UserRow>('SELECT * FROM users WHERE email = ? COLLATE NOCASE', email.trim());
  }

  list(): UserRow[] {
    return this.db.all<UserRow>('SELECT * FROM users ORDER BY active DESC, name COLLATE NOCASE');
  }

  create(input: { email: string; name: string; callsign?: string; role: Role; password?: string; mustChange?: boolean }): { user: UserRow; tempPassword?: string } {
    const email = input.email.trim().toLowerCase();
    if (!EMAIL_RE.test(email)) throw new Error('invalid email');
    const name = input.name.trim();
    if (!name) throw new Error('name is required');
    if (!['admin', 'manager', 'member'].includes(input.role)) throw new Error('invalid role');
    if (this.byEmail(email)) throw new Error('email already in use');
    const generated = input.password ? undefined : tempPassword();
    const password = input.password ?? generated!;
    if (password.length < 8) throw new Error('password must be at least 8 characters');
    const t = now();
    const r = this.db.run(
      `INSERT INTO users (email, name, callsign, role, password_hash, must_change_password, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      email, name, input.callsign?.trim() || null, input.role, hashPassword(password), input.mustChange === false ? 0 : 1, t, t,
    );
    return { user: this.byId(r.lastInsertRowid)!, tempPassword: generated };
  }

  update(id: number, patch: { name?: string; callsign?: string | null; role?: Role; active?: boolean; email?: string }): UserRow {
    const u = this.byId(id);
    if (!u) throw new Error('user not found');
    const email = patch.email !== undefined ? patch.email.trim().toLowerCase() : u.email;
    if (!EMAIL_RE.test(email)) throw new Error('invalid email');
    const other = this.byEmail(email);
    if (other && other.id !== id) throw new Error('email already in use');
    if (patch.role && !['admin', 'manager', 'member'].includes(patch.role)) throw new Error('invalid role');
    this.db.run(
      'UPDATE users SET name = ?, callsign = ?, role = ?, active = ?, email = ?, updated_at = ? WHERE id = ?',
      patch.name?.trim() || u.name,
      patch.callsign === undefined ? u.callsign : patch.callsign?.trim() || null,
      patch.role ?? u.role,
      patch.active === undefined ? u.active : patch.active ? 1 : 0,
      email,
      now(),
      id,
    );
    return this.byId(id)!;
  }

  /** Verify credentials; returns the user or undefined. Inactive users never match. */
  authenticate(email: string, password: string): UserRow | undefined {
    const u = this.byEmail(email);
    if (!u || u.active !== 1) {
      // burn comparable time so timing doesn't reveal account existence
      verifyPassword(password, DUMMY_HASH);
      return undefined;
    }
    if (!verifyPassword(password, u.password_hash)) return undefined;
    this.db.run('UPDATE users SET last_login_at = ? WHERE id = ?', now(), u.id);
    return u;
  }

  setPassword(id: number, password: string, mustChange = false): void {
    if (password.length < 8) throw new Error('password must be at least 8 characters');
    this.db.run('UPDATE users SET password_hash = ?, must_change_password = ?, updated_at = ? WHERE id = ?', hashPassword(password), mustChange ? 1 : 0, now(), id);
  }

  resetPassword(id: number): string {
    const pw = tempPassword();
    this.setPassword(id, pw, true);
    return pw;
  }

  acceptPrivacy(id: number): void {
    this.db.run('UPDATE users SET privacy_accepted_at = ?, updated_at = ? WHERE id = ?', now(), now(), id);
  }

  /** GDPR-style delete: anonymise rather than remove (positions keep their team context). */
  anonymise(id: number): void {
    const t = now();
    this.db.tx(() => {
      this.db.run(
        `UPDATE users SET name = 'Deleted user', email = ?, callsign = NULL, active = 0, password_hash = 'deleted', updated_at = ? WHERE id = ?`,
        `deleted-${id}@invalid`, t, id,
      );
      this.db.run('UPDATE devices SET revoked_at = COALESCE(revoked_at, ?), last_lat = NULL, last_lon = NULL, last_alt = NULL WHERE user_id = ?', t, id);
      this.db.run('DELETE FROM sessions WHERE user_id = ?', id);
      this.db.run('UPDATE positions SET user_id = NULL WHERE user_id = ?', id);
    });
  }

  /**
   * First-run bootstrap: create the admin from config/env when the users table
   * is empty. Returns true if created.
   */
  bootstrapAdmin(email: string, password: string, name = 'Admin'): boolean {
    if (this.count() > 0 || !email || !password) return false;
    this.create({ email, name, role: 'admin', password, mustChange: true });
    return true;
  }
}

const DUMMY_HASH = hashPassword('dummy-password-for-timing');
