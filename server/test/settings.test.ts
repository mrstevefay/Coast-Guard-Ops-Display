import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db/index.js';
import { buildProviders } from '../src/providers/index.js';
import { Scheduler } from '../src/scheduler.js';
import { Settings, mask } from '../src/settings.js';
import { StateStore } from '../src/state.js';
import { testApp } from './helpers/app.js';

const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

describe('runtime settings', () => {
  it('layers UI values over config, clears back to the base, masks secrets', () => {
    const cfg = loadConfig(path.resolve(__dirname, '../../config.yaml'));
    cfg.providers.ais.apiKey = '';
    cfg.providers.webcam.imageUrl = 'https://config.example/cam.jpg';
    const db = openDb(':memory:');
    const s = new Settings(db, cfg);
    expect(s.list().find((x) => x.key === 'providers.ais.apiKey')).toMatchObject({ source: 'none', isSet: false, value: '' });
    expect(s.list().find((x) => x.key === 'providers.webcam.imageUrl')).toMatchObject({ source: 'config', value: 'https://config.example/cam.jpg' });

    expect(s.set('providers.ais.apiKey', 'abcdef123456')).toBe('ais');
    expect(cfg.providers.ais.apiKey).toBe('abcdef123456');
    expect(s.list().find((x) => x.key === 'providers.ais.apiKey')).toMatchObject({ source: 'ui', isSet: true, value: '••••3456' });

    s.set('providers.webcam.imageUrl', 'https://ui.example/still.png');
    expect(cfg.providers.webcam.imageUrl).toBe('https://ui.example/still.png');
    s.set('providers.webcam.imageUrl', '');
    expect(cfg.providers.webcam.imageUrl).toBe('https://config.example/cam.jpg'); // back to config
    expect(() => s.set('providers.webcam.imageUrl', 'ftp://nope')).toThrow(/http/);
    expect(() => s.set('providers.nope', 'x')).toThrow(/unknown/);
    expect(mask('ab')).toBe('••••');

    // a fresh Settings on the same DB re-applies stored values at startup
    const cfg2 = loadConfig(path.resolve(__dirname, '../../config.yaml'));
    cfg2.providers.ais.apiKey = '';
    new Settings(db, cfg2);
    expect(cfg2.providers.ais.apiKey).toBe('abcdef123456');
    db.close();
  });

  it('scheduler.replace swaps a provider and its health in place', async () => {
    const cfg = loadConfig(path.resolve(__dirname, '../../config.yaml'));
    cfg.providers.webcam.imageUrl = '';
    const store = new StateStore(cfg);
    const sched = new Scheduler(store, { config: cfg, log: quiet, current: () => store.getData() });
    const webcam = buildProviders(cfg).find((p) => p.name === 'webcam')!;
    sched.add(webcam);
    expect(store.getHealth().webcam.status).toBe('stub');
    cfg.providers.webcam.imageUrl = 'https://127.0.0.1:1/unreachable.jpg';
    await sched.replace(buildProviders(cfg).find((p) => p.name === 'webcam')!);
    const h = store.getHealth().webcam;
    expect(h.note).toBeUndefined();
    expect(['error', 'starting']).toContain(h.status); // HEAD to an unreachable URL fails but the provider is live
    await sched.stop();
  });

  it('admin can read and update settings over the API; secrets never reach the audit log', async () => {
    const t = await testApp((c) => {
      c.providers.ais.apiKey = '';
    });
    const { Settings: S } = await import('../src/settings.js');
    const settings = new S(t.db, t.cfg);
    // The test app was built without settings deps; mount the routes the same way index.ts does.
    const rebuilt: string[] = [];
    const { buildServer } = await import('../src/http.js');
    const { CalloutManager } = await import('../src/callout.js');
    const { Scheduler: Sch } = await import('../src/scheduler.js');
    const store = new StateStore(t.cfg);
    const sched = new Sch(store, { config: t.cfg, log: quiet, current: () => store.getData() });
    const { app } = await buildServer(t.cfg, store, new CalloutManager(t.cfg, store, quiet), sched, { db: t.db, users: t.users, sessions: t.sessions, audit: t.audit, devices: t.devices, tracking: t.tracking, settings, rebuildProvider: async (n) => void rebuilt.push(n) });
    await app.ready();
    const cookie = await t.login('admin');
    const member = await t.login('member');

    expect((await app.inject({ method: 'GET', url: '/api/admin/settings', headers: { cookie: member } })).statusCode).toBe(403);
    const before = (await app.inject({ method: 'GET', url: '/api/admin/settings', headers: { cookie } })).json();
    expect(before.settings.find((s: any) => s.key === 'providers.ais.apiKey').isSet).toBe(false);

    const bad = await app.inject({ method: 'PUT', url: '/api/admin/settings', headers: { cookie }, payload: { 'providers.webcam.imageUrl': 'not a url' } });
    expect(bad.statusCode).toBe(400);

    const ok = await app.inject({ method: 'PUT', url: '/api/admin/settings', headers: { cookie }, payload: { 'providers.ais.apiKey': 'secret-key-9999', 'providers.webcam.imageUrl': 'https://cam.example/x.jpg' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().rebuilt.sort()).toEqual(['ais', 'webcam']);
    expect(rebuilt.sort()).toEqual(['ais', 'webcam']);
    expect(t.cfg.providers.ais.apiKey).toBe('secret-key-9999');
    const after = ok.json().settings;
    expect(after.find((s: any) => s.key === 'providers.ais.apiKey')).toMatchObject({ source: 'ui', value: '••••9999' });
    expect(after.find((s: any) => s.key === 'providers.webcam.imageUrl')).toMatchObject({ source: 'ui', value: 'https://cam.example/x.jpg' });

    const audit = JSON.stringify(t.audit.list({ limit: 50 }));
    expect(audit).toContain('settings.updated');
    expect(audit).not.toContain('secret-key-9999');
    expect(audit).toContain('https://cam.example/x.jpg');

    const cleared = await app.inject({ method: 'PUT', url: '/api/admin/settings', headers: { cookie }, payload: { 'providers.ais.apiKey': null } });
    expect(cleared.json().settings.find((s: any) => s.key === 'providers.ais.apiKey').isSet).toBe(false);
    await app.close();
    await t.close();
  });
});
