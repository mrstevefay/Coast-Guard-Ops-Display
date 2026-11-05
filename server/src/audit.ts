import type { Principal } from '../../shared/types.js';
import { now, type Db } from './db/index.js';

export interface AuditEntry {
  id: number;
  at: string;
  actorUserId?: number;
  actorIp?: string;
  action: string;
  targetType?: string;
  targetId?: string;
  detail?: unknown;
}

/** Append-only record of who changed what. Never contains passwords or secrets. */
export class Audit {
  constructor(private readonly db: Db) {}

  log(actor: Principal | undefined, ip: string | undefined, action: string, target?: { type: string; id: string | number }, detail?: unknown): void {
    this.db.run(
      'INSERT INTO audit_log (at, actor_user_id, actor_ip, action, target_type, target_id, detail) VALUES (?, ?, ?, ?, ?, ?, ?)',
      now(),
      actor?.kind === 'user' ? actor.userId : null,
      ip ?? null,
      action,
      target?.type ?? null,
      target ? String(target.id) : null,
      detail === undefined ? null : JSON.stringify(detail).slice(0, 2000),
    );
  }

  list(opts: { since?: string; limit?: number } = {}): AuditEntry[] {
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
    const rows = opts.since
      ? this.db.all('SELECT * FROM audit_log WHERE at >= ? ORDER BY id DESC LIMIT ?', opts.since, limit)
      : this.db.all('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?', limit);
    return rows.map((r: any) => ({
      id: r.id,
      at: r.at,
      actorUserId: r.actor_user_id ?? undefined,
      actorIp: r.actor_ip ?? undefined,
      action: r.action,
      targetType: r.target_type ?? undefined,
      targetId: r.target_id ?? undefined,
      detail: r.detail ? safeJson(r.detail) : undefined,
    }));
  }

  purgeOlderThan(iso: string): number {
    return this.db.run('DELETE FROM audit_log WHERE at < ?', iso).changes;
  }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
