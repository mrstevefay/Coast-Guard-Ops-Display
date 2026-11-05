import type { DevicePublic } from '../../../shared/types';
import { get, post } from '../api';
import { store } from './store';

/**
 * One-tap OwnTracks setup for the phone the crew app is running on.
 *
 * On first open (and again whenever this phone's credential has been revoked) the app asks the
 * server for a fresh device credential and keeps the `owntracks:///config?inline=` link ready.
 * The Status page shows a setup card whose button is that link; tapping "I'm responding" for
 * the first time launches it as well. Browsers only hand custom-scheme links to the app from a
 * user gesture, so the launch is always tied to a tap, but nothing else is asked of the crew:
 * no name, no QR, no copying of secrets.
 */

interface Linked {
  userId: number;
  deviceId: number;
  at: string;
}

interface LinkResponse {
  device: DevicePublic;
  configLink: string;
  expiresAt: string;
}

const KEY = 'cg_ot_device';
const PENDING_KEY = 'cg_ot_pending';

export interface Pending {
  deviceId: number;
  link: string;
  expiresAt: number;
}

class Tracking {
  /** Credential created for this phone and not yet handed to OwnTracks. */
  pending?: Pending;
  /** "Not now" pressed this session. */
  dismissed = false;
  private preparing?: Promise<void>;

  get isMobile(): boolean {
    const ua = navigator.userAgent;
    return /iPhone|iPad|iPod|Android/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  }

  /** This browser already pushed a credential to OwnTracks (and it is still live). */
  get linked(): Linked | undefined {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return undefined;
      const l = JSON.parse(raw) as Linked;
      return l.userId === store.s.me?.id ? l : undefined;
    } catch {
      return undefined;
    }
  }

  /** The setup card should be shown. */
  get needsSetup(): boolean {
    return Boolean(this.pending) && !this.dismissed && !this.linked;
  }

  /** Decide whether this phone needs a credential and, if so, fetch one. Safe to call often. */
  prepare(force = false): Promise<void> {
    if (!this.preparing) this.preparing = this.run(force).finally(() => (this.preparing = undefined));
    return this.preparing;
  }

  private async run(force: boolean): Promise<void> {
    const me = store.s.me;
    if (!me || me.id === 0) return; // open mode: no accounts, no tracking
    if (!force && !this.isMobile) return; // laptops do not run OwnTracks
    const { devices } = await get<{ devices: DevicePublic[] }>('/api/devices');
    const live = devices.filter((d) => !d.revokedAt);
    const linked = this.linked;
    if (force || (linked && !live.some((d) => d.id === linked.deviceId))) localStorage.removeItem(KEY); // re-send, or revoked: set up again
    else if (linked) return;
    if (this.pending && this.pending.expiresAt > Date.now() + 30_000 && live.some((d) => d.id === this.pending!.deviceId) && !force) return;
    // A credential issued before a reload is still usable for ten minutes: reuse it rather than
    // minting (and revoking) another one on every page load.
    const held = force ? undefined : Number(sessionStorage.getItem(PENDING_KEY) || 0);
    if (held && live.some((d) => d.id === held)) {
      try {
        const r = await get<LinkResponse>(`/api/devices/${held}/link`);
        if (Date.parse(r.expiresAt) > Date.now() + 30_000) return this.setPending(r);
      } catch {
        /* expired or revoked: fall through to a new one */
      }
    }
    this.setPending(await post<LinkResponse>('/api/devices/link'));
  }

  private setPending(r: LinkResponse): void {
    this.pending = { deviceId: r.device.id, link: r.configLink, expiresAt: Date.parse(r.expiresAt) };
    try {
      sessionStorage.setItem(PENDING_KEY, String(r.device.id));
    } catch {
      /* private mode */
    }
    store.notify();
  }

  /** Called from the tap that opens the link: remember this phone is set up. */
  markLaunched(): void {
    const p = this.pending;
    const me = store.s.me;
    if (!p || !me) return;
    try {
      localStorage.setItem(KEY, JSON.stringify({ userId: me.id, deviceId: p.deviceId, at: new Date().toISOString() } satisfies Linked));
    } catch {
      /* private mode: the card simply shows again next time */
    }
    this.pending = undefined;
    try {
      sessionStorage.removeItem(PENDING_KEY);
    } catch {
      /* ignore */
    }
    store.notify();
  }

  /**
   * Launch OwnTracks with the credential from inside a user gesture (e.g. the respond button).
   * Returns false when nothing is pending or the credential has expired (a fresh one is then
   * requested in the background and the setup card reappears).
   */
  launch(): boolean {
    const p = this.pending;
    if (!p) return false;
    if (p.expiresAt < Date.now()) {
      this.pending = undefined;
      void this.prepare(true);
      return false;
    }
    this.markLaunched();
    location.href = p.link;
    return true;
  }

  dismiss(): void {
    this.dismissed = true;
    store.notify();
  }
}

export const tracking = new Tracking();
