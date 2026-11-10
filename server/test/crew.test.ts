import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testApp } from './helpers/app.js';

const AREA = { type: 'Polygon', coordinates: [[[-6.07, 53.37], [-6.06, 53.37], [-6.06, 53.38], [-6.07, 53.38], [-6.07, 53.37]]] };
const basic = (u: string, p: string) => `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;

describe('crew in the field', () => {
  let t: Awaited<ReturnType<typeof testApp>>;
  let manager: string, member: string, admin: string;
  let incId: string, targetId: number, otherTargetId: number;
  const json = (r: { body: string }) => JSON.parse(r.body);
  const call = (cookie: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown) => t.app.inject({ method, url, headers: { cookie, 'sec-fetch-site': 'same-origin' }, payload: payload as any });
  beforeAll(async () => {
    t = await testApp();
    manager = await t.login('manager');
    member = await t.login('member');
    admin = await t.login('admin');
    incId = json(await call(manager, 'POST', '/api/incidents', { text: 'crew test', lat: 53.3735, lon: -6.0608 })).incident.id;
    const alpha = json(await call(manager, 'POST', `/api/incidents/${incId}/teams`, {})).team;
    const bravo = json(await call(manager, 'POST', `/api/incidents/${incId}/teams`, {})).team;
    await call(manager, 'PUT', `/api/teams/${alpha.id}/members`, { userIds: [t.seed.member.id], leaderUserId: t.seed.member.id });
    await call(manager, 'PUT', `/api/teams/${bravo.id}/members`, { userIds: [t.seed.admin.id] });
    targetId = json(await call(manager, 'POST', `/api/incidents/${incId}/targets`, { name: 'S1 · Houses', kind: 'area', geometry: AREA, teamId: alpha.id })).target.id;
    otherTargetId = json(await call(manager, 'POST', `/api/incidents/${incId}/targets`, { name: 'S2 · Woods', kind: 'area', geometry: AREA, teamId: bravo.id })).target.id;
  });
  afterAll(async () => t.close());

  it('a team member starts and finishes their own target; the team status follows', async () => {
    const start = await call(member, 'POST', `/api/targets/${targetId}/progress`, { status: 'in-progress' });
    expect(start.statusCode).toBe(200);
    expect(json(start).target.status).toBe('in-progress');
    const snap = json(await call(manager, 'GET', '/api/search'));
    expect(snap.teams.find((x: { name: string }) => x.name === 'Alpha').status).toBe('searching');
    expect(json(await call(member, 'POST', `/api/targets/${targetId}/progress`, { status: 'done' })).target.status).toBe('done');
  });

  it("refuses another team's target, and statuses other than start and finish", async () => {
    expect((await call(member, 'POST', `/api/targets/${otherTargetId}/progress`, { status: 'in-progress' })).statusCode).toBe(403);
    expect((await call(member, 'POST', `/api/targets/${targetId}/progress`, { status: 'cancelled' })).statusCode).toBe(400);
    expect((await call(member, 'POST', '/api/targets/99999/progress', { status: 'done' })).statusCode).toBe(404);
  });

  it('reports a find at a given position, or at the phone’s last fix', async () => {
    const r = await call(member, 'POST', `/api/incidents/${incId}/finds`, { type: 'item', note: 'Grey beanie on the path', lat: 53.372, lon: -6.059 });
    expect(r.statusCode).toBe(200);
    expect(json(r).point).toMatchObject({ kind: 'find', note: 'Grey beanie on the path', lat: 53.372 });
    expect(json(r).point.label).toMatch(/^Item found · /);
    expect((await call(member, 'POST', `/api/incidents/${incId}/finds`, { type: 'clue' })).statusCode).toBe(400); // no fix yet
    const dev = json(await call(member, 'POST', '/api/devices', { name: 'iPhone' }));
    await t.app.inject({ method: 'POST', url: '/ot', headers: { authorization: basic(dev.device.username, dev.secret) }, payload: { _type: 'location', lat: 53.3701, lon: -6.0571, tst: Math.floor(Date.now() / 1000), acc: 5 } });
    const atFix = json(await call(member, 'POST', `/api/incidents/${incId}/finds`, { type: 'subject', note: 'Conscious, cold' }));
    expect(atFix.point).toMatchObject({ kind: 'find', lat: 53.3701, lon: -6.0571 });
    expect(atFix.point.label).toMatch(/^Subject found/);
    expect((await call(member, 'POST', `/api/incidents/${incId}/finds`, { type: 'treasure', lat: 53.37, lon: -6.06 })).statusCode).toBe(400);
  });

  it('keeps finds off display keys, and puts them and crew progress in the history', async () => {
    const key = t.sessions.createDisplayKey('tv').key;
    const tv = await t.app.inject({ method: 'GET', url: '/api/search', headers: { 'x-display-key': key } });
    expect(json(tv).incident.points.map((p: { kind: string }) => p.kind)).toEqual(['lkp']);
    expect(tv.body).not.toContain('beanie');
    const events = json(await call(admin, 'GET', `/api/incidents/${incId}/replay`)).events.map((e: { text: string }) => e.text);
    expect(events.some((x: string) => /reported a find: Item found/.test(x))).toBe(true);
    expect(events.some((x: string) => /started searching S1/.test(x))).toBe(true);
    expect(events.some((x: string) => /finished searching S1/.test(x))).toBe(true);
  });
});
