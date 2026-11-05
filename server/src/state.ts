import { EventEmitter } from 'node:events';
import type { DashboardData, DashboardState, ModeState, ProviderHealth } from '../../shared/types.js';
import type { AppConfig } from './config.js';
import { derive } from './derive.js';

export const VERSION = process.env.APP_VERSION ?? '2.0.0';

/**
 * Owns the DashboardState. Providers write slices via `merge`; the HTTP layer
 * reads via `get`. Emits 'change' (throttled by the WS layer) on every update.
 */
export class StateStore extends EventEmitter {
  private data: DashboardData = {};
  private health: Record<string, ProviderHealth> = {};
  private mode: ModeState = { mode: 'standby', changedAt: new Date().toISOString() };
  /** Latest state received from the hosted server (Pi mirror); undefined = serve local. */
  private upstream?: DashboardState;
  private upstreamAt = 0;

  constructor(private readonly config: AppConfig) {
    super();
  }

  merge(slice: Partial<DashboardData>): void {
    let changed = false;
    for (const [k, v] of Object.entries(slice)) {
      if (v === undefined) continue;
      (this.data as any)[k] = v;
      changed = true;
    }
    if (changed) this.emit('change');
  }

  setHealth(h: ProviderHealth): void {
    const prev = this.health[h.name];
    this.health[h.name] = h;
    if (!prev || prev.status !== h.status || prev.lastSuccess !== h.lastSuccess || prev.lastError !== h.lastError) {
      this.emit('change');
    }
  }

  getHealth(): Record<string, ProviderHealth> {
    return this.health;
  }

  setMode(m: ModeState): void {
    const prev = this.mode;
    this.mode = m;
    this.emit('change');
    /** 'mode' fires with (next, prev) so the search service can open/close incidents. */
    this.emit('mode', m, prev);
  }

  getMode(): ModeState {
    return this.mode;
  }

  getData(): Readonly<DashboardData> {
    return this.data;
  }

  /** Pi mirror: adopt the hosted server's state while it is fresh. */
  setUpstream(state: DashboardState | undefined): void {
    const had = Boolean(this.upstream);
    this.upstream = state;
    this.upstreamAt = state ? Date.now() : 0;
    if (state || had) this.emit('change');
  }

  get upstreamFresh(): boolean {
    return Boolean(this.upstream) && Date.now() - this.upstreamAt < this.config.upstream.staleAfterSec * 1000;
  }

  get(): DashboardState {
    if (this.upstreamFresh) return { ...this.upstream!, upstream: 'live' };
    const c = this.config;
    const data = derive(this.data);
    return {
      ...(c.upstream.url ? { upstream: 'fallback' as const } : {}),
      ...data,
      generatedAt: new Date().toISOString(),
      station: { name: c.station.name, shortName: c.station.shortName, lat: c.station.lat, lon: c.station.lon },
      mode: this.mode,
      providers: this.health,
      panels: c.panels,
      map: c.map,
      version: VERSION,
    };
  }
}
