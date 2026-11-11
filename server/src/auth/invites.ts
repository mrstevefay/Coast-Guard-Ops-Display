import type { InvitePublic } from '../../../shared/types.js';
import { now, type Db } from '../db/index.js';
import { randomToken, sha256Hex } from './password.js';
import type { UserRow, Users } from './users.js';

interface InviteRow {
  id: string;
  token_hash: string;
  label: string | null;
  max_uses: number;
  uses: number;
  needs_approval: number;
  expires_at: string;
  revoked_at: string | null;
  created_by: number | null;
  created_at: string;
  created_by_name?: string | null;
}

/** Why an invite link cannot be used, in words for the person holding it. */
export class InviteError extends Error {
  constructor(message: string, readonly status = 410) {
    super(message);
  }
}

const isOpen = (r: InviteRow, at = Date.now()) => !r.revoked_at && Date.parse(r.expires_at) > at && r.uses < r.max_uses;

function toPublic(r: InviteRow): InvitePublic {
  return {
    id: r.id,
    label: r.label ?? undefined,
    maxUses: r.max_uses,
    uses: r.uses,
    needsApproval: r.needs_approval === 1,
    expiresAt: r.expires_at,
    revokedAt: r.revoked_at ?? undefined,
    createdAt: r.created_at,
    createdBy: r.created_by_name ?? undefined,
    open: isOpen(r),
  };
}

/**
 * Crew invite links. The token is in the link only (as a URL fragment, so it never reaches server
 * logs); the database keeps its hash. A link for one person signs them straight in; a group link
 * (more than one use) makes accounts that wait for an admin's approval unless told otherwise.
 */
export class Invites {
  constructor(private readonly db: Db, private readonly users: Users) {}

  create(input: { label?: string; maxUses?: number; days?: number; needsApproval?: boolean }, by?: number): { invite: InvitePublic; token: string } {
    const maxUses = Math.round(Number(input.maxUses ?? 1));
    if (!(maxUses >= 1 && maxUses <= 100)) throw new Error('uses must be 1 to 100');
    const days = Number(input.days ?? 7);
    if (!(days > 0 && days <= 30)) throw new Error('expiry must be 1 to 30 days');
    const label = String(input.label ?? '').trim().slice(0, 80) || null;
    // one person: no approval needed by default; a group link: approval unless switched off
    const needsApproval = input.needsApproval ?? maxUses > 1;
    const token = randomToken(24);
    const id = randomToken(6);
    const t = now();
    this.db.run(
      'INSERT INTO invites (id, token_hash, label, max_uses, uses, needs_approval, expires_at, created_by, created_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)',
      id, sha256Hex(token), label, maxUses, needsApproval ? 1 : 0, new Date(Date.now() + days * 86400_000).toISOString(), by ?? null, t,
    );
    return { invite: this.byId(id)!, token };
  }

  byId(id: string): InvitePublic | undefined {
    const r = this.db.get<InviteRow>('SELECT i.*, u.name created_by_name FROM invites i LEFT JOIN users u ON u.id = i.created_by WHERE i.id = ?', id);
    return r ? toPublic(r) : undefined;
  }

  list(): InvitePublic[] {
    return this.db.all<InviteRow>('SELECT i.*, u.name created_by_name FROM invites i LEFT JOIN users u ON u.id = i.created_by ORDER BY i.created_at DESC LIMIT 50').map(toPublic);
  }

  revoke(id: string): boolean {
    return this.db.run('UPDATE invites SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?', now(), id).changes > 0;
  }

  /** The invite behind a token, if it can still be used; otherwise an InviteError saying why. */
  check(token: string): InvitePublic {
    const r = this.db.get<InviteRow>('SELECT * FROM invites WHERE token_hash = ?', sha256Hex(token));
    if (!r) throw new InviteError('This invite link is not valid. Ask the station officer for a new one.', 404);
    if (r.revoked_at) throw new InviteError('This invite link has been withdrawn. Ask the station officer for a new one.');
    if (Date.parse(r.expires_at) <= Date.now()) throw new InviteError('This invite link has expired. Ask the station officer for a new one.');
    if (r.uses >= r.max_uses) throw new InviteError('This invite link has already been used. Ask the station officer for a new one.');
    return toPublic(r);
  }

  /** Make the account. Pending (inactive) when the invite needs approval. */
  accept(token: string, input: { name: string; email: string; callsign?: string; password: string }): { user: UserRow; pending: boolean } {
    return this.db.tx(() => {
      const inv = this.check(token);
      if (this.users.byEmail(input.email)) throw new InviteError('That email cannot be used here. Sign in instead, or ask the station officer.', 400);
      const callsign = input.callsign?.trim();
      if (callsign && callsign.length > 12) throw new InviteError('Callsign: 12 characters at most', 400);
      let user: UserRow;
      try {
        user = this.users.create({ name: input.name, email: input.email, callsign, role: 'member', password: input.password, mustChange: false }).user;
      } catch (e) {
        throw new InviteError(e instanceof Error ? e.message : 'could not create the account', 400);
      }
      this.db.run('UPDATE users SET invite_id = ?, pending = ?, active = ?, updated_at = ? WHERE id = ?', inv.id, inv.needsApproval ? 1 : 0, inv.needsApproval ? 0 : 1, now(), user.id);
      this.db.run('UPDATE invites SET uses = uses + 1 WHERE id = ?', inv.id);
      return { user: this.users.byId(user.id)!, pending: inv.needsApproval };
    });
  }

  /** Invite label per user id, for the users list. */
  labelsByUser(): Map<number, string> {
    const m = new Map<number, string>();
    for (const r of this.db.all<{ id: number; label: string | null }>('SELECT u.id, i.label FROM users u JOIN invites i ON i.id = u.invite_id')) m.set(r.id, r.label ?? 'invite link');
    return m;
  }
}
