import { afterEach, describe, expect, it } from 'vitest';
import { splitTerse, validPassword, validSsid, WifiManager, type Run } from '../src/device/wifi.js';
import { testApp } from './helpers/app.js';
import { fakeNm } from './helpers/fakeNm.js';

describe('nmcli terse output', () => {
  it('splits on unescaped colons only', () => {
    expect(splitTerse('*:Harbour\\:Guest:55:WPA2')).toEqual(['*', 'Harbour:Guest', '55', 'WPA2']);
    expect(splitTerse('a\\\\:b')).toEqual(['a\\', 'b']);
    expect(splitTerse(' ::0:--')).toEqual([' ', '', '0', '--']);
  });

  it('validates SSIDs and passwords', () => {
    expect(validSsid('Station')).toBe('Station');
    expect(() => validSsid('')).toThrow(/required/);
    expect(() => validSsid('x'.repeat(33))).toThrow(/32 bytes/);
    expect(() => validSsid('a\nb')).toThrow(/control/);
    expect(validPassword('')).toBeUndefined();
    expect(() => validPassword('short')).toThrow(/8 to 63/);
    expect(validPassword('a'.repeat(64).replace(/a/g, 'f'))).toHaveLength(64);
    expect(() => validPassword('pässwörd-long')).toThrow(/plain keyboard/);
  });
});

