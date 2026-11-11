import webpush from 'web-push';
import type { AlertsAdminStatus, AlertsStatus } from '../../shared/types.js';
import { now, type Db } from './db/index.js';

/**
 * Web Push to crew phones: a callout, a stand-down, a target for your team.
 *
 * It backs up the pager, it never replaces it: delivery depends on the phone's push service
 * (Apple, Google, Mozilla) and on the member having turned alerts on for that phone.
 * Payloads are encrypted end to end for the phone, so the push service cannot read them.
 * The VAPID key pair that identifies this server is made on first use and kept in the database.
 */

export interface PushMessage {
  title: string;
  body: string;
  /** Notifications with the same tag replace each other on the phone. */
  tag: string;
  /** Where a tap goes, inside the crew app. */
  url?: string;
  /** Callouts: keep it on screen and vibrate hard. */
  urgent?: boolean;
}

export interface PushSubscriptionInput { endpoint?: string; keys?: { p256dh?: string; auth?: string } }
interface SubRow { id: number; user_id: number; endpoint: string; p256dh: string; auth: string }

/** Sends one notification; replaced in tests. Rejects with `statusCode` when the push service refuses. */
export type PushSender = (sub: { endpoint: string; keys: { p256dh: string; auth: string } }, payload: string, opts: { vapid: { subject: string; publicKey: string; privateKey: string }; ttl: number; urgent: boolean }) => Promise<unknown>;

const realSender: PushSender = (sub, payload, o) => webpush.sendNotification(sub, payload, { vapidDetails: o.vapid, TTL: o.ttl, urgency: o.urgent ? 'high' : 'normal', timeout: 10_000 });

/**
 * Push services we will post to. A subscription's endpoint comes from the member's browser, so
 * without this a signed-in member could make the server send requests to any address.
 */
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /(^|\.)push\.apple\.com$/, /^updates\.push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/, /(^|\.)push\.services\.mozilla\.com$/];

interface OffRecord { until?: string; reason?: string; at: string; by?: number; byName?: string }
const OFF_KEY = 'alerts.off';

export class Push {
  private keys?: { publicKey: string; privateKey: string };
  private reopen?: NodeJS.Timeout;
  /** Told whenever the switch changes (including coming back on by itself), so screens can show it. */
  onChange?: (s: AlertsStatus) => void;

  constructor(
    private readonly db: Db,
    private readonly publicUrl: string,
    private readonly log: { info: Function; warn: Function },
    private readonly sender: PushSender = realSender,
  ) {}

  private vapid(): { subject: string; publicKey: string; privateKey: string } {
    if (!this.keys) {
      const get = (k: string) => this.db.get<{ value: string }>('SELECT value FROM app_secrets WHERE key = ?', k)?.value;
      let publicKey = get('vapid.public'), privateKey = get('vapid.private');
      if (!publicKey || !privateKey) {
        ({ publicKey, privateKey } = webpush.generateVAPIDKeys());
        this.db.tx(() => {
          this.db.run('INSERT OR REPLACE INTO app_secrets (key, value) VALUES (?, ?)', 'vapid.public', publicKey!);
          this.db.run('INSERT OR REPLACE INTO app_secrets (key, value) VALUES (?, ?)', 'vapid.private', privateKey!);
        });
      }
      this.keys = { publicKey, privateKey };
    }
    // the subject tells the push service who runs this server: the site's own address
    return { subject: this.publicUrl.startsWith('https://') ? this.publicUrl : 'https://ops-display.invalid', ...this.keys };
  }

  publicKey(): string {
    return this.vapid().publicKey;
  }

  // ------------------------------------------------------------ the station-wide switch
  private offRecord(): OffRecord | undefined {
    const row = this.db.get<{ value: string }>('SELECT value FROM app_flags WHERE key = ?', OFF_KEY);
    if (!row) return undefined;
    try {
      const r = JSON.parse(row.value) as OffRecord;
      if (r.until && Date.parse(r.until) <= Date.now()) {
        // the time is up: alerts are on again
        this.db.run('DELETE FROM app_flags WHERE key = ?', OFF_KEY);
        this.log.info({}, 'alerts back on: switch-off period ended');
        return undefined;
      }
      return r;
    } catch {
      return undefined;
    }
  }

  enabled(): boolean {
    return !this.offRecord();
  }

  status(): AlertsStatus {
    const off = this.offRecord();
    return off ? { enabled: false, ...(off.until ? { until: off.until } : {}) } : { enabled: true };
  }

  adminStatus(): AlertsAdminStatus {
    const off = this.offRecord();
    const counts = this.counts();
    return {
      ...this.status(),
      ...(off ? { reason: off.reason, changedAt: off.at, changedBy: off.byName } : {}),
      members: counts.size,
      phones: [...counts.values()].reduce((a, b) => a + b, 0),
    };
  }

  /**
   * Switch callout alerts off for every phone, for `hours` or until switched back on (no hours),
   * or back on. Phones stay subscribed, so switching back on needs nothing from the crew.
   */
  setEnabled(on: boolean, opts: { hours?: number; reason?: string; by?: { id: number; name: string } } = {}): AlertsStatus {
    if (on) this.db.run('DELETE FROM app_flags WHERE key = ?', OFF_KEY);
    else {
      const hours = opts.hours === undefined || opts.hours === null ? undefined : Number(opts.hours);
      if (hours !== undefined && !(hours > 0 && hours <= 24 * 30)) throw new Error('hours must be between 0 and 720');
      const rec: OffRecord = { at: now(), ...(hours ? { until: new Date(Date.now() + hours * 3600_000).toISOString() } : {}), ...(opts.reason?.trim() ? { reason: opts.reason.trim().slice(0, 200) } : {}), ...(opts.by ? { by: opts.by.id, byName: opts.by.name } : {}) };
      this.db.run('INSERT OR REPLACE INTO app_flags (key, value, updated_at) VALUES (?, ?, ?)', OFF_KEY, JSON.stringify(rec), rec.at);
    }
    this.announce();
    return this.status();
  }

