import type { DashboardData, ProviderHealth } from '../../../shared/types.js';
import type { AppConfig } from '../config.js';

export interface ProviderContext {
  config: AppConfig;
  log: { info: (o: unknown, msg?: string) => void; warn: (o: unknown, msg?: string) => void; error: (o: unknown, msg?: string) => void; debug: (o: unknown, msg?: string) => void };
  /** Read-only view of the current merged data, for providers that need another's output. */
  current: () => Readonly<DashboardData>;
}

/**
 * A data source. The scheduler calls `fetch()` every `pollIntervalMs`, merges
 * the returned slice into DashboardState, and tracks health. Throwing from
 * fetch() marks the provider errored and backs off; the last good slice stays
 * on screen with a "stale since" badge.
 *
 * Streaming sources (AIS) implement start/stop and return a snapshot in fetch().
 */
export interface Provider {
  readonly name: string;
  readonly pollIntervalMs: number;
  readonly enabled: boolean;
  /** 'stub' providers are rendered as placeholders and never count as failures. */
  readonly kind?: 'poll' | 'stream' | 'stub';
  /** Static note shown in health, e.g. "no API key configured". */
  readonly note?: string;
  /** After this many ms without success the slice is flagged stale. Default 2.5× poll. */
  readonly staleAfterMs?: number;
  fetch(ctx: ProviderContext): Promise<Partial<DashboardData>>;
  start?(ctx: ProviderContext): Promise<void> | void;
  stop?(): Promise<void> | void;
  /** Optional provider-specific health adjustments (e.g. stream connected?). */
  health?(): Partial<ProviderHealth>;
}
