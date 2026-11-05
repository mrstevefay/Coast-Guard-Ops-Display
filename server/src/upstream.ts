import WebSocket from 'ws';
import type { DashboardState, WsMessage } from '../../shared/types.js';
import type { AppConfig } from './config.js';
import type { StateStore } from './state.js';
import type { Hub } from './ws.js';

type Log = { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void };

/**
 * Pi-side mirror of the hosted server. Connects to UPSTREAM_URL/api/ws with a
 * display key, feeds upstream `state` into the local StateStore (which serves
 * it to the kiosk while fresh) and relays `search`/`pos` to local sockets.
 * If upstream goes quiet the store falls back to locally polled data.
 */
export class UpstreamMirror {
  private ws?: WebSocket;
  private stopped = false;
  private backoff = 2000;
  private timer?: NodeJS.Timeout;
  private lastMsgAt = 0;
  private watchdog?: NodeJS.Timeout;
  lastSearch?: Extract<WsMessage, { type: 'search' }>['search'];

  constructor(private readonly cfg: AppConfig, private readonly store: StateStore, private readonly hub: Hub, private readonly log: Log) {}

  get url(): string {
    const base = this.cfg.upstream.url.replace(/\/$/, '').replace(/^http/, 'ws');
    return `${base}/api/ws?key=${encodeURIComponent(this.cfg.upstream.key)}`;
  }

  get connected(): boolean {
    return Boolean(this.ws && this.ws.readyState === WebSocket.OPEN);
  }

  get fresh(): boolean {
    return this.connected && Date.now() - this.lastMsgAt < this.cfg.upstream.staleAfterSec * 1000;
  }

  start(): void {
    if (!this.cfg.upstream.url || !this.cfg.upstream.key) return;
    this.stopped = false;
    this.connect();
    this.watchdog = setInterval(() => {
      if (this.connected && Date.now() - this.lastMsgAt > 90_000) this.ws?.terminate();
      if (!this.fresh) this.store.setUpstream(undefined);
    }, 10_000);
    this.watchdog.unref?.();
    this.hub.onJoin = (_p, send) => {
      if (this.lastSearch && this.fresh) send({ type: 'search', search: this.lastSearch });
    };
  }

  private connect(): void {
    if (this.stopped) return;
    this.ws = new WebSocket(this.url, { handshakeTimeout: 15_000 });
    this.ws.on('open', () => {
      this.backoff = 2000;
      this.lastMsgAt = Date.now();
      this.log.info({ url: this.cfg.upstream.url }, 'upstream connected');
    });
    this.ws.on('message', (data) => {
      this.lastMsgAt = Date.now();
      let msg: WsMessage;
      try {
        msg = JSON.parse(data.toString()) as WsMessage;
      } catch {
        return;
      }
      this.handle(msg);
    });
    const down = (why: string) => {
      this.ws?.removeAllListeners();
      this.ws = undefined;
      this.store.setUpstream(undefined);
      if (this.stopped) return;
      this.log.warn({ why, retryInMs: this.backoff }, 'upstream disconnected; serving local data');
      this.timer = setTimeout(() => this.connect(), this.backoff);
      this.timer.unref?.();
      this.backoff = Math.min(this.backoff * 2, 60_000);
    };
    this.ws.on('close', (code) => down(`close ${code}`));
    this.ws.on('error', (e) => down(`error ${e.message}`));
  }

  /** Exposed for tests. */
  handle(msg: WsMessage): void {
    this.lastMsgAt = Date.now();
    if (msg.type === 'auth' && !msg.ok) {
      this.log.warn({}, 'upstream rejected the display key');
      return;
    }
    if (msg.type === 'state') {
      this.store.setUpstream(msg.state);
    } else if (msg.type === 'search') {
      this.lastSearch = msg.search;
      this.hub.send(msg);
    } else if (msg.type === 'pos') {
      this.hub.send(msg);
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.watchdog) clearInterval(this.watchdog);
    this.ws?.close();
  }
}

export function isUpstreamState(s: DashboardState | undefined): s is DashboardState {
  return Boolean(s && s.generatedAt);
}
