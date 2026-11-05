import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Audit } from '../../src/audit.js';
import { Sessions } from '../../src/auth/sessions.js';
import { Users } from '../../src/auth/users.js';
import { CalloutManager } from '../../src/callout.js';
import { loadConfig, type AppConfig } from '../../src/config.js';
import { openDb } from '../../src/db/index.js';
import { buildServer } from '../../src/http.js';
import { Scheduler } from '../../src/scheduler.js';
import { Devices } from '../../src/search/devices.js';
import { Tracking } from '../../src/search/tracking.js';
import { StateStore } from '../../src/state.js';

const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

/**
 * Builds a full server on an in-memory DB with accounts ON, no providers, no
 * web dist. Returns helpers to log in as seeded users.
 */
export async function testApp(overrides: (c: AppConfig) => void = () => {}) {
  const cfg = loadConfig(path.resolve(__dirname, '../../../config.yaml'));
  cfg.server.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-test-'));
  cfg.auth.open = false;
  cfg.auth.publicUrl = 'https://ops.test';
  cfg.callout.token = 'bridge-token';
  overrides(cfg);
  process.env.WEB_DIST = '/nonexistent';
  const db = openDb(':memory:');
  const users = new Users(db);
  const sessions = new Sessions(db, cfg.auth.sessionDays);
  const audit = new Audit(db);
  const store = new StateStore(cfg);
  const callout = new CalloutManager(cfg, store, quiet);
  const scheduler = new Scheduler(store, { config: cfg, log: quiet, current: () => store.getData() });
  const devices = new Devices(db);
  const tracking = new Tracking(db, cfg.search.maxAccuracyM, {
    current: () => {
      const m = store.getMode();
      return m.mode === 'callout' && m.incident ? { incidentId: m.incident.id } : undefined;
    },
  });
  const { app, hub } = await buildServer(cfg, store, callout, scheduler, { db, users, sessions, audit, devices, tracking });
  await app.ready();

  const seed = {
    admin: users.create({ email: 'admin@ops.test', name: 'Ada Admin', role: 'admin', password: 'admin-pass-123', mustChange: false }).user,
    manager: users.create({ email: 'sm@ops.test', name: 'Sam Manager', callsign: 'SM', role: 'manager', password: 'manager-pass-1', mustChange: false }).user,
    member: users.create({ email: 'joe@ops.test', name: 'Joe Crew', callsign: 'JC', role: 'member', password: 'member-pass-12', mustChange: false }).user,
  };
  const passwords: Record<string, string> = { admin: 'admin-pass-123', manager: 'manager-pass-1', member: 'member-pass-12' };

  async function login(who: keyof typeof seed): Promise<string> {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: seed[who].email, password: passwords[who] } });
    if (res.statusCode !== 200) throw new Error(`login ${who} failed: ${res.statusCode} ${res.body}`);
    const c = res.cookies.find((x) => x.name === 'cg_s');
    return `cg_s=${c!.value}`;
  }

  const close = async () => {
    await app.close();
    db.close();
    fs.rmSync(cfg.server.dataDir, { recursive: true, force: true });
  };

  return { app, hub, cfg, db, users, sessions, audit, store, callout, devices, tracking, seed, login, close };
}
