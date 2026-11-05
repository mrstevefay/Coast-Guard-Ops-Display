import path from 'node:path';
import { Users } from './auth/users.js';
import { CalloutManager } from './callout.js';
import { loadConfig } from './config.js';
import { openDb } from './db/index.js';
import { buildServer } from './http.js';
import { buildProviders } from './providers/index.js';
import type { ProviderContext } from './providers/types.js';
import { Scheduler } from './scheduler.js';
import { StateStore } from './state.js';

async function main() {
  const cfg = loadConfig();
  const store = new StateStore(cfg);
  const logStub = { info: console.log, warn: console.warn, error: console.error, debug: () => {} };
  const callout = new CalloutManager(cfg, store, logStub);

  // Phase 2: SQLite (accounts, devices, search). Always opened; routes only mount when auth is on.
  const db = openDb(process.env.DB_FILE ?? path.join(cfg.server.dataDir, 'ops.db'));
  const users = new Users(db);
  if (users.bootstrapAdmin(cfg.auth.adminEmail, cfg.auth.adminPassword, cfg.auth.adminName)) {
    console.log(`bootstrap: created admin ${cfg.auth.adminEmail} (must change password on first login)`);
  }

  const ctx: ProviderContext = { config: cfg, log: logStub, current: () => store.getData() };
  const scheduler = new Scheduler(store, ctx);
  for (const p of buildProviders(cfg)) scheduler.add(p);

  const app = await buildServer(cfg, store, callout, scheduler, { db, users });
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