  /** Tell the screens, and wake up to switch back on when an off period ends. */
  announce(): void {
    if (this.reopen) clearTimeout(this.reopen);
    this.reopen = undefined;
    const s = this.status();
    if (s.until) {
      this.reopen = setTimeout(() => this.announce(), Math.min(Math.max(0, Date.parse(s.until) - Date.now()) + 1000, 2 ** 31 - 1));
      this.reopen.unref?.();
    }
    this.onChange?.(s);
  }

  /** Remember this phone's subscription for this member (a phone belongs to whoever signed in last). */
  subscribe(userId: number, sub: PushSubscriptionInput, userAgent?: string): void {
    const endpoint = String(sub?.endpoint ?? ''), p256dh = String(sub?.keys?.p256dh ?? ''), auth = String(sub?.keys?.auth ?? '');
    let host = '';
    try {
      const u = new URL(endpoint);
      if (u.protocol === 'https:') host = u.hostname;
    } catch { /* not a URL */ }
    if (!host || !PUSH_HOSTS.some((re) => re.test(host))) throw new Error('this browser’s push service is not supported');
    if (endpoint.length > 1000 || !/^[\w-]{20,200}$/.test(p256dh) || !/^[\w-]{10,60}$/.test(auth)) throw new Error('invalid subscription');
    const t = now();
    this.db.run(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent, failures = 0`,
      userId, endpoint, p256dh, auth, userAgent?.slice(0, 200) ?? null, t,
    );
  }

  unsubscribe(userId: number, endpoint: string): boolean {
    return this.db.run('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?', userId, endpoint).changes > 0;
  }

  /** Is this phone (endpoint) subscribed for this member? */
  has(userId: number, endpoint: string): boolean {
    return Boolean(this.db.get('SELECT 1 FROM push_subscriptions WHERE user_id = ? AND endpoint = ?', userId, endpoint));
  }

  /** Phones with alerts on, per member. */
  counts(): Map<number, number> {
    return new Map(this.db.all<{ user_id: number; n: number }>('SELECT user_id, COUNT(*) n FROM push_subscriptions GROUP BY user_id').map((r) => [r.user_id, r.n]));
  }

  /** Forget a member's phones (account removed or deactivated). */
  forgetUser(userId: number): void {
    this.db.run('DELETE FROM push_subscriptions WHERE user_id = ?', userId);
  }

  /**
   * Send to these members' phones, or to every active member's with 'all'. Never throws: a phone
   * that cannot be reached must not hold up a callout. Subscriptions the push service says are gone
   * (404, 410) are dropped; others are dropped after ten failures in a row.
   */
  async notify(to: number[] | 'all', msg: PushMessage): Promise<{ sent: number; failed: number; removed: number; off?: boolean }> {
    const out = { sent: 0, failed: 0, removed: 0 };
    let rows: SubRow[];
    try {
      if (!this.enabled()) {
        this.log.info({ tag: msg.tag }, 'push not sent: alerts are switched off');
        return { ...out, off: true };
      }
      const active = 'JOIN users u ON u.id = s.user_id AND u.active = 1';
      if (to === 'all') rows = this.db.all<SubRow>(`SELECT s.id, s.user_id, s.endpoint, s.p256dh, s.auth FROM push_subscriptions s ${active}`);
      else if (!to.length) return out;
      else rows = this.db.all<SubRow>(`SELECT s.id, s.user_id, s.endpoint, s.p256dh, s.auth FROM push_subscriptions s ${active} WHERE s.user_id IN (${to.map(() => '?').join(',')})`, ...to);
      if (!rows.length) return out;
      const vapid = this.vapid();
      const payload = JSON.stringify({ title: msg.title.slice(0, 80), body: msg.body.slice(0, 300), tag: msg.tag, url: msg.url ?? '/m/', urgent: Boolean(msg.urgent) });
      await Promise.all(rows.map(async (r) => {
        try {
          await this.sender({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } }, payload, { vapid, ttl: msg.urgent ? 3600 : 900, urgent: Boolean(msg.urgent) });
          out.sent++;
          this.db.run('UPDATE push_subscriptions SET last_ok_at = ?, failures = 0 WHERE id = ?', now(), r.id);
        } catch (e) {
          out.failed++;
          const status = (e as { statusCode?: number }).statusCode;
          const gone = status === 404 || status === 410;
          if (gone) this.db.run('DELETE FROM push_subscriptions WHERE id = ?', r.id);
          else {
            this.db.run('UPDATE push_subscriptions SET failures = failures + 1 WHERE id = ?', r.id);
            if (this.db.run('DELETE FROM push_subscriptions WHERE id = ? AND failures >= 10', r.id).changes) out.removed++;
          }
          if (gone) out.removed++;
        }
      }));
      this.log.info({ tag: msg.tag, ...out }, 'push');
    } catch (e) {
      this.log.warn({ err: String(e), tag: msg.tag }, 'push failed');
    }
    return out;
  }
}
