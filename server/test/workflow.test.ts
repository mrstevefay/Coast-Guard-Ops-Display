import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PlaceCollector, normalise, placeKind, searchPlaces } from '../src/terrain/places.js';
import { testApp } from './helpers/app.js';

const AREA = { type: 'Polygon', coordinates: [[[-6.07, 53.37], [-6.06, 53.37], [-6.06, 53.38], [-6.07, 53.38], [-6.07, 53.37]]] };

describe('fewer clicks: server behaviour', () => {
  let t: Awaited<ReturnType<typeof testApp>>;
  let manager: string;
  const json = (r: { body: string }) => JSON.parse(r.body);
  beforeAll(async () => {
    t = await testApp();
    manager = await t.login('manager');
  });
  afterAll(async () => t.close());
  const inject = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) => t.app.inject({ method, url, headers: { cookie: manager }, payload: payload as any });

  it('a position given with a new tasking becomes its last known position', async () => {
    const inc = json(await inject('POST', '/api/incidents', { text: 'workflow test', lat: 53.3735, lon: -6.0608, label: 'Summit car park' })).incident;
    expect(inc.ipp).toMatchObject({ lat: 53.3735, lon: -6.0608, label: 'Summit car park' });
    expect(inc.points.map((p: { kind: string }) => p.kind)).toEqual(['lkp']);
  });

  it('team status follows its targets', async () => {
    const id = json(await inject('GET', '/api/search')).incident.id;
    const team = json(await inject('POST', `/api/incidents/${id}/teams`, {})).team;
    expect(team.status).toBe('forming');
    const status = async () => json(await inject('GET', '/api/search')).teams.find((x: { id: number }) => x.id === team.id).status;
    const target = json(await inject('POST', `/api/incidents/${id}/targets`, { name: 'S1', kind: 'area', geometry: AREA, teamId: team.id })).target;
    expect(target.status).toBe('assigned');
    expect(await status()).toBe('tasked');
    await inject('PATCH', `/api/targets/${target.id}`, { status: 'in-progress' });
    expect(await status()).toBe('searching');
    await inject('PATCH', `/api/targets/${target.id}`, { status: 'done' });
    expect(await status()).toBe('returned');
    // a second target puts the team back to tasked; moving it away returns it
    const second = json(await inject('POST', `/api/incidents/${id}/targets`, { name: 'S2', kind: 'area', geometry: AREA, teamId: team.id })).target;
    expect(await status()).toBe('tasked');
    await inject('PATCH', `/api/targets/${second.id}`, { teamId: null });
    expect(await status()).toBe('returned');
    // stood down is the manager's call and is never overridden
    await inject('PATCH', `/api/teams/${team.id}`, { status: 'stood-down' });
    await inject('PATCH', `/api/targets/${second.id}`, { teamId: team.id });
    expect(await status()).toBe('stood-down');
  });

  it('place search answers without a built index', async () => {
    const r = json(await inject('GET', '/api/places?q=howth'));
    expect(r.places).toEqual([]);
    expect(r.indexed).toBe(false);
  });
});

describe('place index', () => {
  it('names the kinds a search manager would type', () => {
    expect(placeKind({ name: 'Summit', amenity: 'parking' })).toBe('car park');
    expect(placeKind({ name: 'Ben of Howth', natural: 'peak' })).toBe('peak');
    expect(placeKind({ name: 'Cliff Path', highway: 'path' })).toBe('path');
    expect(placeKind({ name: 'Thormanby Road', highway: 'residential' })).toBe('road');
    expect(placeKind({ highway: 'residential' })).toBeUndefined();
    expect(placeKind({ name: 'A shop', shop: 'convenience' })).toBeUndefined();
  });

  it('keeps one entry per name nearby, ranks proper places first, then the nearest', () => {
    const c = new PlaceCollector();
    c.add({ name: 'Summit Car Park', amenity: 'parking' }, 53.3736, -6.0609);
    c.add({ name: 'Summit Car Park', amenity: 'parking' }, 53.3737, -6.0610); // duplicate within 400 m
    c.addLine({ name: 'Summit Road', highway: 'tertiary' }, [{ lat: 53.37, lon: -6.06 }, { lat: 53.372, lon: -6.062 }, { lat: 53.374, lon: -6.064 }]);
    c.add({ name: 'The Summit Inn', amenity: 'pub' }, 53.374, -6.059);
    c.add({ name: 'Baile Átha Cliath', place: 'city' }, 53.35, -6.26);
    c.add({ name: 'Summit', place: 'locality' }, 52.0, -9.0); // far away
    expect(c.places).toHaveLength(5);
    const near = { lat: 53.38, lon: -6.07 };
    expect(searchPlaces(c.places, 'summit', near).map((p) => p[0])).toEqual(['Summit', 'Summit Car Park', 'Summit Road', 'The Summit Inn']);
    expect(searchPlaces(c.places, 'summit car', near).map((p) => p[0])).toEqual(['Summit Car Park']);
    expect(searchPlaces(c.places, 'baile atha', near)[0][0]).toBe('Baile Átha Cliath');
    expect(searchPlaces(c.places, 's', near)).toEqual([]);
    expect(normalise("St. Mary's  Abbey")).toBe('st marys abbey');
  });
});
