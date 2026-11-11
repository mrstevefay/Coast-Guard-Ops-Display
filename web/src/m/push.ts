import { get, post } from '../api';
import { store } from './store';

/**
 * Callout alerts on this phone (Web Push). Each phone is turned on by its owner; the server keeps
 * the phone's subscription and sends to it on a callout, a stand-down and a new target.
 *
 * iPhone and iPad only allow this once the app is on the Home Screen, so there the first step is
 * "Add to Home Screen", not a permission prompt.
 */
export type PushState = 'unsupported' | 'needs-install' | 'blocked' | 'off' | 'on';

const DISMISS_KEY = 'cg.push.dismissed';
const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = () => (navigator as { standalone?: boolean }).standalone === true || matchMedia('(display-mode: standalone)').matches;
const capable = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

function keyBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const raw = atob((b64url + '='.repeat((4 - (b64url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
const sameKey = (a: ArrayBuffer | null | undefined, b: Uint8Array) => {
  if (!a) return false;
  const x = new Uint8Array(a);
  return x.length === b.length && x.every((v, i) => v === b[i]);
};

/** The service worker, or undefined when there is none after a few seconds (a dev server, a blocked worker). */
async function registration(): Promise<ServiceWorkerRegistration | undefined> {
  if (!capable()) return undefined;
  return Promise.race([navigator.serviceWorker.ready, new Promise<undefined>((r) => setTimeout(() => r(undefined), 4000))]);
}

class PushAlerts {
  state: PushState = capable() ? 'off' : ios && !standalone() ? 'needs-install' : 'unsupported';
  busy = false;

  /** Has the station switched alerts off for everyone? */
  get stationOff(): boolean {
    return store.s.state?.alerts?.enabled === false;
  }

  /** Should the Status page offer to turn alerts on? Once per phone until answered; not while the station has them off. */
  get shouldOffer(): boolean {
    if (this.stationOff) return false;
    let dismissed = false;
    try { dismissed = localStorage.getItem(DISMISS_KEY) === '1'; } catch { /* private mode */ }
    return !dismissed && (this.state === 'off' || this.state === 'needs-install');
  }

  dismiss(): void {
    try { localStorage.setItem(DISMISS_KEY, '1'); } catch { /* private mode */ }
    store.notify();
  }

  private set(s: PushState): void {
    if (this.state === s) return;
    this.state = s;
    store.notify();
  }

  /**
   * Work out where this phone stands, and keep the server in step: a phone that is already
   * subscribed is re-registered for whoever is signed in now (and for a new server key).
   */
  async refresh(): Promise<void> {
    if (!capable()) return;
    if (Notification.permission === 'denied') return this.set('blocked');
    const reg = await registration();
    if (!reg) return this.set('unsupported');
    try {
      let sub = await reg.pushManager.getSubscription();
      if (sub && Notification.permission === 'granted') {
        const key = keyBytes((await get<{ key: string }>('/api/push/key')).key);
        if (!sameKey(sub.options.applicationServerKey, key)) {
          await sub.unsubscribe();
          sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
        }
        await post('/api/push/subscriptions', { subscription: sub.toJSON() });
        return this.set('on');
      }
      this.set('off');
    } catch {
      this.set('off');
    }
  }

  /** Ask permission and subscribe. Must run from a tap. Returns a message for the member when it did not work. */
  async enable(): Promise<string | undefined> {
    if (this.state === 'needs-install') return 'Add the app to your Home Screen first, then open it from there.';
    if (!capable()) return 'This browser cannot show alerts.';
    this.busy = true;
    store.notify();
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        this.set(perm === 'denied' ? 'blocked' : 'off');
        return perm === 'denied' ? 'Alerts are blocked for this app. Allow notifications in the phone’s settings.' : undefined;
      }
      const reg = await registration();
      if (!reg) return 'Alerts are not available here. Reload the app and try again.';
      const key = keyBytes((await get<{ key: string }>('/api/push/key')).key);
      const old = await reg.pushManager.getSubscription();
      if (old && !sameKey(old.options.applicationServerKey, key)) await old.unsubscribe();
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      await post('/api/push/subscriptions', { subscription: sub.toJSON() });
      this.set('on');
      return undefined;
    } catch (e) {
      return e instanceof Error && e.message ? `Could not turn alerts on: ${e.message}` : 'Could not turn alerts on.';
    } finally {
      this.busy = false;
      store.notify();
    }
  }

  async disable(): Promise<void> {
    const reg = await registration();
    const sub = await reg?.pushManager.getSubscription();
    if (sub) {
      await post('/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
      await sub.unsubscribe().catch(() => {});
    }
    this.set('off');
  }

  test(): Promise<{ sent: number; failed: number; off?: boolean }> {
    return post('/api/push/test');
  }
}

export const pushAlerts = new PushAlerts();

/** A tapped alert asks the open app to go to a page. */
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (ev) => {
    const d = ev.data as { type?: string; hash?: string } | undefined;
    if (d?.type === 'push-open' && d.hash && location.hash !== d.hash) location.hash = d.hash;
  });
}
