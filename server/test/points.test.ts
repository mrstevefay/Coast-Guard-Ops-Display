import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Db } from '../src/db/index.js';
import { MIGRATIONS } from '../src/db/migrations.js';
import { testApp } from './helpers/app.js';

const HOWTH_PIER = { lat: 53.3905, lon: -6.068 };
const BAILY = { lat: 53.3617, lon: -6.0526 };

describe('migration 6: the single IPP becomes an LKP point', () => {
  it('copies incidents.ipp_* into planning_points', () => {
    const db = new Db(':memory:');
    for (let i = 0; i < 5; i++) db.raw.exec(MIGRATIONS[i]);
    db.raw.exec('PRAGMA user_version = 5');
    db.run("INSERT INTO incidents (id, kind, text, received_at, started_at, ipp_lat, ipp_lon, ipp_label, ipp_set_at) VALUES ('old', 'tasking', 'x', '2026-01-01T10:00:00Z', '2026-01-01T10:00:00Z', 53.39, -6.07, 'Pier', '2026-01-01T10:05:00Z')");
    db.run("INSERT INTO incidents (id, kind, text, received_at, started_at) VALUES ('none', 'tasking', 'y', '2026-01-02T10:00:00Z', '2026-01-02T10:00:00Z')");
    expect(db.migrate()).toBe(MIGRATIONS.length - 5);
    const rows = db.all<{ incident_id: string; kind: string; label: string; lat: number; set_at: string }>('SELECT incident_id, kind, label, lat, set_at FROM planning_points');
    expect(rows).toEqual([{ incident_id: 'old', kind: 'lkp', label: 'Pier', lat: 53.39, set_at: '2026-01-01T10:05:00Z' }]);
    db.close();
  });
});

