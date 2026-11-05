import type { ProviderHealth } from '../../shared/types.js';
import type { Provider, ProviderContext } from './providers/types.js';
import type { StateStore } from './state.js';

const MAX_BACKOFF_MS = 30 * 60 * 1000;
/** Until a provider has succeeded once (e.g. booted before the network was up) retry quickly. */
const NEVER_SUCCEEDED_RETRY_MS = 60 * 1000;

interface Runner {
  provider: Provider;
  health: ProviderHealth;
  timer?: NodeJS.Timeout;
  inFlight: boolean;
  /** Set when the runner was replaced; a fetch still in flight must not report. */
  dead?: boolean;
}

/**
 * One independent poll loop per provider. A failure only affects that
 * provider: its slice is left as-is (last-good), health goes to 'error'
 * (or 'stale' once the data is older than staleAfterMs), and the next poll
 * backs off exponentially up to 30 min.
 */
export class Scheduler {
  private runners: Runner[] = [];
  private staleTimer?: NodeJS.Timeout;
  private stopped = false;

  constructor(private readonly store: StateStore, private readonly ctx: ProviderContext) {}

  add(p: Provider): void {
    const r = this.runner(p);
    this.runners.push(r);
    this.store.setHealth(r.health);
  }

  private runner(p: Provider): Runner {
    const health: ProviderHealth = {
      name: p.name,
      status: !p.enabled ? 'disabled' : p.kind === 'stub' ? 'stub' : 'starting',
      consecutiveFailures: 0,
      pollIntervalMs: p.pollIntervalMs,
      note: p.note,
    };
    return { provider: p, health, inFlight: false };
  }

  /**
   * Swap a provider for a freshly built one (settings changed at runtime): stop the
   * old loop, start the new one and poll it straight away. Health resets to 'starting'.
   */
  async replace(p: Provider): Promise<void> {
    const i = this.runners.findIndex((r) => r.provider.name === p.name);
    if (i < 0) return this.add(p);
    const old = this.runners[i];
    old.dead = true;
    if (old.timer) clearTimeout(old.timer);
    try {
      await old.provider.stop?.();
    } catch (e) {
      this.ctx.log.warn({ provider: p.name, err: String(e) }, 'provider stop failed');
    }
    const r = this.runner(p);
    this.runners[i] = r;
    this.store.setHealth({ ...r.health });
    if (this.stopped || !p.enabled) return;
    if (p.start) {
      try {
        await p.start(this.ctx);
      } catch (e) {
        this.ctx.log.error({ provider: p.name, err: String(e) }, 'provider start failed');
      }
    }
    await this.run(r);
  }

  async start(): Promise<void> {
    this.stopped = false;
    for (const r of this.runners) {
      if (!r.provider.enabled) continue;
      if (r.provider.start) {
        try {
          await r.provider.start(this.ctx);
        } catch (e) {
          this.ctx.log.error({ provider: r.provider.name, err: String(e) }, 'provider start failed');
        }
      }
      void this.run(r);
    }
    this.staleTimer = setInterval(() => this.checkStale(), 30_000);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.staleTimer) clearInterval(this.staleTimer);
    for (const r of this.runners) {
      if (r.timer) clearTimeout(r.timer);
      await r.provider.stop?.();
    }
  }

  /** Force an immediate poll (used by tests and /api/refresh). */
  async pollNow(name?: string): Promise<void> {
    await Promise.all(this.runners.filter((r) => r.provider.enabled && (!name || r.provider.name === name)).map((r) => this.run(r, true)));
  }

  private async run(r: Runner, oneShot = false): Promise<void> {
    if (this.stopped || r.inFlight) return;
    if (r.timer) clearTimeout(r.timer);
    r.inFlight = true;
    const p = r.provider;
    r.health.lastAttempt = new Date().toISOString();
    let delay = p.pollIntervalMs;
    try {
      const slice = await p.fetch(this.ctx);
      this.store.merge(slice);
      r.health.lastSuccess = new Date().toISOString();
      r.health.consecutiveFailures = 0;
      r.health.lastError = undefined;
      r.health.status = p.kind === 'stub' ? 'stub' : 'ok';
    } catch (e) {
      r.health.consecutiveFailures += 1;
      r.health.lastError = (e instanceof Error ? e.message : String(e)).slice(0, 300);
      r.health.status = r.health.lastSuccess && !this.isStale(r) ? 'ok' : r.health.lastSuccess ? 'stale' : 'error';
      // Even with last-good data we surface the error text; the status only
      // flips to 'error'/'stale' once the data is actually old.
      delay = r.health.lastSuccess
        ? Math.min(p.pollIntervalMs * 2 ** Math.min(r.health.consecutiveFailures, 6), MAX_BACKOFF_MS)
        : Math.min(NEVER_SUCCEEDED_RETRY_MS, p.pollIntervalMs);
      this.ctx.log.warn({ provider: p.name, failures: r.health.consecutiveFailures, nextInMs: delay, err: r.health.lastError }, 'provider fetch failed');
    } finally {
      r.inFlight = false;
    }
    if (r.dead) return;
    Object.assign(r.health, p.health?.() ?? {});
    if (!oneShot && !this.stopped) {
      r.health.nextPollAt = new Date(Date.now() + delay).toISOString();
      r.timer = setTimeout(() => void this.run(r), delay);
      r.timer.unref?.();
    }
    this.store.setHealth({ ...r.health });
  }

  private isStale(r: Runner): boolean {
    if (!r.health.lastSuccess) return false;
    const staleAfter = r.provider.staleAfterMs ?? r.provider.pollIntervalMs * 2.5;
    return Date.now() - Date.parse(r.health.lastSuccess) > staleAfter;
  }

  private checkStale(): void {
    for (const r of this.runners) {
      if (!r.provider.enabled || r.provider.kind === 'stub') continue;
      if (r.health.status === 'ok' && this.isStale(r)) {
        r.health.status = 'stale';
        this.store.setHealth({ ...r.health });
      }
    }
  }
}
