import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testApp } from './helpers/app.js';

describe('crew invite links', () => {
  let t: Awaited<ReturnType<typeof testApp>>;
  beforeAll(async () => {
    t = await testApp();
  });
  afterAll(async () => t.close());

  const json = (res: { body: string }) => JSON.parse(res.body);
  const same = { 'sec-fetch-site': 'same-origin' };
  const tokenOf = (url: string) => url.split('#/join/')[1];
  const make = async (payload: Record<string, unknown>, cookie?: string) =>
    t.app.inject({ method: 'POST', url: '/api/invites', headers: { cookie: cookie ?? (await t.login('admin')), ...same }, payload });
  const join = (token: string, payload: Record<string, unknown>) => t.app.inject({ method: 'POST', url: `/api/join/${token}`, payload });

  it('only admins make invites; the link carries the token in the fragment and a QR code', async () => {
    expect((await make({}, await t.login('manager'))).statusCode).toBe(403);
    const res = await make({ label: 'Aoife' });
    expect(res.statusCode).toBe(200);
    const b = json(res);
    expect(b.url).toMatch(/^https:\/\/ops\.test\/m\/#\/join\/[\w-]{20,}$/);
    expect(b.qrSvg).toContain('<svg');
    expect(b.invite).toMatchObject({ label: 'Aoife', maxUses: 1, uses: 0, needsApproval: false, open: true });
    // the database keeps only the hash
    const list = json(await t.app.inject({ method: 'GET', url: '/api/invites', headers: { cookie: await t.login('admin') } })).invites;
    expect(JSON.stringify(list)).not.toContain(tokenOf(b.url));
  });

  it('a personal link signs the new member straight in, once', async () => {
    const token = tokenOf(json(await make({ label: 'Brian' })).url);
    const info = await t.app.inject({ method: 'GET', url: `/api/join/${token}` });
    expect(info.statusCode).toBe(200);
    expect(json(info).needsApproval).toBe(false);
    const res = await join(token, { name: 'Brian Doyle', email: 'brian@ops.test', callsign: 'BD', password: 'brian-pass-123' });
    expect(res.statusCode).toBe(200);
    const u = json(res).user;
    expect(u).toMatchObject({ name: 'Brian Doyle', callsign: 'BD', role: 'member', active: true, mustChangePassword: false });
    const cookie = String(res.headers['set-cookie']).split(';')[0];
    expect(json(await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).user.email).toBe('brian@ops.test');
    // used up
    const again = await join(token, { name: 'Someone Else', email: 'else@ops.test', password: 'else-pass-1234' });
    expect(again.statusCode).toBe(410);
    expect(json(again).error).toMatch(/already been used/);
  });

  it('a group link makes accounts that wait for approval; login says so; approve or reject', async () => {
    const token = tokenOf(json(await make({ label: 'Crew night', maxUses: 5, days: 3 })).url);
    const res = await join(token, { name: 'Ciara Walsh', email: 'ciara@ops.test', password: 'ciara-pass-123' });
    expect(json(res)).toEqual({ pending: true });
    expect(res.headers['set-cookie']).toBeUndefined();
    const login = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'ciara@ops.test', password: 'ciara-pass-123' } });
    expect(login.statusCode).toBe(403);
    expect(json(login).error).toMatch(/waiting for the station officer/);
    // a wrong password on a pending account is just a wrong password
    expect((await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'ciara@ops.test', password: 'nope-nope-nope' } })).statusCode).toBe(401);

    const admin = await t.login('admin');
    const users = json(await t.app.inject({ method: 'GET', url: '/api/users', headers: { cookie: admin } })).users;
    const ciara = users.find((u: { email: string }) => u.email === 'ciara@ops.test');
    expect(ciara).toMatchObject({ pending: true, active: false, invitedVia: 'Crew night' });
    expect((await t.app.inject({ method: 'POST', url: `/api/users/${ciara.id}/approve`, headers: { cookie: await t.login('manager'), ...same } })).statusCode).toBe(403);
    expect((await t.app.inject({ method: 'POST', url: `/api/users/${ciara.id}/approve`, headers: { cookie: admin, ...same } })).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'ciara@ops.test', password: 'ciara-pass-123' } })).statusCode).toBe(200);

    const dara = await join(token, { name: 'Dara Nolan', email: 'dara@ops.test', password: 'dara-pass-1234' });
    expect(json(dara).pending).toBe(true);
    const daraId = json(await t.app.inject({ method: 'GET', url: '/api/users', headers: { cookie: admin } })).users.find((u: { email: string }) => u.email === 'dara@ops.test').id;
    expect((await t.app.inject({ method: 'POST', url: `/api/users/${daraId}/reject`, headers: { cookie: admin, ...same } })).statusCode).toBe(200);
    expect(json(await t.app.inject({ method: 'GET', url: '/api/users', headers: { cookie: admin } })).users.some((u: { email: string }) => u.email === 'dara@ops.test')).toBe(false);
    // an approved account cannot be "rejected"
    expect((await t.app.inject({ method: 'POST', url: `/api/users/${ciara.id}/reject`, headers: { cookie: admin, ...same } })).statusCode).toBe(400);
  });

  it('refuses withdrawn, unknown and bad requests without using up the link', async () => {
    const b = json(await make({ maxUses: 3, needsApproval: false }));
    const token = tokenOf(b.url);
    expect((await join(token, { name: 'X', email: 'joe@ops.test', password: 'long-enough-1' })).statusCode).toBe(400); // existing email
    expect((await join(token, { name: 'X', email: 'x@ops.test', password: 'short' })).statusCode).toBe(400);
    expect((await join(token, { name: 'X', email: 'x@ops.test', callsign: 'WAY-TOO-LONG-CALLSIGN', password: 'long-enough-1' })).statusCode).toBe(400);
    const list = json(await t.app.inject({ method: 'GET', url: '/api/invites', headers: { cookie: await t.login('admin') } })).invites;
    expect(list.find((i: { id: string }) => i.id === b.invite.id).uses).toBe(0);
    expect((await t.app.inject({ method: 'DELETE', url: `/api/invites/${b.invite.id}`, headers: { cookie: await t.login('admin'), ...same } })).statusCode).toBe(200);
    const gone = await t.app.inject({ method: 'GET', url: `/api/join/${token}` });
    expect(gone.statusCode).toBe(410);
    expect(json(gone).error).toMatch(/withdrawn/);
    expect((await t.app.inject({ method: 'GET', url: '/api/join/not-a-real-token' })).statusCode).toBe(404);
    expect((await make({ maxUses: 0 })).statusCode).toBe(400);
    expect((await make({ days: 60 })).statusCode).toBe(400);
  });
});
