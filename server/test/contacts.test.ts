import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runRetention } from '../src/search/retention.js';
import { testApp } from './helpers/app.js';

describe('incident contacts', () => {
  let t: Awaited<ReturnType<typeof testApp>>;
  let manager: string, member: string;
  let incId: string;
  const json = (r: { body: string }) => JSON.parse(r.body);
  const call = (cookie: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) => t.app.inject({ method, url, headers: { cookie }, payload: payload as any });
  beforeAll(async () => {
    t = await testApp();
    manager = await t.login('manager');
    member = await t.login('member');
    incId = json(await call(manager, 'POST', '/api/incidents', { text: 'contacts test' })).incident.id;
  });
  afterAll(async () => t.close());

  it('keeps a station directory of agencies, and refuses private people in it', async () => {
    const garda = await call(manager, 'POST', '/api/contacts', { role: 'garda', name: 'Howth Garda Station', organisation: 'An Garda Síochána', phone: '01 666 4900' });
    expect(garda.statusCode).toBe(200);
    expect((await call(manager, 'POST', '/api/contacts', { role: 'nok', name: 'A relative' })).statusCode).toBe(400);
    expect((await call(manager, 'POST', '/api/contacts', { role: 'garda', name: 'Bad phone', phone: 'call me maybe' })).statusCode).toBe(400);
    expect(json(await call(manager, 'GET', '/api/contacts')).contacts.map((c: { name: string }) => c.name)).toEqual(['Howth Garda Station']);
    expect((await call(member, 'GET', '/api/contacts')).statusCode).toBe(403);
  });

  it('adds contacts from the directory or by hand, and logs calls', async () => {
    const dir = json(await call(manager, 'GET', '/api/contacts')).contacts[0];
    const garda = json(await call(manager, 'POST', `/api/incidents/${incId}/contacts`, { directoryId: dir.id, name: 'Garda Byrne', reference: 'PULSE 12345678' })).contact;
    expect(garda).toMatchObject({ role: 'garda', name: 'Garda Byrne', organisation: 'An Garda Síochána', phone: '01 666 4900', reference: 'PULSE 12345678', directoryId: dir.id });
    const nok = json(await call(manager, 'POST', `/api/incidents/${incId}/contacts`, { role: 'nok', name: 'Mary Byrne (wife)', phone: '087 123 4567' })).contact;
    await call(manager, 'POST', `/api/incidents/${incId}/contact-log`, { contactId: garda.id, direction: 'in', text: 'Car confirmed at the Summit car park' });
    await call(manager, 'POST', `/api/incidents/${incId}/contact-log`, { contactId: nok.id, direction: 'out', text: 'He walks the cliff path most evenings' });
    expect((await call(manager, 'POST', `/api/incidents/${incId}/contact-log`, { direction: 'out', text: '  ' })).statusCode).toBe(400);
    const r = json(await call(manager, 'GET', `/api/incidents/${incId}/contacts`));
    expect(r.contacts).toHaveLength(2);
    expect(r.log.map((l: { text: string }) => l.text)).toEqual(['Car confirmed at the Summit car park', 'He walks the cliff path most evenings']);
    expect(r.log[0].byName).toBe('Sam Manager');
  });

  it('never sends contacts to crew or displays; the snapshot only says they changed', async () => {
    expect((await call(member, 'GET', `/api/incidents/${incId}/contacts`)).statusCode).toBe(403);
    const crew = await call(member, 'GET', '/api/search');
    expect(crew.body).not.toContain('Mary Byrne');
    expect(crew.body).not.toContain('087 123');
    expect(json(await call(manager, 'GET', '/api/search')).incident.contactsRev).toBeTruthy();
    const key = t.sessions.createDisplayKey('tv').key;
    const tv = await t.app.inject({ method: 'GET', url: '/api/search', headers: { 'x-display-key': key } });
    expect(tv.body).not.toContain('Mary');
    expect(json(tv).incident.contactsRev).toBeUndefined();
  });

  it('puts calls in the timeline, agencies in the report, and every read in the audit log', async () => {
    const events = json(await call(manager, 'GET', `/api/incidents/${incId}/replay`)).events.map((e: { text: string }) => e.text);
    expect(events).toContain('Sam Manager took a call from Garda Byrne (Gardaí): Car confirmed at the Summit car park');
    const html = (await call(manager, 'GET', `/api/incidents/${incId}/report.html`)).body;
    expect(html).toContain('PULSE 12345678');
    expect(html).toContain('01 666 4900');
    expect(html).toContain('Mary Byrne (wife)');
    expect(html).not.toContain('087 123 4567'); // next of kin by name only
    expect(t.db.get<{ n: number }>("SELECT COUNT(*) n FROM audit_log WHERE action = 'contacts.viewed'")!.n).toBeGreaterThan(0);
    expect(t.db.all<{ detail: string }>("SELECT detail FROM audit_log WHERE action = 'contact.logged'").every((a) => !/cliff path/.test(a.detail))).toBe(true);
  });

  it('retention clears next of kin after the incident has been closed long enough, and keeps agencies', async () => {
    await call(manager, 'POST', `/api/incidents/${incId}/close`);
    t.db.run('UPDATE incidents SET ended_at = ? WHERE id = ?', new Date(Date.now() - 40 * 86400_000).toISOString(), incId);
    const res = runRetention(t.db, t.cfg, { devices: t.devices, sessions: t.sessions, audit: t.audit });
    expect(res.privateContactsCleared).toBe(1);
    const r = json(await call(manager, 'GET', `/api/incidents/${incId}/contacts`));
    const nok = r.contacts.find((c: { role: string }) => c.role === 'nok');
    expect(nok.name).toBe('(removed)');
    expect(nok.phone).toBeUndefined();
    expect(nok.redactedAt).toBeTruthy();
    expect(r.contacts.find((c: { role: string }) => c.role === 'garda').phone).toBe('01 666 4900');
    expect(r.log[1].text).toMatch(/removed/);
    expect(r.log[0].text).toBe('Car confirmed at the Summit car park');
    expect(runRetention(t.db, t.cfg, { devices: t.devices, sessions: t.sessions, audit: t.audit }).privateContactsCleared).toBe(0);
  });
});
