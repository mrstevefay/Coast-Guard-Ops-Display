import type { DashboardState, WsMessage } from '../../shared/types';

export interface WsClientOptions {
  onState: (s: DashboardState) => void;
  onConnection: (connected: boolean) => void;
  /** Every message (search snapshots, position deltas, auth). */
  onMessage?: (m: WsMessage) => void;
  /** Server refused the socket / REST (401): session gone. */
  onAuthFail?: () => void;
  /** Reload the page after this long without a server connection. */
  reloadAfterMs?: number;
  /** Display key for kiosks (appended as ?key=). */
  key?: string;
}

/**
 * Resilient WebSocket client: exponential-backoff reconnect, heartbeat
 * watchdog (server pings every 20 s), hard page reload after a prolonged
 * outage, and a REST fallback fetch so the first paint doesn't wait on WS.
 */
export class WsClient {
  private ws?: WebSocket;
  private backoff = 1000;
  private lastMsgAt = Date.now();
  private disconnectedSince?: number;
  private watchdog?: number;
  private reconnectTimer?: number;
  private stopped = false;

  constructor(private readonly opts: WsClientOptions) {}

  start(): void {
    this.stopped = false;
    void this.fetchOnce();
    this.connect();
    this.watchdog = window.setInterval(() => this.check(), 5000);
  }

  private url(): string {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const key = this.opts.key ? `?key=${encodeURIComponent(this.opts.key)}` : '';
    return `${proto}//${location.host}/api/ws${key}`;
  }

  private async fetchOnce(): Promise<void> {
    try {
      const headers: Record<string, string> = this.opts.key ? { 'x-display-key': this.opts.key } : {};
      const res = await fetch('/api/state', { cache: 'no-store', headers });
      if (res.status === 401) {
        this.opts.onAuthFail?.();
        return;
      }
      if (res.ok) this.opts.onState((await res.json()) as DashboardState);
    } catch {
      /* WS will deliver */
    }
  }

  private connect(): void {
    if (this.stopped) return;
    try {
      this.ws = new WebSocket(this.url());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws.onopen = () => {
      this.backoff = 1000;
      this.lastMsgAt = Date.now();
      this.disconnectedSince = undefined;
      this.opts.onConnection(true);
    };
    this.ws.onmessage = (ev) => {
      this.lastMsgAt = Date.now();
      try {
        const msg = JSON.parse(ev.data as string) as WsMessage;
        if (msg.type === 'state') this.opts.onState(msg.state);
        if (msg.type === 'auth' && !msg.ok) {
          this.stopped = true;
          this.opts.onAuthFail?.();
        }
        this.opts.onMessage?.(msg);
      } catch {
        /* ignore */
      }
    };
    this.ws.onclose = () => this.onDown();
    this.ws.onerror = () => this.ws?.close();
  }

  private onDown(): void {
    this.ws = undefined;
    if (this.stopped) return;
    this.disconnectedSince ??= Date.now();
    this.opts.onConnection(false);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopped) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, this.backoff);
    this.backoff = Math.min(this.backoff * 2, 30_000);
  }

  private check(): void {
    if (this.stopped) return;
    const reloadAfter = this.opts.reloadAfterMs ?? 5 * 60_000;
    if (this.ws && this.ws.readyState === WebSocket.OPEN && Date.now() - this.lastMsgAt > 90_000) {
      // server went quiet: force a reconnect
      this.ws.close();
    }
    if (reloadAfter > 0 && this.disconnectedSince && Date.now() - this.disconnectedSince > reloadAfter) {
      location.reload();
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }
}
