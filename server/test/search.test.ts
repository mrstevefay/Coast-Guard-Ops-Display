import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateGeometry } from '../src/search/geometry.js';
import { tracksFor } from '../src/search/tracks.js';
import { testApp } from './helpers/app.js';

const basic = (u: string, p: string) => `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;
const nowSec = () => Math.floor(Date.now() / 1000);
const sfs = { 'sec-fetch-site': 'same-origin' };

describe('geometry validation', () => {
  it('accepts and normalises valid shapes', () => {
    expect(validateGeometry({ type: 'Point', coordinates: [-6.06, 53.39, 12] }, 'point')).toEqual({ type: 'Point', coordinates: [-6.06, 53.39] });
    const poly = validateGeometry({ type: 'Polygon', coordinates: [[[-6.1, 53.4], [-6.0, 53.4], [-6.0, 53.3], [-6.1, 53.3]]] }, 'area');
    expect(poly.type).toBe('Polygon');
    expect((poly as any).coordinates[0]).toHaveLength(5); // closed
    expect(validateGeometry({ type: 'LineString', coordinates: [[-6.1, 53.4], [-6.0, 53.4]] }, 'line').type).toBe('LineString');
  });
  it('rejects bad input', () => {
    expect(() => validateGeometry({ type: 'Point', coordinates: [200, 0] }, 'point')).toThrow();
    expect(() => validateGeometry({ type: 'Polygon', coordinates: [[[0, 0], [1, 1]]] }, 'area')).toThrow(/4 points/);
    expect(() => validateGeometry({ type: 'Point', coordinates: [0, 0] }, 'area')).toThrow(/Polygon/);
    expect(() => validateGeometry({ type: 'LineString', coordinates: Array.from({ length: 600 }, (_, i) => [i / 100, 0]) }, 'line')).toThrow(/vertices/);
  });
});

describe('search service and routes', () => {
  let t: Awaited<ReturnType<typeof testApp>>;
  let manager: string, member: string, admin: string;
  let incidentId: string;
  beforeAll(async () => {
    t = await testApp();
    manager = await t.login('manager');
    member = await t.login('member');
    admin = await t.login('admin');
  });
  afterAll(async () => t.close());
  const json = (r: { body: string }) => JSON.parse(r.body);

  it('has an empty snapshot before any incident', async () => {
    const s = json(await t.app.inject({ method: 'GET', url: '/api/search', headers: { cookie: member } }));
    expect(s.incident).toBeUndefined();
    expect(s.teams).toEqual([]);
  });

  it('a manager starts an incident from the app; responses are rejected for members until then', async () => {
    const denied = await t.app.inject({ method: 'POST', url: '/api/incidents', headers: { cookie: member, ...sfs }, payload: { text: 'nope' } });
    expect(denied.statusCode).toBe(403);
    const res = await t.app.inject({ method: 'POST', url: '/api/incidents', headers: { cookie: manager, ...sfs }, payload: { text: 'Kayaker in difficulty off Ireland’s Eye', lat: 53.41, lon: -6.06, callout: true } });
    expect(res.statusCode).toBe(200);
    incidentId = json(res).incident.id;
    expect(t.store.getMode().mode).toBe('callout');
    expect(t.search.openIncident()?.id).toBe(incidentId);
    expect(json(res).incident.source).toBe('app');
  });

  it('members respond with ETA and show on the muster bridge', async () => {
    const r = await t.app.inject({ method: 'PUT', url: `/api/incidents/${incidentId}/response`, headers: { cookie: member, ...sfs }, payload: { status: 'responding', etaMin: 10 } });
    expect(r.statusCode).toBe(200);
    expect(json(r).response.teamCallsign).toBeUndefined();
    await t.app.inject({ method: 'PUT', url: `/api/incidents/${incidentId}/response`, headers: { cookie: admin, ...sfs }, payload: { status: 'responding', etaMin: 5 } });
    const badStatus = await t.app.inject({ method: 'PUT', url: `/api/incidents/${incidentId}/response`, headers: { cookie: member, ...sfs }, payload: { status: 'teleporting' } });
    expect(badStatus.statusCode).toBe(400);
    const snap = t.search.snapshot();
    expect(snap.responders.map((x) => x.userId).sort()).toEqual([t.seed.admin.id, t.seed.member.id].sort());
    await new Promise((r) => setTimeout(r, 150)); // muster merge is debounced
    const muster = t.store.get().muster!;
    expect(muster.source).toBe('app');
    expect(muster.responders).toHaveLength(2);
  });

  it('creates teams with default names and colours, assigns members with callsigns and a leader', async () => {
    const a = json(await t.app.inject({ method: 'POST', url: `/api/incidents/${incidentId}/teams`, headers: { cookie: manager, ...sfs }, payload: {} })).team;
    const b = json(await t.app.inject({ method: 'POST', url: `/api/incidents/${incidentId}/teams`, headers: { cookie: manager, ...sfs }, payload: {} })).team;
    expect([a.name, b.name]).toEqual(['Alpha', 'Bravo']);
    expect(a.colour).not.toBe(b.colour);
    expect(a.searchWidthM).toBe(20);
    const dup = await t.app.inject({ method: 'POST', url: `/api/incidents/${incidentId}/teams`, headers: { cookie: manager, ...sfs }, payload: { name: 'Alpha' } });
    expect(dup.statusCode).toBe(400);

    const set = await t.app.inject({ method: 'PUT', url: `/api/teams/${a.id}/members`, headers: { cookie: manager, ...sfs }, payload: { userIds: [t.seed.member.id, t.seed.admin.id, t.seed.manager.id], leaderUserId: t.seed.admin.id } });
    expect(set.statusCode).toBe(200);
    const team = json(set).team;
    const cs = Object.fromEntries(team.members.map((m: any) => [m.userId, m.callsign]));
    expect(cs[t.seed.admin.id]).toBe('Alpha-0');
    expect(cs[t.seed.member.id]).toBe('Alpha-1');
    expect(cs[t.seed.manager.id]).toBe('Alpha-2');
    expect(team.leaderUserId).toBe(t.seed.admin.id);
    // manager was not "responding" before: assignment makes them responding
    expect(t.search.responders(incidentId).find((r) => r.userId === t.seed.manager.id)?.status).toBe('responding');

    // change leader to member: member → 0, admin keeps a non-zero number, manager keeps 2
    const re = json(await t.app.inject({ method: 'PATCH', url: `/api/teams/${a.id}`, headers: { cookie: manager, ...sfs }, payload: { leaderUserId: t.seed.member.id, searchWidthM: 30 } })).team;
    const cs2 = Object.fromEntries(re.members.map((m: any) => [m.userId, m.callsign]));
    expect(cs2[t.seed.member.id]).toBe('Alpha-0');
    expect(cs2[t.seed.manager.id]).toBe('Alpha-2');
    expect(cs2[t.seed.admin.id]).toBe('Alpha-1');
    expect(re.searchWidthM).toBe(30);

    // moving the manager to Bravo removes them from Alpha
    const bravo = json(await t.app.inject({ method: 'PUT', url: `/api/teams/${b.id}/members`, headers: { cookie: manager, ...sfs }, payload: { userIds: [t.seed.manager.id], leaderUserId: t.seed.manager.id } })).team;
    expect(bravo.members[0].callsign).toBe('Bravo-0');
    expect(t.search.team(a.id)!.members.map((m) => m.userId)).not.toContain(t.seed.manager.id);
    // members cannot manage teams
    expect((await t.app.inject({ method: 'PUT', url: `/api/teams/${a.id}/members`, headers: { cookie: member, ...sfs }, payload: { userIds: [] } })).statusCode).toBe(403);
  });

  it('track context: team members and responders are tracked with team + callsign', async () => {
    const dev = json(await t.app.inject({ method: 'POST', url: '/api/devices', headers: { cookie: member, ...sfs }, payload: { name: 'iPhone' } }));
    const ts = nowSec();
    for (let i = 0; i < 3; i++) {
      await t.app.inject({ method: 'POST', url: '/ot', headers: { authorization: basic(dev.device.username, dev.secret) }, payload: { _type: 'location', lat: 53.39 + i * 0.001, lon: -6.06, tst: ts + i * 30, acc: 5, alt: 10 + i } });
    }
    // a long gap, then more
    await t.app.inject({ method: 'POST', url: '/ot', headers: { authorization: basic(dev.device.username, dev.secret) }, payload: { _type: 'location', lat: 53.40, lon: -6.05, tst: ts + 2000, acc: 5 } });
    const rows = t.db.all<any>('SELECT team_id FROM positions');
    expect(rows).toHaveLength(4);
    const alphaViaApi = json(await t.app.inject({ method: 'GET', url: '/api/search', headers: { cookie: member } })).teams[0].id;
    expect(rows.every((r) => r.team_id === alphaViaApi)).toBe(true);
    const snap = t.search.snapshot();
    expect(snap.latest[t.seed.member.id].callsign).toBe('Alpha-0');
    const tracks = json(await t.app.inject({ method: 'GET', url: `/api/incidents/${incidentId}/tracks`, headers: { cookie: member } }));
    expect(tracks.features).toHaveLength(2); // split at the 2000 s gap
    expect(tracks.features[0].geometry.coordinates[0]).toEqual([-6.06, 53.39, 10]);
    expect(tracks.features[0].properties.callsign).toBeDefined();
    const alphaId = t.search.teams(incidentId)[0].id;
    expect(tracksFor(t.db, incidentId, { gapSec: 300, teamId: alphaId }).features.length).toBe(2);
    expect(tracksFor(t.db, incidentId, { gapSec: 300, teamId: 999 }).features.length).toBe(0);
  });

  it('targets: create, assign, update status and geometry, delete', async () => {
    const alpha = t.search.teams(incidentId)[0];
    const pt = await t.app.inject({ method: 'POST', url: `/api/incidents/${incidentId}/targets`, headers: { cookie: manager, ...sfs }, payload: { kind: 'point', geometry: { type: 'Point', coordinates: [-6.055, 53.41] }, notes: 'last seen' } });
    expect(pt.statusCode).toBe(200);
    expect(json(pt).target.name).toBe('T1');
    expect(json(pt).target.status).toBe('planned');
    const area = json(await t.app.inject({ method: 'POST', url: `/api/incidents/${incidentId}/targets`, headers: { cookie: manager, ...sfs }, payload: { kind: 'area', name: 'East shore', geometry: { type: 'Polygon', coordinates: [[[-6.07, 53.40], [-6.05, 53.40], [-6.05, 53.39], [-6.07, 53.39]]] }, teamId: alpha.id, priority: 1 } })).target;
    expect(area.status).toBe('assigned');
    expect(area.geometry.coordinates[0]).toHaveLength(5);
    const bad = await t.app.inject({ method: 'POST', url: `/api/incidents/${incidentId}/targets`, headers: { cookie: manager, ...sfs }, payload: { kind: 'area', geometry: { type: 'Point', coordinates: [0, 0] } } });
    expect(bad.statusCode).toBe(400);
    const done = json(await t.app.inject({ method: 'PATCH', url: `/api/targets/${area.id}`, headers: { cookie: manager, ...sfs }, payload: { status: 'done' } })).target;
    expect(done.completedAt).toBeDefined();
    const moved = json(await t.app.inject({ method: 'PATCH', url: `/api/targets/${json(pt).target.id}`, headers: { cookie: manager, ...sfs }, payload: { geometry: { type: 'Point', coordinates: [-6.05, 53.42] }, teamId: alpha.id } })).target;
    expect(moved.geometry.coordinates).toEqual([-6.05, 53.42]);
    expect(moved.status).toBe('assigned');
    expect(t.search.snapshot().targets).toHaveLength(2);
    const exp = await t.app.inject({ method: 'GET', url: `/api/incidents/${incidentId}/export.geojson`, headers: { cookie: manager } });
    expect(exp.statusCode).toBe(200);
    expect(json(exp).features.filter((f: any) => f.properties.kind === 'target')).toHaveLength(2);
    expect(json(exp).features.some((f: any) => f.properties.kind === 'track')).toBe(true);
    expect((await t.app.inject({ method: 'DELETE', url: `/api/targets/${moved.id}`, headers: { cookie: manager, ...sfs } })).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'DELETE', url: `/api/targets/${moved.id}`, headers: { cookie: manager, ...sfs } })).statusCode).toBe(404);
  });

  it('stand-down closes the incident, stands teams down and stops tracking', async () => {
    const close = await t.app.inject({ method: 'POST', url: `/api/incidents/${incidentId}/close`, headers: { cookie: manager, ...sfs } });
    expect(close.statusCode).toBe(200);
    expect(t.store.getMode().mode).toBe('standby');
    expect(t.search.openIncident()).toBeUndefined();
    expect(t.search.teams(incidentId).every((x) => x.status === 'stood-down')).toBe(true);
    expect(t.search.current(t.seed.member.id)).toBeUndefined();
    expect(t.search.listIncidents()[0].endedAt).toBeDefined();
    expect((await t.app.inject({ method: 'POST', url: `/api/incidents/${incidentId}/teams`, headers: { cookie: manager, ...sfs }, payload: {} })).statusCode).toBe(400);
  });

  it('a callout via the bridge token also opens an incident row', async () => {
    const r = await t.app.inject({ method: 'POST', url: '/api/callout', headers: { authorization: 'Bearer bridge-token' }, payload: { text: 'PAGER: vessel aground' } });
    expect(r.statusCode).toBe(200);
    expect(t.search.openIncident()?.text).toBe('PAGER: vessel aground');
    t.callout.standdown('test');
  });
});