describe('WifiManager', () => {
  it('reports status, saved networks and Ethernet', async () => {
    const nm = fakeNm({ eth: true, active: 'Station', saved: [{ name: 'howth-cg-wifi-1', ssid: 'Station', prio: 10 }, { name: 'Home', ssid: 'Home', prio: 5 }] });
    const w = new WifiManager({ run: nm.run, startDelayMs: 0 });
    const st = await w.status();
    expect(st).toMatchObject({ available: true, iface: 'wlan0', state: 'connected', ssid: 'Station', signal: 70, ip4: '192.168.10.23', radio: true, ethernet: { iface: 'eth0', connected: true, ip4: '192.168.10.5' } });
    expect(st.saved.map((s) => [s.ssid, s.active])).toEqual([['Station', true], ['Home', false]]);
  });

  it('scans: drops hidden, keeps the strongest per name, unescapes names, marks saved', async () => {
    const nm = fakeNm({ active: 'Station', saved: [{ name: 'S', ssid: 'Station' }] });
    const w = new WifiManager({ run: nm.run, startDelayMs: 0 });
    const list = await w.scan();
    expect(list.map((n) => n.ssid)).toEqual(['Station', 'Harbour:Guest', 'NewOnly', 'Cafe']);
    expect(list[0]).toMatchObject({ inUse: true, saved: true, signal: 70, security: 'WPA2' });
    expect(list.find((n) => n.ssid === 'Cafe')!.security).toBe('');
  });

  it('joins a new network, then makes it the preferred one', async () => {
    const nm = fakeNm({ active: 'Station', saved: [{ name: 'howth-cg-wifi-1', ssid: 'Station', prio: 10 }] });
    const w = new WifiManager({ run: nm.run, startDelayMs: 0 });
    await w.scan();
    const a = await w.connect({ ssid: 'Harbour:Guest', password: 'right-password' });
    expect(a.state).toBe('connecting');
    await w.settled();
    const st = await w.status();
    expect(st.attempt).toMatchObject({ ssid: 'Harbour:Guest', state: 'connected' });
    expect(nm.active()).toBe('Harbour:Guest');
    const p = nm.profiles.find((x) => x.ssid === 'Harbour:Guest')!;
    expect(p.name).toBe('howth-cg-Harbour-Guest');
    expect(p.prio).toBe(11);
    const add = nm.calls.find((c) => c[1] === 'add')!;
    expect(add.slice(add.indexOf('wifi-sec.key-mgmt'), add.indexOf('wifi-sec.key-mgmt') + 2)).toEqual(['wifi-sec.key-mgmt', 'wpa-psk']);
  });

  it('uses SAE for a WPA3-only network', async () => {
    const nm = fakeNm({ active: 'Station', saved: [{ name: 'S', ssid: 'Station' }] });
    const w = new WifiManager({ run: nm.run, startDelayMs: 0 });
    await w.scan();
    await w.connect({ ssid: 'NewOnly', password: 'right-password' });
    await w.settled();
    const add = nm.calls.find((c) => c[1] === 'add')!;
    expect(add[add.indexOf('wifi-sec.key-mgmt') + 1]).toBe('sae');
  });

  it('wrong password: deletes the new profile and goes back to the previous network', async () => {
    const nm = fakeNm({ active: 'Station', saved: [{ name: 'howth-cg-wifi-1', ssid: 'Station' }] });
    const w = new WifiManager({ run: nm.run, startDelayMs: 0 });
    await w.scan();
    await w.connect({ ssid: 'Harbour:Guest', password: 'wrong-password' });
    await w.settled();
    const st = await w.status();
    expect(st.attempt).toMatchObject({ state: 'failed', restored: 'Station', error: 'Wrong password, or the network refused the Pi' });
    expect(nm.active()).toBe('Station');
    expect(nm.profiles.map((p) => p.ssid)).toEqual(['Station']);
  });

  it('a secured network needs a password; a second connect waits for the first', async () => {
    const nm = fakeNm({ active: 'Station', saved: [{ name: 'S', ssid: 'Station' }] });
    const w = new WifiManager({ run: nm.run, startDelayMs: 20 });
    await w.scan();
    await expect(w.connect({ ssid: 'Harbour:Guest' })).rejects.toThrow(/needs a password/);
    await w.connect({ ssid: 'Harbour:Guest', password: 'right-password' });
    await expect(w.connect({ ssid: 'Cafe' })).rejects.toThrow(/Already connecting/);
    await w.settled();
  });

  it('reconnects to a saved network without touching its password', async () => {
    const nm = fakeNm({ active: 'Station', saved: [{ name: 'S', ssid: 'Station', prio: 10 }, { name: 'Home', ssid: 'Home', prio: 5 }] });
    const w = new WifiManager({ run: nm.run, startDelayMs: 0 });
    const home = (await w.saved()).find((s) => s.ssid === 'Home')!;
    await w.activate(home.uuid);
    await w.settled();
    expect(nm.active()).toBe('Home');
    expect(nm.calls.some((c) => c[1] === 'modify' && c.includes('wifi-sec.psk'))).toBe(false);
    expect(nm.profiles.find((p) => p.ssid === 'Home')!.prio).toBe(11);
  });

  it('will not forget the only connection, but will with Ethernet up', async () => {
    const solo = fakeNm({ active: 'Station', saved: [{ name: 'S', ssid: 'Station' }] });
    const w1 = new WifiManager({ run: solo.run, startDelayMs: 0 });
    const s1 = (await w1.saved())[0];
    await expect(w1.forget(s1.uuid)).rejects.toThrow(/only connection/);

    const wired = fakeNm({ eth: true, active: 'Station', saved: [{ name: 'S', ssid: 'Station' }] });
    const w2 = new WifiManager({ run: wired.run, startDelayMs: 0 });
    await w2.forget((await w2.saved())[0].uuid);
    expect(wired.profiles).toHaveLength(0);
    await expect(w2.forget('nope')).rejects.toThrow(/No such saved network/);
  });

  it('reports NetworkManager down instead of throwing', async () => {
    const w = new WifiManager({ run: async () => { throw new Error('Could not create NMClient object'); }, startDelayMs: 0 });
    expect(await w.status()).toMatchObject({ available: false, reason: expect.stringMatching(/not answering/) });
  });
});

