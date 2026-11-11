import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testApp } from './helpers/app.js';

const AREA = { type: 'Polygon', coordinates: [[[-6.07, 53.37], [-6.06, 53.37], [-6.06, 53.38], [-6.07, 53.38], [-6.07, 53.37]]] };
const sub = (n: string, host = 'fcm.googleapis.com') => ({ endpoint: `https://${host}/fcm/send/${n}`, keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) } });
const settle = () => new Promise((r) => setTimeout(r, 30));

describe('push alerts', () => {
  let t: Awaited<ReturnType<typeof testApp>>;
  let member: string, manager: string, admin: string;
  const json = (r: { body: string }) => JSON.parse(r.body);
  const call = (cookie: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown) => t.app.inject({ method, url, headers: { cookie, 'sec-fetch-site': 'same-origin' }, payload: payload as object });
  beforeAll(async () => {
    t = await testApp();
    member = await t.login('member');
    manager = await t.login('manager');
    admin = await t.login('admin');
  });
  afterAll(async () => t.close());

  it('hands out one stable public key; anonymous callers get nothing', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/push/key' })).statusCode).toBe(401);
    const a = json(await call(member, 'GET', '/api/push/key')).key;
    expect(a).toMatch(/^[\w-]{80,}$/);
    expect(json(await call(manager, 'GET', '/api/push/key')).key).toBe(a);
    // the private half never leaves the server
    expect(JSON.stringify(json(await call(admin, 'GET', '/api/users')))).not.toContain(t.db.get<{ value: string }>("SELECT value FROM app_secrets WHERE key = 'vapid.private'")!.value);
  });

  it('subscribes a phone, only to a known push service', async () => {
    expect((await call(member, 'POST', '/api/push/subscriptions', { subscription: sub('joe-phone') })).statusCode).toBe(200);
    expect((await call(member, 'POST', '/api/push/subscriptions', { subscription: sub('joe-phone') })).statusCode).toBe(200); // again: no duplicate
    expect(t.push.counts().get(t.seed.member.id)).toBe(1);
    for (const bad of [sub('x', 'internal.example'), { endpoint: 'http://fcm.googleapis.com/x', keys: sub('x').keys }, { endpoint: 'https://169.254.169.254/latest', keys: sub('x').keys }, { endpoint: sub('y').endpoint, keys: { p256dh: 'short', auth: 'a'.repeat(22) } }, {}]) {
      expect((await call(member, 'POST', '/api/push/subscriptions', { subscription: bad })).statusCode).toBe(400);
    }
    expect((await call(manager, 'POST', '/api/push/subscriptions', { subscription: sub('sam-phone', 'web.push.apple.com') })).statusCode).toBe(200);
    const users = json(await call(admin, 'GET', '/api/users')).users;
    expect(users.find((u: { id: number }) => u.id === t.seed.member.id).alertPhones).toBe(1);
    expect(users.find((u: { id: number }) => u.id === t.seed.admin.id).alertPhones).toBe(0);
  });

  it('a test alert goes to the caller only', async () => {
    t.pushed.length = 0;
    expect(json(await call(member, 'POST', '/api/push/test'))).toMatchObject({ sent: 1, failed: 0 });
    expect(t.pushed.map((p) => p.endpoint)).toEqual([sub('joe-phone').endpoint]);
    expect(json(await call(admin, 'POST', '/api/push/test')).sent).toBe(0); // no phone: nothing sent, no error
  });

  it('a callout alerts everyone once; a manual stand-down tells those who responded', async () => {
    t.pushed.length = 0;
    const mode = t.callout.callout({ text: 'Person in the water off the East Pier' });
    await settle();
    expect(t.pushed.map((p) => p.endpoint).sort()).toEqual([sub('joe-phone').endpoint, sub('sam-phone', 'web.push.apple.com').endpoint].sort());
    expect(t.pushed[0].payload).toMatchObject({ title: 'CALLOUT · HOWTH CG', body: 'Person in the water off the East Pier', tag: 'callout', url: '/m/#/status', urgent: true });
    await call(member, 'PUT', `/api/incidents/${mode.incident!.id}/response`, { status: 'responding' });
    t.pushed.length = 0;
    t.callout.standdown('manual');
    await settle();
    expect(t.pushed.map((p) => [p.endpoint, p.payload.title, p.payload.tag])).toEqual([[sub('joe-phone').endpoint, 'Stand down · HOWTH CG', 'callout']]);
    // the display's own timeout is not worth waking anyone for
    t.callout.callout({ text: 'second' });
    await settle();
    t.pushed.length = 0;
    t.callout.standdown('auto-timeout');
    await settle();
    expect(t.pushed).toEqual([]);
  });

  it('a target given to a team alerts that team, not the others', async () => {
    const incId = json(await call(manager, 'POST', '/api/incidents', { text: 'tasking, quiet' })).incident.id;
    await settle();
    t.pushed.length = 0;
    const alpha = json(await call(manager, 'POST', `/api/incidents/${incId}/teams`, {})).team;
    await call(manager, 'POST', `/api/teams/${alpha.id}/members`, { userIds: [t.seed.member.id] });
    const target = json(await call(manager, 'POST', `/api/incidents/${incId}/targets`, { name: 'S1 · Woods', kind: 'area', geometry: AREA })).target;
    await settle();
    expect(t.pushed).toEqual([]); // a tasking opens quietly, and a target with no team alerts nobody
    await call(manager, 'PATCH', `/api/targets/${target.id}`, { teamId: alpha.id });
    await settle();
    expect(t.pushed.map((p) => [p.endpoint, p.payload.title, p.payload.body])).toEqual([[sub('joe-phone').endpoint, 'New target · Alpha', 'S1 · Woods']]);
    t.pushed.length = 0;
    await call(manager, 'PATCH', `/api/targets/${target.id}`, { status: 'in-progress' }); // same team: no second alert
    await settle();
    expect(t.pushed).toEqual([]);
  });

  it('drops a phone the push service says is gone, keeps one that failed once, and skips deactivated members', async () => {
    t.pushFail.set(sub('joe-phone').endpoint, 410);
    t.pushFail.set(sub('sam-phone', 'web.push.apple.com').endpoint, 500);
    const r = await t.push.notify('all', { title: 'x', body: 'y', tag: 'z' });
    expect(r).toEqual({ sent: 0, failed: 2, removed: 1 });
    expect(t.push.counts().get(t.seed.member.id)).toBeUndefined();
    expect(t.push.counts().get(t.seed.manager.id)).toBe(1);
    t.pushFail.clear();
    await call(admin, 'PATCH', `/api/users/${t.seed.manager.id}`, { active: false });
    expect((await t.push.notify('all', { title: 'x', body: 'y', tag: 'z' })).sent).toBe(0);
    await call(admin, 'PATCH', `/api/users/${t.seed.manager.id}`, { active: true });
  });

  it('turning alerts off removes the phone; someone waiting for approval alerts the admins', async () => {
    const m2 = await t.login('manager');
    await call(m2, 'POST', '/api/push/unsubscribe', { endpoint: sub('sam-phone', 'web.push.apple.com').endpoint });
    expect(t.push.counts().size).toBe(0);
    await call(admin, 'POST', '/api/push/subscriptions', { subscription: sub('ada-phone') });
    const url = json(await call(admin, 'POST', '/api/invites', { label: 'Crew night', maxUses: 5 })).url;
    t.pushed.length = 0;
    await t.app.inject({ method: 'POST', url: `/api/join/${url.split('#/join/')[1]}`, payload: { name: 'New Person', email: 'newp@ops.test', password: 'new-person-pass' } });
    await settle();
    expect(t.pushed.map((p) => [p.endpoint, p.payload.title, p.payload.url])).toEqual([[sub('ada-phone').endpoint, 'Account waiting for approval', '/sm/#settings/users']]);
  });
});
