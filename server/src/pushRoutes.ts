import type { FastifyInstance } from 'fastify';
import type { ModeState } from '../../shared/types.js';
import type { Audit } from './audit.js';
import { requireAuth, type AuthCtx } from './auth/middleware.js';
import type { Push, PushSubscriptionInput } from './push.js';
import type { SearchService } from './search/service.js';
import type { StateStore } from './state.js';

/** Turning alerts on and off for the phone in hand, and a test alert. Members only: a display has no phone. */
export async function pushRoutes(app: FastifyInstance, d: AuthCtx & { audit: Audit; push: Push }): Promise<void> {
  const { push, audit } = d;
  const member = requireAuth(d, 'member');
  const bad = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }, e: unknown, code = 400) => reply.code(code).send({ error: e instanceof Error ? e.message : String(e) });

  app.get('/api/push/key', { preHandler: member }, async () => ({ key: push.publicKey() }));

  app.post<{ Body: { subscription?: PushSubscriptionInput } }>('/api/push/subscriptions', { preHandler: member }, async (req, reply) => {
    const p = req.principal!;
    if (p.kind !== 'user') return bad(reply, 'forbidden', 403);
    try {
      const endpoint = String(req.body?.subscription?.endpoint ?? '');
      const fresh = !push.has(p.userId, endpoint);
      push.subscribe(p.userId, req.body?.subscription ?? {}, req.headers['user-agent']);
      if (fresh) audit.log(p, req.ip, 'push.subscribed');
      return { ok: true };
    } catch (e) {
      return bad(reply, e);
    }
  });

  app.post<{ Body: { endpoint?: string } }>('/api/push/unsubscribe', { preHandler: member }, async (req, reply) => {
    const p = req.principal!;
    if (p.kind !== 'user') return bad(reply, 'forbidden', 403);
    if (push.unsubscribe(p.userId, String(req.body?.endpoint ?? ''))) audit.log(p, req.ip, 'push.unsubscribed');
    return { ok: true };
  });

  /** A test alert to the caller's own phones. */
  app.post('/api/push/test', { preHandler: member, config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async (req, reply) => {
    const p = req.principal!;
    if (p.kind !== 'user') return bad(reply, 'forbidden', 403);
    return push.notify([p.userId], { title: `Test alert · ${d.cfg.station.shortName}`, body: 'Alerts are working on this phone.', tag: 'test', url: '/m/#/more' });
  });
}

/**
 * What sends an alert:
 *  - a callout: every active member with alerts on;
 *  - a stand-down by a person (not the display's own timeout): those who responded or are in a team;
 *  - a target given to a team: that team's members.
 */
export function attachPushTriggers(push: Push, store: StateStore, search: SearchService | undefined, station: string): void {
  store.on('mode', (m: ModeState, prev?: ModeState) => {
    if (m.mode === 'callout' && m.incident && prev?.incident?.id !== m.incident.id) {
      void push.notify('all', { title: `CALLOUT · ${station}`, body: m.incident.text, tag: 'callout', url: '/m/#/status', urgent: true });
    } else if (m.mode === 'standby' && prev?.mode === 'callout' && prev.incident && m.standdownReason !== 'auto-timeout' && search) {
      const ids = search.responders(prev.incident.id).filter((r) => r.status === 'responding' || r.status === 'on-scene' || r.teamId).map((r) => r.userId);
      void push.notify(ids, { title: `Stand down · ${station}`, body: 'The callout has been stood down.', tag: 'callout', url: '/m/#/status' });
    }
  });
  search?.on('target-assigned', (e: { targetId: number; targetName: string; teamName: string; userIds: number[] }) => {
    void push.notify(e.userIds, { title: `New target · ${e.teamName}`, body: e.targetName, tag: `target-${e.targetId}`, url: '/m/#/status' });
  });
}