describe('/api/device/wifi', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  async function pi(password = 'pi-pass-1234', token = 'bridge-token') {
    const nm = fakeNm({ active: 'Station', saved: [{ name: 'howth-cg-wifi-1', ssid: 'Station' }] });
    const wifi = new WifiManager({ run: nm.run, startDelayMs: 0 });
    const t = await testAppWithWifi(wifi, (c) => {
      c.auth.open = true;
      c.callout.token = token;
      c.device = { wifi: true, password };
    });
    close = t.close;
    return { ...t, nm, wifi };
  }

  it('is not mounted unless device.wifi is on', async () => {
    const t = await testApp((c) => (c.auth.open = true));
    close = t.close;
    expect((await t.app.inject({ method: 'GET', url: '/api/device/wifi' })).statusCode).toBe(404);
  });

  it('needs the device password in open mode', async () => {
    const t = await pi();
    expect((await t.app.inject({ method: 'GET', url: '/api/device/wifi' })).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'GET', url: '/api/device/wifi', headers: { authorization: 'Bearer nope' } })).json().error).toMatch(/Wrong/);
    const ok = await t.app.inject({ method: 'GET', url: '/api/device/wifi', headers: { authorization: 'Bearer pi-pass-1234' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ available: true, ssid: 'Station' });
  });

  it('falls back to the bridge token, but never the template placeholder', async () => {
    const t = await pi('', 'bridge-token');
    expect((await t.app.inject({ method: 'GET', url: '/api/device/wifi', headers: { authorization: 'Bearer bridge-token' } })).statusCode).toBe(200);
    await close!();
    const t2 = await pi('', 'change-me-to-a-long-random-string');
    const r = await t2.app.inject({ method: 'GET', url: '/api/device/wifi', headers: { authorization: 'Bearer change-me-to-a-long-random-string' } });
    expect(r.statusCode).toBe(503);
    expect(r.json().error).toMatch(/DEVICE_PASSWORD/);
  });

  it('locks out after repeated wrong passwords', async () => {
    const t = await pi();
    for (let i = 0; i < 10; i++) await t.app.inject({ method: 'GET', url: '/api/device/wifi', headers: { authorization: 'Bearer wrong' } });
    const r = await t.app.inject({ method: 'GET', url: '/api/device/wifi', headers: { authorization: 'Bearer pi-pass-1234' } });
    expect(r.statusCode).toBe(429);
  });

  it('scans, connects (202), audits without the password, and refuses bad input', async () => {
    const t = await pi();
    const h = { authorization: 'Bearer pi-pass-1234' };
    const scan = await t.app.inject({ method: 'POST', url: '/api/device/wifi/scan', headers: h });
    expect(scan.json().networks[0].ssid).toBe('Station');
    const bad = await t.app.inject({ method: 'POST', url: '/api/device/wifi/connect', headers: h, payload: { ssid: 'Harbour:Guest', password: 'short' } });
    expect(bad.statusCode).toBe(400);
    const r = await t.app.inject({ method: 'POST', url: '/api/device/wifi/connect', headers: h, payload: { ssid: 'Harbour:Guest', password: 'right-password' } });
    expect(r.statusCode).toBe(202);
    await t.wifi.settled();
    expect(t.nm.active()).toBe('Harbour:Guest');
    const audit = t.db.all<{ action: string; target_id: string; detail: string }>("SELECT action, target_id, detail FROM audit_log WHERE action LIKE 'wifi.%'");
    expect(audit).toEqual([{ action: 'wifi.connect', target_id: 'Harbour:Guest', detail: '{"hidden":false}' }]);
    expect(JSON.stringify(audit)).not.toContain('right-password');
  });

  it('an admin session works when accounts are on; a manager does not', async () => {
    const nm = fakeNm({ active: 'Station', saved: [{ name: 'S', ssid: 'Station' }] });
    const t = await testAppWithWifi(new WifiManager({ run: nm.run, startDelayMs: 0 }), (c) => (c.device = { wifi: true, password: 'pi-pass-1234' }));
    close = t.close;
    expect((await t.app.inject({ method: 'GET', url: '/api/device/wifi', headers: { cookie: await t.login('admin') } })).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: '/api/device/wifi', headers: { cookie: await t.login('manager') } })).statusCode).toBe(401);
  });
});

/** testApp with a WifiManager injected (the helper builds the server itself). */
async function testAppWithWifi(wifi: WifiManager, overrides: Parameters<typeof testApp>[0]) {
  return testApp(overrides, { wifi });
}
