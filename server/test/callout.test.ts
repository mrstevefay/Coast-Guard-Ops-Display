import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CalloutManager } from '../src/callout.js';
import { loadConfig } from '../src/config.js';
import { StateStore } from '../src/state.js';

const quiet = { info: () => {}, warn: () => {} };

describe('callout state machine', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-'));
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const make = (mins = 1) => {
    const cfg = loadConfig(path.resolve(__dirname, '../../config.yaml'));
    cfg.server.dataDir = dir;
    cfg.callout.autoStanddownMinutes = mins;
    const store = new StateStore(cfg);
    return { cfg, store, cm: new CalloutManager(cfg, store, quiet) };
  };

  it('switches to callout, persists, auto stands down', () => {
    const { store, cm } = make(1);
    const m = cm.callout({ text: ' MAYDAY relay — kayaker in difficulty off Ireland\'s Eye ', lat: 53.405, lon: -6.065 });
    expect(m.mode).toBe('callout');
    expect(m.incident?.text).toBe("MAYDAY relay — kayaker in difficulty off Ireland's Eye");
    expect(m.incident?.lat).toBe(53.405);
    expect(m.incident?.autoStanddownAt).toBeDefined();
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'mode.json'), 'utf8')).mode).toBe('callout');
    vi.advanceTimersByTime(61_000);
    expect(store.getMode().mode).toBe('standby');
    expect(store.getMode().lastIncident?.id).toBe(m.incident!.id);
  });

  it('rejects empty text and bad dates', () => {
    const { cm } = make();
    expect(() => cm.callout({ text: '   ' })).toThrow(/text/);
    expect(() => cm.callout({ text: 'x', receivedAt: 'yesterday-ish' })).toThrow(/receivedAt/);
  });

  it('restores an in-progress callout from disk on restart', () => {
    const a = make(60);
    a.cm.callout({ text: 'Pager: vessel aground Howth harbour mouth' });
    const b = make(60);
    expect(b.store.getMode().mode).toBe('callout');
    expect(b.store.getMode().incident?.text).toMatch(/aground/);
  });

  it('does not restore an expired callout', () => {
    const a = make(1);
    a.cm.callout({ text: 'old job', receivedAt: new Date(Date.now() - 3600_000).toISOString() });
    // written as callout with autoStanddownAt in the past
    const b = make(1);
    expect(b.store.getMode().mode).toBe('standby');
  });
});
