import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DashboardState, WsMessage } from '../../shared/types.js';
import { loadConfig } from '../src/config.js';
import { StateStore } from '../src/state.js';
import { UpstreamMirror } from '../src/upstream.js';

const quiet = { info: () => {}, warn: () => {} };

describe('upstream mirror (Pi)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('serves upstream state while fresh, then falls back to local data', () => {
    const cfg = loadConfig(path.resolve(__dirname, '../../config.yaml'));
    cfg.upstream = { url: 'wss://ops.test', key: 'dk_x', staleAfterSec: 60 };
    const store = new StateStore(cfg);
    store.merge({ webcam: { configured: false, refreshSec: 1 } }); // local data marker
    const sent: WsMessage[] = [];
    const hub = { send: (m: WsMessage) => sent.push(m), onJoin: undefined } as any;
    const mirror = new UpstreamMirror(cfg, store, hub, quiet);

    expect(store.get().upstream).toBe('fallback');
    const remote = { ...store.get(), generatedAt: new Date().toISOString(), version: 'remote', mode: { mode: 'callout', changedAt: 'x' } } as DashboardState;
    mirror.handle({ type: 'state', state: remote });
    expect(store.get().upstream).toBe('live');
    expect(store.get().version).toBe('remote');
    expect(store.get().mode.mode).toBe('callout');

    mirror.handle({ type: 'search', search: { responders: [], teams: [], targets: [], latest: {}, updatedAt: 'x' } });
    mirror.handle({ type: 'pos', fixes: [] });
    expect(sent.map((m) => m.type)).toEqual(['search', 'pos']);
    expect(mirror.lastSearch).toBeDefined();

    vi.advanceTimersByTime(61_000);
    expect(store.get().upstream).toBe('fallback');
    expect(store.get().version).not.toBe('remote');
    expect(store.get().webcam?.configured).toBe(false); // local slice is back
  });

  it('is inert without upstream config', () => {
    const cfg = loadConfig(path.resolve(__dirname, '../../config.yaml'));
    const store = new StateStore(cfg);
    const mirror = new UpstreamMirror(cfg, store, { send: () => {} } as any, quiet);
    mirror.start();
    expect(mirror.connected).toBe(false);
    expect(store.get().upstream).toBeUndefined();
    mirror.stop();
  });
});