describe('typed planning points over the API', () => {
  let t: Awaited<ReturnType<typeof testApp>>;
  let manager: string, member: string;
  let id: string;
  const json = (r: { body: string }) => JSON.parse(r.body);
  beforeAll(async () => {
    t = await testApp();
    manager = await t.login('manager');
    member = await t.login('member');
    id = json(await t.app.inject({ method: 'POST', url: '/api/incidents', headers: { cookie: manager }, payload: { text: 'points test' } })).incident.id;
  });
  afterAll(async () => t.close());
  const add = (payload: Record<string, unknown>, cookie = manager) => t.app.inject({ method: 'POST', url: `/api/incidents/${id}/points`, headers: { cookie }, payload });
  const snap = (headers: Record<string, string>) => t.app.inject({ method: 'GET', url: '/api/search', headers }).then(json);

  it('LKP drives the incident planning point; a second LKP moves the first', async () => {
    const r = await add({ kind: 'lkp', label: 'Pier car park', ...HOWTH_PIER });
    expect(r.statusCode).toBe(200);
    const s = await snap({ cookie: member });
    expect(s.incident.ipp).toMatchObject({ lat: HOWTH_PIER.lat, label: 'Pier car park' });
    expect(s.incident.points).toHaveLength(1);
    await add({ kind: 'lkp', ...BAILY });
    const s2 = await snap({ cookie: member });
    expect(s2.incident.points.filter((p: { kind: string }) => p.kind === 'lkp')).toHaveLength(1);
    expect(s2.incident.ipp).toMatchObject({ lat: BAILY.lat, label: 'Pier car park' }); // label kept when not sent
  });

  it('the legacy PATCH ipp still sets and clears the LKP', async () => {
    await t.app.inject({ method: 'PATCH', url: `/api/incidents/${id}`, headers: { cookie: manager }, payload: { ipp: { ...HOWTH_PIER, label: 'Pier' } } });
    expect((await snap({ cookie: member })).incident.ipp).toMatchObject({ lat: HOWTH_PIER.lat, label: 'Pier' });
    await t.app.inject({ method: 'PATCH', url: `/api/incidents/${id}`, headers: { cookie: manager }, payload: { ipp: null } });
    expect((await snap({ cookie: member })).incident.ipp).toBeUndefined();
  });

  it('PLS stands in for the planning point when there is no LKP', async () => {
    await add({ kind: 'pls', label: 'Seen by dog walker', ...BAILY });
    expect((await snap({ cookie: member })).incident.ipp).toMatchObject({ lat: BAILY.lat, label: 'Seen by dog walker' });
    await add({ kind: 'lkp', ...HOWTH_PIER });
    expect((await snap({ cookie: member })).incident.ipp).toMatchObject({ lat: HOWTH_PIER.lat });
  });

  it('validates kind, position and role; patch and delete', async () => {
    expect((await add({ kind: 'moon', ...HOWTH_PIER })).statusCode).toBe(400);
    expect((await add({ kind: 'home', lat: -6.07, lon: 53.39 })).statusCode).toBe(400); // swapped lat/lon
    expect((await add({ kind: 'home', ...HOWTH_PIER }, member)).statusCode).toBe(403);
    const home = json(await add({ kind: 'home', label: 'Home, Sutton', lat: 53.385, lon: -6.11, note: 'Lives alone' })).point;
    expect(home).toMatchObject({ kind: 'home', label: 'Home, Sutton', note: 'Lives alone' });
    const moved = await t.app.inject({ method: 'PATCH', url: `/api/points/${home.id}`, headers: { cookie: manager }, payload: { lat: 53.386 } });
    expect(json(moved).point).toMatchObject({ lat: 53.386, lon: -6.11, label: 'Home, Sutton' });
    // cannot turn a second point into another LKP
    expect((await t.app.inject({ method: 'PATCH', url: `/api/points/${home.id}`, headers: { cookie: manager }, payload: { kind: 'lkp' } })).statusCode).toBe(400);
    const list = json(await t.app.inject({ method: 'GET', url: `/api/incidents/${id}/points`, headers: { cookie: member } })).points;
    expect(list.map((p: { kind: string }) => p.kind).sort()).toEqual(['home', 'lkp', 'pls']);
    expect((await t.app.inject({ method: 'DELETE', url: `/api/points/${home.id}`, headers: { cookie: manager } })).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'DELETE', url: `/api/points/${home.id}`, headers: { cookie: manager } })).statusCode).toBe(404);
  });

  it('display keys never receive home or significant places', async () => {
    await add({ kind: 'significant', label: 'Bench where his wife used to sit', lat: 53.3725, lon: -6.0505 });
    await add({ kind: 'home', label: 'Home, 12 Main St', lat: 53.385, lon: -6.11 });
    await add({ kind: 'vehicle', label: 'Silver Golf', lat: 53.3611, lon: -6.0532 });
    const full = await snap({ cookie: member });
    expect(full.incident.points.map((p: { kind: string }) => p.kind).sort()).toEqual(['home', 'lkp', 'pls', 'significant', 'vehicle']);
    const key = t.sessions.createDisplayKey('tv').key;
    const res = await t.app.inject({ method: 'GET', url: '/api/search', headers: { 'x-display-key': key } });
    const tv = json(res);
    expect(tv.incident.points.map((p: { kind: string }) => p.kind).sort()).toEqual(['lkp', 'pls', 'vehicle']);
    expect(res.body).not.toContain('Main St');
    expect(res.body).not.toContain('wife');
    expect((await t.app.inject({ method: 'GET', url: `/api/incidents/${id}/points`, headers: { 'x-display-key': key } })).statusCode).toBe(403);
  });

  it('points appear in the replay, the report and the history timeline', async () => {
    const html = (await t.app.inject({ method: 'GET', url: `/api/incidents/${id}/report.html`, headers: { cookie: manager } })).body;
    expect(html).toContain('Planning points:');
    expect(html).toContain('Significant place "Bench where his wife used to sit"');
    const replay = json(await t.app.inject({ method: 'GET', url: `/api/incidents/${id}/replay`, headers: { cookie: manager } }));
    expect(replay.incident.points.length).toBeGreaterThanOrEqual(5);
    expect(replay.events.some((e: { text: string }) => /set a SIGNIFICANT point/.test(e.text))).toBe(true);
  });
});
