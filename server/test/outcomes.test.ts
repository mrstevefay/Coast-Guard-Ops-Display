import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testApp } from './helpers/app.js';

const lat0 = 53.37, lon0 = -6.06, dLat = 200 / 111_320, dLon = 200 / (111_320 * Math.cos((lat0 * Math.PI) / 180));
const SQ = { type: 'Polygon', coordinates: [[[lon0, lat0], [lon0 + dLon, lat0], [lon0 + dLon, lat0 + dLat], [lon0, lat0 + dLat], [lon0, lat0]]] };
const basic = (u: string, p: string) => `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;

describe('POD and outcomes', () => {
  let t: Awaited<ReturnType<typeof testApp>>;
  let manager: string, member: string;
  let incId: string, teamId: number, targetId: number;
  const json = (r: { body: string }) => JSON.parse(r.body);
  const call = (cookie: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown) => t.app.inject({ method, url, headers: { cookie, 'sec-fetch-site': 'same-origin' }, payload: payload as any });
  beforeAll(async () => {
    t = await testApp();
    manager = await t.login('manager');
    member = await t.login('member');
    incId = json(await call(manager, 'POST', '/api/incidents', { text: 'outcome test', lat: lat0, lon: lon0 })).incident.id;
    teamId = json(await call(manager, 'POST', `/api/incidents/${incId}/teams`, {})).team.id;
    await call(manager, 'PUT', `/api/teams/${teamId}/members`, { userIds: [t.seed.member.id], leaderUserId: t.seed.member.id });
    targetId = json(await call(manager, 'POST', `/api/incidents/${incId}/targets`, { name: 'S1 · Houses', kind: 'area', geometry: SQ, teamId, segmentId: 'S1' })).target.id;
  });
  afterAll(async () => t.close());

  it('keeps the segment a target came from', async () => {
    const tg = json(await call(manager, 'GET', '/api/search')).targets.find((x: { id: number }) => x.id === targetId);
    expect(tg.segmentId).toBe('S1');
  });

  it("suggests a POD from the team's track inside the area", async () => {
    const dev = json(await call(member, 'POST', '/api/devices', { name: 'iPhone' }));
    const now = Math.floor(Date.now() / 1000);
    // coverage counts only track after the target was set: set it twenty minutes ago
    t.db.run('UPDATE targets SET created_at = ? WHERE id = ?', new Date((now - 1200) * 1000).toISOString(), targetId);
    // five sweeps across the square, 40 m apart
    for (let k = 0; k < 5; k++) {
      const lat = lat0 + ((k * 40 + 20) / 200) * dLat;
      for (const [i, f] of [[0, 0.02], [1, 0.98]] as const) {
        await t.app.inject({ method: 'POST', url: '/ot', headers: { authorization: basic(dev.device.username, dev.secret) }, payload: { _type: 'location', lat, lon: lon0 + f * dLon, tst: now - 1000 + k * 120 + i * 100, acc: 5 } });
      }
    }
    const c = json(await call(member, 'GET', `/api/targets/${targetId}/coverage`)).coverage;
    expect(c.trackM).toBeGreaterThan(900);
    expect(c.areaM2).toBeGreaterThan(39_000);
    expect(c.pod).toBeGreaterThan(0.5);
    expect(c.pod).toBeLessThan(1);
  });

  it('records POD when crew finish a target, and refuses nonsense', async () => {
    await call(member, 'POST', `/api/targets/${targetId}/progress`, { status: 'in-progress' });
    const done = json(await call(member, 'POST', `/api/targets/${targetId}/progress`, { status: 'done', pod: 0.7 }));
    expect(done.target).toMatchObject({ status: 'done', pod: 0.7 });
    expect((await call(manager, 'PATCH', `/api/targets/${targetId}`, { pod: 1.4 })).statusCode).toBe(400);
    const events = json(await call(manager, 'GET', `/api/incidents/${incId}/replay`)).events.map((e: { text: string }) => e.text);
    expect(events.some((x: string) => /finished searching S1 · Houses \(POD 70 %\)/.test(x))).toBe(true);
  });

  it('records the outcome with the distance from the planning point, and corrects it', async () => {
    await call(manager, 'PUT', `/api/incidents/${incId}/subject`, { category: 'despondent', sex: 'Male', age: 45, terrain: 'Moorland / Upland' });
    const r = await call(manager, 'PUT', `/api/incidents/${incId}/outcome`, { outcome: 'found-well', lat: lat0 + 0.009, lon: lon0, locationType: 'Trees', foundBy: 'cg-team', foundAt: new Date().toISOString(), notes: 'In the gorse below the path' });
    expect(r.statusCode).toBe(200);
    expect(json(r).outcome.distanceKm).toBeCloseTo(1.0, 1);
    expect((await call(manager, 'PUT', `/api/incidents/${incId}/outcome`, { outcome: 'found-maybe' })).statusCode).toBe(400);
    expect((await call(manager, 'PUT', `/api/incidents/${incId}/outcome`, { outcome: 'found-well', lat: 53.3 })).statusCode).toBe(400);
    expect((await call(member, 'PUT', `/api/incidents/${incId}/outcome`, { outcome: 'not-found' })).statusCode).toBe(403);
    const html = (await call(manager, 'GET', `/api/incidents/${incId}/report.html`)).body;
    expect(html).toContain('Found well');
    expect(html).toContain('km from the planning point');
  });

  it('exports outcomes without names, positions or notes', async () => {
    const csv = (await call(manager, 'GET', '/api/outcomes.csv')).body;
    const [head, row] = csv.trim().split('\n');
    expect(head).toBe('month,category,sex,age_band,terrain,outcome,distance_km,found_location,found_by,hours_to_find,hours_open');
    expect(row).toMatch(/^\d{4}-\d{2},despondent,Male,40-49,Moorland \/ Upland,found-well,1(\.\d+)?,Trees,cg-team,/);
    expect(csv).not.toContain('gorse');
    expect(csv).not.toContain(String(lat0));
  });
});
