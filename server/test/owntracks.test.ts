import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { slug, tidFor } from '../src/search/devices.js';
import { friendsReply, parseBasicAuth, parseLocation } from '../src/search/owntracks.js';
import { testApp } from './helpers/app.js';

const basic = (u: string, p: string) => `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;
const nowSec = () => Math.floor(Date.now() / 1000);

describe('owntracks parsing helpers', () => {
  it('parses Basic auth', () => {
    expect(parseBasicAuth(basic('joe-iphone', 's3cret:with:colons'))).toEqual({ username: 'joe-iphone', password: 's3cret:with:colons' });
    expect(parseBasicAuth('Bearer x')).toBeUndefined();
    expect(parseBasicAuth(undefined)).toBeUndefined();
  });
  it('validates location messages', () => {
    const t = nowSec();
    const ok = parseLocation({ _type: 'location', lat: 53.39, lon: -6.07, tst: t, acc: 12, alt: 40, batt: 81.6, vel: 9, cog: 270, t: 'p' }, t)!;
    expect(ok.lat).toBe(53.39);
    expect(ok.batt).toBe(82);
    expect(ok.velKmh).toBe(9);
    expect(ok.cog).toBe(270);
    expect(ok.trig).toBe('p');
    expect(parseLocation({ _type: 'location', lat: 95, lon: 0, tst: t }, t)).toBeUndefined();
    expect(parseLocation({ _type: 'location', lat: 53, lon: -6, tst: t - 30 * 86400 }, t)).toBeUndefined();
    expect(parseLocation({ _type: 'transition', lat: 53, lon: -6, tst: t }, t)).toBeUndefined();
    expect(parseLocation(null, t)).toBeUndefined();
  });
  it('derives usernames and tracker ids', () => {
    expect(slug('Seán Ó Briain')).toBe('sean-o-briain');
    expect(tidFor({ name: 'Joe Crew', callsign: 'A1' })).toBe('A1');
    expect(tidFor({ name: 'Joe Crew', callsign: null })).toBe('JC');
    expect(tidFor({ name: 'Cher', callsign: null })).toBe('CH');
  });
  it('builds a friends reply with topics and cards', () => {
    const out = friendsReply([{ userId: 7, deviceId: 3, name: 'Joe Crew', callsign: 'Alpha-1', lat: 53.4, lon: -6.1, tst: 1, at: 'x' }], () => 'joe-crew-iphone');
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ _type: 'location', topic: 'owntracks/joe-crew-iphone/3', tid: 'AL' });
    expect(out[1]).toMatchObject({ _type: 'card', name: 'Alpha-1 Joe Crew' });
  });
});

describe('/ot ingest and device management', () => {
  let t: Awaited<ReturnType<typeof testApp>>;
  let cookie: string;
  let device: { id: number; username: string };
  let secret: string;
  beforeAll(async () => {
    t = await testApp();
    cookie = await t.login('member');
  });
  afterAll(async () => t.close());
  const json = (r: { body: string }) => JSON.parse(r.body);
  const post = (auth: string | undefined, body: unknown) => t.app.inject({ method: 'POST', url: '/ot', headers: auth ? { authorization: auth } : {}, payload: body as any });

  it('creates a device with a one-time secret, config link and QR', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/devices', headers: { cookie, 'sec-fetch-site': 'same-origin' }, payload: { name: 'iPhone' } });
    expect(res.statusCode).toBe(200);
    const b = json(res);
    device = b.device;
    secret = b.secret;
    expect(device.username).toBe('joe-crew-iphone');
    expect(b.otrc.mode).toBe(3);
    expect(b.otrc.url).toBe('https://ops.test/ot');
    expect(b.configLink.startsWith('owntracks:///config?inline=')).toBe(true);
    const decoded = JSON.parse(Buffer.from(b.configLink.split('inline=')[1], 'base64').toString());
    expect(decoded.username).toBe('joe-crew-iphone');
    expect(decoded.password).toBe(secret);
    const qr = await t.app.inject({ method: 'GET', url: `/api/devices/${device.id}/qr.svg`, headers: { cookie } });
    expect(qr.statusCode).toBe(200);
    expect(qr.headers['content-type']).toMatch(/svg/);
    const otrc = await t.app.inject({ method: 'GET', url: `/api/devices/${device.id}/config.otrc`, headers: { cookie } });
    expect(otrc.statusCode).toBe(200);
    expect(json(otrc).password).toBe(secret);
    // another user cannot read it
    const other = await t.login('manager');
    expect((await t.app.inject({ method: 'GET', url: `/api/devices/${device.id}/qr.svg`, headers: { cookie: other } })).statusCode).toBe(403);
  });

  it('rejects bad credentials and acknowledges non-location messages', async () => {
    const bad = await post(basic(device.username, 'wrong'), { _type: 'location', lat: 1, lon: 1, tst: nowSec() });
    expect(bad.statusCode).toBe(401);
    expect(bad.headers['www-authenticate']).toMatch(/Basic/);
    expect((await post(undefined, {})).statusCode).toBe(401);
    const tr = await post(basic(device.username, secret), { _type: 'transition', event: 'enter', desc: 'home' });
    expect(tr.statusCode).toBe(200);
    expect(json(tr)).toEqual([]);
  });

  it('stores last-fix only when no incident is open', async () => {
    const res = await post(basic(device.username, secret), { _type: 'location', lat: 53.388, lon: -6.065, tst: nowSec(), acc: 8, alt: 12, batt: 70 });
    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual([]);
    expect(t.db.all('SELECT * FROM positions')).toHaveLength(0);
    const dev = t.devices.byId(device.id)!;
    expect(dev.last_lat).toBe(53.388);
    expect(t.tracking.latestFor(t.seed.member.id)?.alt).toBe(12);
  });

  it('persists track points during an incident, ignores duplicates and poor fixes, and returns friends', async () => {
    t.callout.callout({ text: 'test incident' });
    const ts = nowSec();
    const a = await post(basic(device.username, secret), { _type: 'location', lat: 53.389, lon: -6.066, tst: ts, acc: 10, vel: 18.52, cog: 90 });
    expect(a.statusCode).toBe(200);
    expect(t.tracking.latestFor(t.seed.member.id)?.sogKt).toBe(10); // 18.52 km/h
    await post(basic(device.username, secret), { _type: 'location', lat: 53.389, lon: -6.066, tst: ts, acc: 10 }); // duplicate tst
    await post(basic(device.username, secret), { _type: 'location', lat: 53.5, lon: -6.5, tst: ts + 5, acc: 350 }); // too inaccurate
    const rows = t.db.all<any>('SELECT * FROM positions ORDER BY tst');
    expect(rows).toHaveLength(1);
    expect(rows[0].incident_id).toBe(t.store.getMode().incident!.id);
    // a second responder's fix shows up as a friend for the first
    const mgrCookie = await t.login('manager');
    const d2 = json(await t.app.inject({ method: 'POST', url: '/api/devices', headers: { cookie: mgrCookie, 'sec-fetch-site': 'same-origin' }, payload: { name: 'Pixel' } }));
    await post(basic(d2.device.username, d2.secret), { _type: 'location', lat: 53.40, lon: -6.05, tst: ts + 10, acc: 5 });
    const friends = await post(basic(device.username, secret), { _type: 'location', lat: 53.389, lon: -6.067, tst: ts + 20, acc: 10 });
    const msgs = json(friends);
    expect(msgs.some((m: any) => m._type === 'location' && m.topic === `owntracks/${d2.device.username}/${d2.device.id}`)).toBe(true);
    expect(msgs.some((m: any) => m._type === 'card' && /Sam Manager/.test(m.name))).toBe(true);
    const latest = await t.app.inject({ method: 'GET', url: '/api/positions/latest', headers: { cookie } });
    expect(json(latest).fixes).toHaveLength(2);
    t.callout.standdown('test');
  });

  it('revoked devices are refused', async () => {
    const del = await t.app.inject({ method: 'DELETE', url: `/api/devices/${device.id}`, headers: { cookie, 'sec-fetch-site': 'same-origin' } });
    expect(del.statusCode).toBe(200);
    expect((await post(basic(device.username, secret), { _type: 'location', lat: 53, lon: -6, tst: nowSec() })).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'GET', url: `/api/devices/${device.id}/qr.svg`, headers: { cookie } })).statusCode).toBe(410);
  });
});
