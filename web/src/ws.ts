import type { DashboardState, WsMessage } from '../../shared/types';

export interface WsClientOptions {
  onState: (s: DashboardState) => void;
  onConnection: (connected: boolean) => void;
  /** Reload the page after this long without a server connection. */
  reloadAfterMs?: number;
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

  constructor(private readonly opts: WsClientOptions) {}

  start(): void {
    void this.fetchOnce();
    this.connect();
    this.watchdog = window.setInterval(() => this.check(), 5000);
  }

  private url(): string {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/api/ws`;
  }

  private async fetchOnce(): Promise<void> {
    try {
      const res = await fetch('/api/state', { cache: 'no-store' });
      if (res.ok) this.opts.onState((await res.json()) as DashboardState);
    } catch {
      /* WS will deliver */
    }
  }

  private connect(): void {
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
      } catch {
        /* ignore */
      }
    };
    this.ws.onclose = () => this.onDown();
    this.ws.onerror = () => this.ws?.close();
  }

  private onDown(): void {
    this.ws = undefined;
    this.disconnectedSince ??= Date.now();
    this.opts.onConnection(false);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, this.backoff);
    this.backoff = Math.min(this.backoff * 2, 30_000);
  }

  private check(): void {
    const reloadAfter = this.opts.reloadAfterMs ?? 5 * 60_000;
    if (this.ws && this.ws.readyState === WebSocket.OPEN && Date.now() - this.lastMsgAt > 90_000) {
      // server went quiet: force a reconnect
      this.ws.close();
    }
    if (this.disconnectedSince && Date.now() - this.disconnectedSince > reloadAfter) {
      location.reload();
    }
  }

  stop(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    this.ws?.close();
  }
}
