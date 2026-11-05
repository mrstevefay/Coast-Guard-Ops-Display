import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testApp } from './helpers/app.js';

describe('auth routes', () => {
  let t: Awaited<ReturnType<typeof testApp>>;
  beforeAll(async () => {
    t = await testApp();
  });
  afterAll(async () => t.close());

  const json = (res: { body: string }) => JSON.parse(res.body);

  it('rejects anonymous access to state and ws-adjacent routes', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/state' })).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'GET', url: '/api/mode' })).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'GET', url: '/api/auth/me' })).statusCode).toBe(401);
    const h = await t.app.inject({ method: 'GET', url: '/healthz' });
    expect(h.statusCode).toBe(200);
    expect(json(h).providers).toBeUndefined(); // no detail for anonymous
  });

  it('logs in with a cookie, reads me, logs out', async () => {
    const bad = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'joe@ops.test', password: 'wrong' } });
    expect(bad.statusCode).toBe(401);
    const cookie = await t.login('member');
    const me = await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(json(me).user.role).toBe('member');
    expect(json(me).user.email).toBe('joe@ops.test');
    const st = await t.app.inject({ method: 'GET', url: '/api/state', headers: { cookie } });
    expect(st.statusCode).toBe(200);
    const out = await t.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie, 'sec-fetch-site': 'same-origin' } });
    expect(out.statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).statusCode).toBe(401);
  });

  it('enforces the role matrix on user management', async () => {
    const member = await t.login('member');
    const manager = await t.login('manager');
    const admin = await t.login('admin');
    expect((await t.app.inject({ method: 'GET', url: '/api/users', headers: { cookie: member } })).statusCode).toBe(403);
    expect((await t.app.inject({ method: 'GET', url: '/api/users', headers: { cookie: manager } })).statusCode).toBe(200);
    const create = (cookie: string) =>
      t.app.inject({ method: 'POST', url: '/api/users', headers: { cookie, 'sec-fetch-site': 'same-origin' }, payload: { name: 'New Person', email: 'new@ops.test', role: 'member' } });
    expect((await create(manager)).statusCode).toBe(403);
    const res = await create(admin);
    expect(res.statusCode).toBe(200);
    expect(json(res).tempPassword).toMatch(/-/);
    expect(json(res).user.mustChangePassword).toBe(true);
    const id = json(res).user.id;
    const reset = await t.app.inject({ method: 'POST', url: `/api/users/${id}/reset-password`, headers: { cookie: admin, 'sec-fetch-site': 'same-origin' } });
    expect(reset.statusCode).toBe(200);
    const self = await t.app.inject({ method: 'PATCH', url: `/api/users/${t.seed.admin.id}`, headers: { cookie: admin, 'sec-fetch-site': 'same-origin' }, payload: { active: false } });
    expect(self.statusCode).toBe(400);
  });

  it('rejects cross-site mutating requests from browsers', async () => {
    const admin = await t.login('admin');
    const res = await t.app.inject({ method: 'POST', url: '/api/users', headers: { cookie: admin, 'sec-fetch-site': 'cross-site' }, payload: { name: 'X', email: 'x@ops.test', role: 'member' } });
    expect(res.statusCode).toBe(403);
    const res2 = await t.app.inject({ method: 'POST', url: '/api/users', headers: { cookie: admin, origin: 'https://evil.example' }, payload: { name: 'X', email: 'x@ops.test', role: 'member' } });
    expect(res2.statusCode).toBe(403);
  });

  it('changes password and revokes other sessions', async () => {
    const a = await t.login('member');
    const b = await t.login('member');
    const res = await t.app.inject({ method: 'POST', url: '/api/auth/password', headers: { cookie: a, 'sec-fetch-site': 'same-origin' }, payload: { current: 'member-pass-12', new: 'brand-new-pass-1' } });
    expect(res.statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: a } })).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: b } })).statusCode).toBe(401);
    // restore for later tests
    t.users.setPassword(t.seed.member.id, 'member-pass-12', false);
  });

  it('display keys grant read-only access and can be revoked', async () => {
    const admin = await t.login('admin');
    const mk = await t.app.inject({ method: 'POST', url: '/api/admin/display-keys', headers: { cookie: admin, 'sec-fetch-site': 'same-origin' }, payload: { label: 'Station TV' } });
    expect(mk.statusCode).toBe(200);
    const { id, key } = json(mk);
    expect(key.startsWith('dk_')).toBe(true);
    const viaHeader = await t.app.inject({ method: 'GET', url: '/api/state', headers: { 'x-display-key': key } });
    expect(viaHeader.statusCode).toBe(200);
    const viaQuery = await t.app.inject({ method: 'GET', url: `/api/mode?key=${key}` });
    expect(viaQuery.statusCode).toBe(200);
    const forbidden = await t.app.inject({ method: 'GET', url: '/api/users', headers: { 'x-display-key': key } });
    expect(forbidden.statusCode).toBe(403);
    const ex = await t.app.inject({ method: 'POST', url: '/api/auth/display', payload: { key } });
    expect(ex.statusCode).toBe(200);
    expect(ex.cookies.find((c) => c.name === 'cg_s')?.value).toBe(key);
    const del = await t.app.inject({ method: 'DELETE', url: `/api/admin/display-keys/${id}`, headers: { cookie: admin, 'sec-fetch-site': 'same-origin' } });
    expect(del.statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: '/api/state', headers: { 'x-display-key': key } })).statusCode).toBe(401);
  });

  it('callout endpoints accept the bridge token or a manager session, not a member', async () => {
    const member = await t.login('member');
    const manager = await t.login('manager');
    expect((await t.app.inject({ method: 'POST', url: '/api/callout', payload: { text: 'x' } })).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'POST', url: '/api/callout', headers: { cookie: member, 'sec-fetch-site': 'same-origin' }, payload: { text: 'x' } })).statusCode).toBe(401);
    const viaToken = await t.app.inject({ method: 'POST', url: '/api/callout', headers: { authorization: 'Bearer bridge-token' }, payload: { text: 'pager text' } });
    expect(viaToken.statusCode).toBe(200);
    expect(json(viaToken).incident.source).toBe('api');
    const viaManager = await t.app.inject({ method: 'POST', url: '/api/standdown', headers: { cookie: manager, 'sec-fetch-site': 'same-origin' } });
    expect(viaManager.statusCode).toBe(200);
    expect(json(viaManager).mode).toBe('standby');
    expect(t.audit.list().some((e) => e.action === 'callout.standdown')).toBe(true);
  });

  it('rate-limits login attempts per IP', async () => {
    let last = 0;
    for (let i = 0; i < 7; i++) {
      const r = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'nobody@ops.test', password: 'x' }, remoteAddress: '203.0.113.9' });
      last = r.statusCode;
    }
    expect(last).toBe(429);
  });
});

describe('open mode (Pi on the LAN)', () => {
  it('serves state anonymously and hides account routes', async () => {
    const t = await testApp((c) => {
      c.auth.open = true;
    });
    expect((await t.app.inject({ method: 'GET', url: '/api/state' })).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'a', password: 'b' } })).statusCode).toBe(404);
    expect(JSON.parse((await t.app.inject({ method: 'GET', url: '/api/auth/me' })).body).principal.kind).toBe('open');
    // callout still needs the bridge token
    expect((await t.app.inject({ method: 'POST', url: '/api/callout', payload: { text: 'x' } })).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'POST', url: '/api/callout', headers: { authorization: 'Bearer bridge-token' }, payload: { text: 'x' } })).statusCode).toBe(200);
    await t.close();
  });
});
