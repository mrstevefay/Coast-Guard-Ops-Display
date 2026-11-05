import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testApp } from './helpers/app.js';

describe('taskings, planning point, subject', () => {
  let t: Awaited<ReturnType<typeof testApp>>;
  let manager: string, member: string;
  const json = (r: { body: string }) => JSON.parse(r.body);
  beforeAll(async () => {
    t = await testApp();
    manager = await t.login('manager');
    member = await t.login('member');
  });
  afterAll(async () => t.close());

  let id: string;
  it('starts a tasking without changing display mode', async () => {
    const r = await t.app.inject({ method: 'POST', url: '/api/incidents', headers: { cookie: manager }, payload: { text: 'Training search, Howth Head paths', lat: 53.38, lon: -6.06 } });
    expect(r.statusCode).toBe(200);
    const inc = json(r).incident;
    expect(inc.kind).toBe('tasking');
    id = inc.id;
    expect(t.store.getMode().mode).toBe('standby');
    const snap = json(await t.app.inject({ method: 'GET', url: '/api/search', headers: { cookie: member } }));
    expect(snap.incident.id).toBe(id);
    expect(snap.incident.kind).toBe('tasking');
  });

  it('refuses a second open incident', async () => {
    const r = await t.app.inject({ method: 'POST', url: '/api/incidents', headers: { cookie: manager }, payload: { text: 'another' } });
    expect(r.statusCode).toBe(400);
    expect(json(r).error).toMatch(/already open/);
  });

  it('responders and teams work in a tasking; sweep width depends on daylight', async () => {
    expect((await t.app.inject({ method: 'PUT', url: `/api/incidents/${id}/response`, headers: { cookie: member }, payload: { status: 'responding' } })).statusCode).toBe(200);
    t.store.merge({ sun: { isDaylight: false } as any });
    const nightRes = await t.app.inject({ method: 'POST', url: `/api/incidents/${id}/teams`, headers: { cookie: manager }, payload: {} });
    const night = json(nightRes).team;
    expect(night.searchWidthM).toBe(t.cfg.search.nightSearchWidthM);
    t.store.merge({ sun: { isDaylight: true } as any });
    const day = json(await t.app.inject({ method: 'POST', url: `/api/incidents/${id}/teams`, headers: { cookie: manager }, payload: {} })).team;
    expect(day.searchWidthM).toBe(t.cfg.search.defaultSearchWidthM);
    const w = json(await t.app.inject({ method: 'PATCH', url: `/api/teams/${day.id}`, headers: { cookie: manager }, payload: { searchWidthM: 15 } })).team;
    expect(w.searchWidthM).toBe(15);
  });

  it('sets and clears the planning point, visible in the snapshot', async () => {
    const r = await t.app.inject({ method: 'PATCH', url: `/api/incidents/${id}`, headers: { cookie: manager }, payload: { ipp: { lat: 53.3851, lon: -6.0652, label: 'Car park' } } });
    expect(r.statusCode).toBe(200);
    expect(json(r).incident.ipp).toMatchObject({ lat: 53.3851, lon: -6.0652, label: 'Car park' });
    const snap = json(await t.app.inject({ method: 'GET', url: '/api/search', headers: { cookie: member } }));
    expect(snap.incident.ipp.label).toBe('Car park');
    expect((await t.app.inject({ method: 'PATCH', url: `/api/incidents/${id}`, headers: { cookie: member }, payload: { ipp: null } })).statusCode).toBe(403);
    expect((await t.app.inject({ method: 'PATCH', url: `/api/incidents/${id}`, headers: { cookie: manager }, payload: { ipp: { lat: 200, lon: 0 } } })).statusCode).toBe(400);
    const c = await t.app.inject({ method: 'PATCH', url: `/api/incidents/${id}`, headers: { cookie: manager }, payload: { ipp: null } });
    expect(json(c).incident.ipp).toBeUndefined();
  });

  it('subject details: manager writes, members read, display keys never see them', async () => {
    const before = json(await t.app.inject({ method: 'GET', url: '/api/search', headers: { cookie: member } })).incident.subjectUpdatedAt;
    expect(before).toBeUndefined();
    const put = await t.app.inject({ method: 'PUT', url: `/api/incidents/${id}/subject`, headers: { cookie: manager }, payload: { name: 'J. Doe', sex: 'M', age: 67, clothing: 'Blue jacket, grey trousers', locations: 'Lives Sutton; walks the cliff path', despondent: true, selfHarmHistory: true, selfHarmMeans: 'Overdose (2019)' } });
    expect(put.statusCode).toBe(200);
    expect(json(put).subject).toMatchObject({ name: 'J. Doe', age: 67, despondent: true, mentalHealth: false, selfHarmHistory: true, hasPhoto: false });
    expect((await t.app.inject({ method: 'PUT', url: `/api/incidents/${id}/subject`, headers: { cookie: member }, payload: { name: 'x' } })).statusCode).toBe(403);
    expect((await t.app.inject({ method: 'PUT', url: `/api/incidents/${id}/subject`, headers: { cookie: manager }, payload: { age: 400 } })).statusCode).toBe(400);
    const got = json(await t.app.inject({ method: 'GET', url: `/api/incidents/${id}/subject`, headers: { cookie: member } })).subject;
    expect(got.selfHarmMeans).toBe('Overdose (2019)');
    // snapshot only carries the bump, never the details
    const snap = await t.app.inject({ method: 'GET', url: '/api/search', headers: { cookie: member } });
    expect(json(snap).incident.subjectUpdatedAt).toBeTruthy();
    expect(snap.body).not.toContain('Doe');
    // display key: snapshot ok, subject forbidden
    const key = t.sessions.createDisplayKey('tv').key;
    expect((await t.app.inject({ method: 'GET', url: '/api/search', headers: { 'x-display-key': key } })).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: `/api/incidents/${id}/subject`, headers: { 'x-display-key': key } })).statusCode).toBe(403);
    // audit has field names only
    const audit = JSON.stringify(t.audit.list({ limit: 20 }));
    expect(audit).toContain('subject.updated');
    expect(audit).not.toContain('Doe');
    expect(audit).not.toContain('Overdose');
  });

  it('photo upload, fetch and delete', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001', 'hex');
    const up = await t.app.inject({ method: 'PUT', url: `/api/incidents/${id}/subject/photo`, headers: { cookie: manager, 'content-type': 'image/png' }, payload: png });
    expect(up.statusCode).toBe(200);
    expect(json(up).subject.hasPhoto).toBe(true);
    const get = await t.app.inject({ method: 'GET', url: `/api/incidents/${id}/subject/photo`, headers: { cookie: member } });
    expect(get.statusCode).toBe(200);
    expect(get.headers['content-type']).toBe('image/png');
    expect(get.headers['cache-control']).toContain('no-store');
    expect(get.rawPayload.length).toBe(png.length);
    expect((await t.app.inject({ method: 'PUT', url: `/api/incidents/${id}/subject/photo`, headers: { cookie: manager, 'content-type': 'text/plain' }, payload: 'nope' })).statusCode).toBe(400);
    const del = await t.app.inject({ method: 'DELETE', url: `/api/incidents/${id}/subject/photo`, headers: { cookie: manager } });
    expect(json(del).subject.hasPhoto).toBe(false);
    expect((await t.app.inject({ method: 'GET', url: `/api/incidents/${id}/subject/photo`, headers: { cookie: member } })).statusCode).toBe(404);
  });

  it('closes the tasking; a callout then supersedes a new tasking', async () => {
    const close = await t.app.inject({ method: 'POST', url: `/api/incidents/${id}/close`, headers: { cookie: manager } });
    expect(close.statusCode).toBe(200);
    expect(json(await t.app.inject({ method: 'GET', url: '/api/search', headers: { cookie: member } })).incident).toBeUndefined();
    expect(t.store.getMode().mode).toBe('standby');

    const t2 = json(await t.app.inject({ method: 'POST', url: '/api/incidents', headers: { cookie: manager }, payload: { text: 'Second tasking' } })).incident;
    const co = await t.app.inject({ method: 'POST', url: '/api/incidents', headers: { cookie: manager }, payload: { text: 'PAGER: PERSON IN WATER', callout: true } });
    expect(co.statusCode).toBe(200);
    expect(json(co).incident.kind).toBe('callout');
    expect(t.store.getMode().mode).toBe('callout');
    expect(t.search.incidentById(t2.id)!.end_reason).toBe('superseded');
    // stand-down closes the callout and the display returns to standby
    await t.app.inject({ method: 'POST', url: `/api/incidents/${json(co).incident.id}/close`, headers: { cookie: manager } });
    expect(t.store.getMode().mode).toBe('standby');
    expect(t.search.openIncident()).toBeUndefined();
  });
});
