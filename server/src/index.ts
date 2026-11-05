import path from 'node:path';
import { Audit } from './audit.js';
import { backupDb } from './backup.js';
import { runRetention, scheduleDaily } from './search/retention.js';
import { Sessions } from './auth/sessions.js';
import { Users } from './auth/users.js';
import { CalloutManager } from './callout.js';
import { loadConfig } from './config.js';
import { openDb } from './db/index.js';
import { buildServer } from './http.js';
import { buildProviders } from './providers/index.js';
import type { ProviderContext } from './providers/types.js';
import { Scheduler } from './scheduler.js';
import { Devices } from './search/devices.js';
import { SearchService } from './search/service.js';
import { Tracking } from './search/tracking.js';
import { StateStore } from './state.js';
import { UpstreamMirror } from './upstream.js';

async function main() {
  const cfg = loadConfig();
  const store = new StateStore(cfg);
  const logStub = { info: console.log, warn: console.warn, error: console.error, debug: () => {} };
  const callout = new CalloutManager(cfg, store, logStub);

  // Phase 2: SQLite (accounts, devices, search). Always opened; routes only mount when auth is on.
  const db = openDb(process.env.DB_FILE ?? path.join(cfg.server.dataDir, 'ops.db'));
  const users = new Users(db);
  const sessions = new Sessions(db, cfg.auth.sessionDays);
  const audit = new Audit(db);
  if (users.bootstrapAdmin(cfg.auth.adminEmail, cfg.auth.adminPassword, cfg.auth.adminName)) {
    console.log(`bootstrap: created admin ${cfg.auth.adminEmail} (must change password on first login)`);
  }
  if (!cfg.auth.open && users.count() === 0) {
    console.warn('auth is on but there are no users: set ADMIN_EMAIL and ADMIN_PASSWORD for the first start');
  }

  const ctx: ProviderContext = { config: cfg, log: logStub, current: () => store.getData() };
  const scheduler = new Scheduler(store, ctx);
  for (const p of buildProviders(cfg)) scheduler.add(p);

  // Tracking: until the search service (M3) takes over, fixes are kept as track
  // points whenever the display is in callout mode.
  const devices = new Devices(db);
  const tracking = new Tracking(db, cfg.search.maxAccuracyM, {
    current: () => {
      const m = store.getMode();
      return m.mode === 'callout' && m.incident ? { incidentId: m.incident.id } : undefined;
    },
  });
  tracking.warm(devices.listAll().filter((d) => !d.revoked_at).map((d) => ({ device: d, user: users.byId(d.user_id)! })).filter((x) => x.user));
  let search: SearchService | undefined;
  if (!cfg.auth.open && cfg.search.enabled) {
    search = new SearchService(db, cfg, store, users, tracking);
    tracking.context = search; // responders / team members are tracked, not just "callout mode"
  }

  const backupDir = path.join(cfg.server.dataDir, 'backups');
  const { app, hub } = await buildServer(cfg, store, callout, scheduler, { db, users, sessions, audit, devices, tracking, search, backupDir });
  // Nightly housekeeping at 03:30 Europe/Dublin: backup first, then retention.
  const stopNightly = scheduleDaily(3, 30, () => {
    backupDb(db, backupDir, cfg.retention.backupKeep)
      .then((b) => app.log.info(b, 'nightly backup'))
      .catch((e) => app.log.error({ err: String(e) }, 'backup failed'))
      .finally(() => {
        try {
          app.log.info(runRetention(db, cfg, { devices, sessions, audit }), 'retention');
        } catch (e) {
          app.log.error({ err: String(e) }, 'retention failed');
        }
      });
  });
  // Pi: mirror the hosted server for the kiosk, fall back to local data when it is unreachable.
  const mirror = new UpstreamMirror(cfg, store, hub, { info: (o, m) => app.log.info(o as object, m), warn: (o, m) => app.log.warn(o as object, m) });
  mirror.start();
  const purge = setInterval(() => sessions.purgeExpired(), 3600_000);
  purge.unref?.();
  // Route provider logs through fastify's pino logger now that it exists.
  ctx.log = {
    info: (o, m) => app.log.info(o as object, m),
    warn: (o, m) => app.log.warn(o as object, m),
    error: (o, m) => app.log.error(o as object, m),
    debug: (o, m) => app.log.debug(o as object, m),
  };
  (callout as any).log = ctx.log;

  await app.listen({ port: cfg.server.port, host: cfg.server.host });
  await scheduler.start();

  const shutdown = async (sig: string) => {
    app.log.info({ sig }, 'shutting down');
    mirror.stop();
    stopNightly();
    await scheduler.stop();
    await app.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
