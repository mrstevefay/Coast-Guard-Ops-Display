import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import type { Provider } from '../src/providers/types.js';
import { Scheduler } from '../src/scheduler.js';
import { StateStore } from '../src/state.js';

const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

describe('scheduler isolation and back-off', () => {
  it('keeps last-good data and isolates a failing provider', async () => {
    vi.useFakeTimers();
    const cfg = loadConfig(path.resolve(__dirname, '../../config.yaml'));
    const store = new StateStore(cfg);
    const sched = new Scheduler(store, { config: cfg, log, current: () => store.getData() });
    let calls = 0;
    const flaky: Provider = {
      name: 'flaky',
      pollIntervalMs: 1000,
      enabled: true,
      async fetch() {
        calls++;
        if (calls === 1) return { webcam: { configured: false, refreshSec: 1 } };
        throw new Error('boom');
      },
    };
    const steady: Provider = { name: 'steady', pollIntervalMs: 1000, enabled: true, async fetch() { return { muster: { responders: [], roles: {}, minimumCrew: 1, requiredRoles: [], source: 'stub' } }; } };
    sched.add(flaky);
    sched.add(steady);
    await sched.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(store.getHealth().flaky.status).toBe('ok');
    expect(store.get().webcam?.configured).toBe(false);

    await vi.advanceTimersByTimeAsync(1100); // second poll fails
    expect(store.getHealth().flaky.consecutiveFailures).toBe(1);
    expect(store.getHealth().flaky.lastError).toBe('boom');
    expect(store.get().webcam?.configured).toBe(false); // last-good retained
    expect(store.getHealth().steady.status).toBe('ok');
    const next1 = Date.parse(store.getHealth().flaky.nextPollAt!);

    await vi.advanceTimersByTimeAsync(2100); // backoff 2s -> third poll fails
    expect(store.getHealth().flaky.consecutiveFailures).toBe(2);
    const next2 = Date.parse(store.getHealth().flaky.nextPollAt!);
    expect(next2 - next1).toBeGreaterThanOrEqual(3000); // 4 s back-off after 2 failures

    // after 2.5× poll with no success the slice is stale
    await vi.advanceTimersByTimeAsync(31_000);
    expect(store.getHealth().flaky.status).toBe('stale');
    await sched.stop();
    vi.useRealTimers();
  });
});
