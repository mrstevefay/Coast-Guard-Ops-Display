import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import type { Principal, WsMessage } from '../../shared/types.js';
import type { AuthCtx } from './auth/middleware.js';
import { resolvePrincipal } from './auth/middleware.js';
import type { StateStore } from './state.js';

interface Client {
  socket: WebSocket;
  principal: Principal;
}

/**
 * One place that owns every WebSocket. Dashboard state goes to everyone that
 * is allowed to see it; search/position messages (Phase 2 M2+) only to
 * authenticated users and displays.
 */
export class Hub {
  private clients = new Set<Client>();
  private statePending?: NodeJS.Timeout;
  private heartbeat?: NodeJS.Timeout;

  constructor(private readonly store: StateStore, private readonly auth: AuthCtx) {}

  register(app: FastifyInstance): void {
    app.get('/api/ws', { websocket: true }, (socket, req) => this.onConnection(socket, req));
    this.store.on('change', this.scheduleState);
    this.heartbeat = setInterval(() => this.send({ type: 'ping', t: Date.now() }), 20_000);
    this.heartbeat.unref?.();
    app.addHook('onClose', async () => this.close());
  }

  private onConnection(socket: WebSocket, req: FastifyRequest): void {
    const principal = resolvePrincipal(this.auth, req);
    if (!principal) {
      socket.send(JSON.stringify({ type: 'auth', ok: false } satisfies WsMessage));
      socket.close(4401, 'unauthorised');
      return;
    }
    const client: Client = { socket, principal };
    this.clients.add(client);
    socket.send(JSON.stringify({ type: 'auth', ok: true, principal } satisfies WsMessage));
    socket.send(JSON.stringify({ type: 'state', state: this.store.get() } satisfies WsMessage));
    this.onJoin?.(client.principal, (m) => this.sendTo(client, m));
    socket.on('close', () => this.clients.delete(client));
    socket.on('error', () => this.clients.delete(client));
  }

  /** Hook for later milestones: send the search snapshot to a newly joined socket. */
  onJoin?: (principal: Principal, send: (m: WsMessage) => void) => void;

  private scheduleState = () => {
    if (this.statePending) return;
    this.statePending = setTimeout(() => {
      this.statePending = undefined;
      this.send({ type: 'state', state: this.store.get() });
    }, 250);
  };

  /** Broadcast to every connected client, optionally filtered by principal. */
  send(msg: WsMessage, filter?: (p: Principal) => boolean): void {
    const payload = JSON.stringify(msg);
    for (const c of this.clients) {
      if (filter && !filter(c.principal)) continue;
      if (c.socket.readyState === c.socket.OPEN) c.socket.send(payload);
    }
  }

  private sendTo(c: Client, msg: WsMessage): void {
    if (c.socket.readyState === c.socket.OPEN) c.socket.send(JSON.stringify(msg));
  }

  /** Only authenticated users/displays (never anonymous in open mode? open mode = everyone). */
  sendAuthenticated(msg: WsMessage): void {
    this.send(msg, (p) => p.kind !== 'open' || this.auth.cfg.auth.open);
  }

  get size(): number {
    return this.clients.size;
  }

  close(): void {
    this.store.off('change', this.scheduleState);
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.statePending) clearTimeout(this.statePending);
    for (const c of this.clients) c.socket.close(1001, 'server closing');
    this.clients.clear();
  }
}
