import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { backupDb, listBackups } from '../src/backup.js';
import { Db } from '../src/db/index.js';
import { msUntilLocal, runRetention } from '../src/search/retention.js';
import { testApp } from './helpers/app.js';

describe('retention', () => {
  let t: Awaited<ReturnType<typeof testApp>>;
  beforeAll(async () => {
    t = await testApp();
  });
  afterAll(async () => t.close());

  function seedPositions() {
    const old = '2020-01-01T00:00:00.000Z';
    t.db.run("INSERT OR IGNORE INTO incidents (id, text, received_at, started_at, ended_at) VALUES ('old', 'old job', ?, ?, ?)", old, old, old);
    t.db.run("INSERT OR IGNORE INTO incidents (id, text, received_at, started_at, ended_at) VALUES ('new', 'recent', ?, ?, ?)", new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
    const dev = t.devices.create(t.seed.member, 'phone').device;
    for (let i = 0; i < 5; i++) t.db.run("INSERT INTO positions (device_id, user_id, incident_id, tst, received_at, lat, lon) VALUES (?, ?, 'old', ?, ?, 53, -6)", dev.id, t.seed.member.id, 1000 + i, old);
    for (let i = 0; i < 3; i++) t.db.run("INSERT INTO positions (device_id, user_id, incident_id, tst, received_at, lat, lon) VALUES (?, ?, 'new', ?, ?, 53, -6)", dev.id, t.seed.member.id, 2000 + i, new Date().toISOString());
    t.db.run('UPDATE devices SET last_lat = 53, last_lon = -6, last_tst = ? WHERE id = ?', Math.floor(Date.now() / 1000) - 48 * 3600, dev.id);
    return dev.id;
  }

  it('keeps everything when trackDays is 0 but still clears stale last fixes', () => {
    const devId = seedPositions();
    t.cfg.retention.trackDays = 0;
    const r = runRetention(t.db, t.cfg, { devices: t.devices, sessions: t.sessions, audit: t.audit });
    expect(r.positionsDeleted).toBe(0);
    expect(r.lastFixesCleared).toBe(1);
    expect(t.db.all('SELECT * FROM positions')).toHaveLength(8);
    expect(t.devices.byId(devId)?.last_lat).toBeNull();
    expect(t.audit.list().some((e) => e.action === 'retention.ran')).toBe(true);
  });

  it('deletes only positions of incidents closed longer ago than trackDays', () => {
    t.cfg.retention.trackDays = 90;
    const r = runRetention(t.db, t.cfg, { devices: t.devices, sessions: t.sessions, audit: t.audit });
    expect(r.positionsDeleted).toBe(5);
    expect(t.db.all("SELECT * FROM positions WHERE incident_id = 'new'")).toHaveLength(3);
  });

  it('computes time until the next 03:30 Europe/Dublin', () => {
    const ms = msUntilLocal(3, 30);
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(86400_000);
  });
});

describe('backup', () => {
  it('writes a consistent copy and prunes old ones', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-bk-'));
    const db = new Db(path.join(dir, 'ops.db'));
    db.migrate();
    db.run("INSERT INTO settings (key, value) VALUES ('a', '1')");
    for (let i = 0; i < 4; i++) {
      await backupDb(db, path.join(dir, 'backups'), 3);
      await new Promise((r) => setTimeout(r, 1100)); // distinct second-resolution names
    }
    const list = listBackups(path.join(dir, 'backups'));
    expect(list).toHaveLength(3);
    const restored = new Db(list[0].file);
    expect(restored.get<{ value: string }>("SELECT value FROM settings WHERE key = 'a'")?.value).toBe('1');
    expect(restored.version).toBe(db.version);
    restored.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }, 15000);
});
