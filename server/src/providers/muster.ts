import type { DashboardData, MusterState } from '../../../shared/types.js';
import type { AppConfig } from '../config.js';
import type { Provider } from './types.js';

/**
 * Phase 1 stub. Phase 2 (WhatsApp replies) and Phase 3 (D4H availability)
 * replace `fetch()` — or, better, add their own providers that write the same
 * `muster` slice — keeping this shape:
 *   { responders: Responder[], roles: Record<role, responderId[]>, minimumCrew }
 * The frontend already renders responders, role coverage and the minimum-crew
 * threshold, so Phase 2/3 need no UI changes to light the panel up.
 */
export function musterProvider(cfg: AppConfig): Provider {
  const c = cfg.providers.muster;
  return {
    name: 'muster',
    pollIntervalMs: c.pollIntervalMs,
    enabled: c.enabled,
    kind: 'stub',
    note: 'Phase 2/3 — crew muster not wired yet',
    async fetch(): Promise<Partial<DashboardData>> {
      const muster: MusterState = {
        responders: [],
        roles: Object.fromEntries(c.requiredRoles.map((r) => [r, []])),
        minimumCrew: c.minimumCrew,
        requiredRoles: c.requiredRoles,
        source: 'stub',
        updatedAt: new Date().toISOString(),
      };
      return { muster };
    },
  };
}
