import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testApp } from './helpers/app.js';

describe('history, replay and end-of-mission report', () => {
  let t: Awaited<ReturnType<typeof testApp>>;
  let manager: string, member: string;
  const json = (r: { body: string }) => JSON.parse(r.body);
  let id: string;
  let teamId: number;
  beforeAll(async () => {
    t = await testApp();
    manager = await t.login('manager');
    member = await t.login('member');
    // some live conditions to snapshot
    t.store.merge({
      weather: { now: { time: new Date().toISOString(), wind: { speedKt: 14, gustKt: 20, dirDeg: 90, dirName: 'E', beaufort: 4 }, tempC: 11, precipMm: 0.2, symbol: 'LightRain', pressureHpa: 1027, visibility: { band: 'moderate', label: '2–5 NM', estimated: true } }, hourly: [] } as any,
      sun: { isDaylight: false, sunrise: '2026-11-05T07:31:00Z', sunset: '2026-11-05T16:46:00Z', civilDusk: '2026-11-05T17:24:00Z', daylightRemainingMin: 0 } as any,
      warnings: { active: [{ id: 'w1', level: 'yellow', headline: 'Small Craft', local: true }], fetchedAt: new Date().toISOString() } as any,
    });
  });
  afterAll(async () => t.close());

  it('runs a tasking with responders, a team and a track', async () => {
    id = json(await t.app.inject({ method: 'POST', url: '/api/incidents', headers: { cookie: manager }, payload: { text: 'Report test tasking', lat: 53.38, lon: -6.06 } })).incident.id;
    await t.app.inject({ method: 'PUT', url: `/api/incidents/${id}/response`, headers: { cookie: member }, payload: { status: 'responding', etaMin: 10 } });
    await t.app.inject({ method: 'PUT', url: `/api/incidents/${id}/response`, headers: { cookie: member }, payload: { status: 'on-scene' } });
    teamId = json(await t.app.inject({ method: 'POST', url: `/api/incidents/${id}/teams`, headers: { cookie: manager }, payload: {} })).team.id;
    await t.app.inject({ method: 'PUT', url: `/api/teams/${teamId}/members`, headers: { cookie: manager }, payload: { userIds: [t.seed.member.id], leaderUserId: t.seed.member.id } });
    await t.app.inject({ method: 'POST', url: `/api/incidents/${id}/targets`, headers: { cookie: manager }, payload: { kind: 'point', geometry: { type: 'Point', coordinates: [-6.065, 53.385] }, name: 'Pier', teamId } });
    await t.app.inject({ method: 'PATCH', url: `/api/incidents/${id}`, headers: { cookie: manager }, payload: { ipp: { lat: 53.384, lon: -6.064, label: 'Car park' } } });
    // a 1 km straight track east, one fix a minute, as the team
    const dev = t.devices.create(t.seed.member, 'phone').device;
    const base = Math.floor(Date.now() / 1000) - 600;
    for (let i = 0; i < 10; i++) {
      t.db.run('INSERT INTO positions (device_id, user_id, incident_id, team_id, tst, received_at, lat, lon) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', dev.id, t.seed.member.id, id, teamId, base + i * 60, new Date().toISOString(), 53.385, -6.07 + i * (0.001 / 0.6 / 1.0) * 0.6);
    }
    await t.app.inject({ method: 'PATCH', url: `/api/targets/${json(await t.app.inject({ method: 'GET', url: '/api/search', headers: { cookie: member } })).targets[0].id}`, headers: { cookie: manager }, payload: { status: 'done' } });
    await t.app.inject({ method: 'PUT', url: `/api/incidents/${id}/response`, headers: { cookie: member }, payload: { status: 'stood-down' } });
    const close = await t.app.inject({ method: 'POST', url: `/api/incidents/${id}/close`, headers: { cookie: manager } });
    expect(close.statusCode).toBe(200);
  });

  it('lists history with counts', async () => {
    const r = json(await t.app.inject({ method: 'GET', url: '/api/incidents', headers: { cookie: manager } }));
    const row = r.incidents.find((x: any) => x.id === id);
    expect(row).toMatchObject({ kind: 'tasking', responders: 1, teams: 1, targets: 1, fixes: 10, endReason: 'closed' });
    expect((await t.app.inject({ method: 'GET', url: '/api/incidents', headers: { cookie: member } })).statusCode).toBe(403);
  });

  it('replay bundle has fixes, memberships, events and start/end conditions', async () => {
    const r = await t.app.inject({ method: 'GET', url: `/api/incidents/${id}/replay`, headers: { cookie: manager } });
    expect(r.statusCode).toBe(200);
    const rep = json(r);
    expect(rep.fixes).toHaveLength(10);
    expect(rep.fixes[0].team).toBe(teamId);
    expect(rep.teams[0].memberships[0]).toMatchObject({ userId: t.seed.member.id, callsign: 'Alpha-0' });
    expect(rep.conditions.map((c: any) => c.phase)).toEqual(['start', 'end']);
    expect(rep.conditions[0].wind.speedKt).toBe(14);
    expect(rep.conditions[0].warnings[0]).toContain('Small Craft');
    expect(rep.conditions[0].sun.isDaylight).toBe(false);
    const kinds = rep.events.map((e: any) => e.kind);
    expect(kinds).toContain('response');
    expect(kinds).toContain('team');
    expect(kinds).toContain('target');
    expect(kinds).toContain('incident');
    expect(rep.events.some((e: any) => /set the planning point/.test(e.text))).toBe(true);
    expect(rep.incident.ipp.label).toBe('Car park');
  });

  it('report computes response times, time on scene, distance and swept area', async () => {
    const r = json(await t.app.inject({ method: 'GET', url: `/api/incidents/${id}/report`, headers: { cookie: manager } })).report;
    expect(r.totals).toMatchObject({ responders: 1, onScene: 1, teams: 1, targetsDone: 1, targetsTotal: 1, fixes: 10 });
    const p = r.responders[0];
    expect(p.name).toBe('Joe Crew');
    expect(p.respondedAt).toBeTruthy();
    expect(p.onSceneAt).toBeTruthy();
    expect(p.responseMin).toBeGreaterThanOrEqual(0);
    expect(p.onSceneMin).toBeGreaterThanOrEqual(0);
    expect(p.finalStatus).toBe('stood-down');
    expect(p.teamCallsign).toBe('Alpha-0');
    const team = r.teams[0];
    expect(team.trackKm).toBeGreaterThan(0.5);
    expect(team.trackKm).toBeLessThan(0.7);
    expect(team.searchingMin).toBe(9);
    expect(team.sweptKm2).toBeCloseTo((team.trackKm * 2 * team.searchWidthM) / 1000, 1);
    expect(r.totals.trackKm).toBe(team.trackKm);
    expect(r.durationMin).toBeGreaterThanOrEqual(0);
    expect(r.conditions).toHaveLength(2);
  });

  it('renders a printable HTML report with the map sketch and conditions', async () => {
    const r = await t.app.inject({ method: 'GET', url: `/api/incidents/${id}/report.html`, headers: { cookie: manager } });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/html');
    expect(r.headers['content-disposition']).toContain('inline');
    expect(r.body).toContain('Tasking report');
    expect(r.body).toContain('Joe Crew');
    expect(r.body).toContain('Alpha-0');
    expect(r.body).toContain('<svg class="map"');
    expect(r.body).toContain('14 kt E F4');
    expect(r.body).toContain('Small Craft');
    expect(r.body).toContain('Car park');
    expect(r.body).toContain('Area swept');
    const dl = await t.app.inject({ method: 'GET', url: `/api/incidents/${id}/report.html?download=1`, headers: { cookie: manager } });
    expect(dl.headers['content-disposition']).toMatch(/attachment; filename="tasking-report-/);
    expect((await t.app.inject({ method: 'GET', url: `/api/incidents/${id}/report.html`, headers: { cookie: member } })).statusCode).toBe(403);
    expect((await t.app.inject({ method: 'GET', url: `/api/incidents/nope/report.html`, headers: { cookie: manager } })).statusCode).toBe(404);
  });
});
