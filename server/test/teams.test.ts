import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { splitTeams } from '../../shared/teamsplit.js';
import { testApp } from './helpers/app.js';

describe('splitting crew into teams', () => {
  const crew = (n: number, sm: number[] = []) => Array.from({ length: n }, (_, i) => ({ userId: i + 1, sm: sm.includes(i + 1) }));

  it('makes the fewest teams that fit, sizes within one of each other', () => {
    expect(splitTeams(crew(8), 4).map((t) => t.userIds.length)).toEqual([4, 4]);
    expect(splitTeams(crew(9), 4).map((t) => t.userIds.length)).toEqual([3, 3, 3]);
    expect(splitTeams(crew(5), 4).map((t) => t.userIds.length)).toEqual([3, 2]);
    expect(splitTeams(crew(1), 4)).toEqual([{ leaderUserId: 1, userIds: [1] }]);
    expect(splitTeams([], 4)).toEqual([]);
  });

  it('gives each team a search-management-qualified leader while they last', () => {
    const teams = splitTeams(crew(9, [4, 8]), 3);
    expect(teams.map((t) => t.leaderUserId)).toEqual([4, 8, 1]);
    expect(teams.flatMap((t) => t.userIds).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    // more qualified crew than teams: the extra ones are ordinary members, spread out
    const spare = splitTeams(crew(6, [1, 2, 3]), 3);
    expect(spare.map((t) => t.leaderUserId)).toEqual([1, 2]);
    expect(spare[0].userIds).toContain(3);
  });

  it('ignores a person listed twice', () => {
    expect(splitTeams([{ userId: 1 }, { userId: 1 }, { userId: 2 }], 4)).toEqual([{ leaderUserId: 1, userIds: [1, 2] }]);
  });
});

describe('organising teams', () => {
  let t: Awaited<ReturnType<typeof testApp>>;
  let manager: string, admin: string, incId: string;
  const ids: number[] = [];
  const json = (r: { body: string }) => JSON.parse(r.body);
  const call = (cookie: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown) => t.app.inject({ method, url, headers: { cookie, 'sec-fetch-site': 'same-origin' }, payload: payload as object });
  const snap = async () => json(await call(manager, 'GET', '/api/search'));
  beforeAll(async () => {
    t = await testApp();
    manager = await t.login('manager');
    admin = await t.login('admin');
    for (let i = 0; i < 6; i++) ids.push(t.users.create({ email: `c${i}@ops.test`, name: `Crew ${i}`, role: 'member', password: 'crew-pass-1234', mustChange: false }).user.id);
    incId = json(await call(manager, 'POST', '/api/incidents', { text: 'teams test', lat: 53.3735, lon: -6.0608 })).incident.id;
  });
  afterAll(async () => t.close());

  it('the search management qualification is set by admins and shows on the board', async () => {
    expect((await call(manager, 'PATCH', `/api/users/${ids[0]}`, { smQualified: true })).statusCode).toBe(403);
    const res = await call(admin, 'PATCH', `/api/users/${ids[0]}`, { smQualified: true });
    expect(json(res).user.smQualified).toBe(true);
    // an unrelated edit leaves it alone
    expect(json(await call(admin, 'PATCH', `/api/users/${ids[0]}`, { callsign: 'C0' })).user.smQualified).toBe(true);
    const alpha = json(await call(manager, 'POST', `/api/incidents/${incId}/teams`, {})).team;
    await call(manager, 'PUT', `/api/teams/${alpha.id}/members`, { userIds: [ids[0], ids[1]], leaderUserId: ids[0] });
    const s = await snap();
    expect(s.teams[0].members.map((m: { sm?: boolean }) => Boolean(m.sm))).toEqual([true, false]);
    expect(s.responders.find((r: { userId: number }) => r.userId === ids[0]).sm).toBe(true);
  });

  it('moving a leader to another team leaves the old team without one, in one call', async () => {
    const bravo = json(await call(manager, 'POST', `/api/incidents/${incId}/teams`, {})).team;
    const moved = await call(manager, 'PUT', `/api/teams/${bravo.id}/members`, { userIds: [ids[0]] });
    expect(moved.statusCode).toBe(200);
    const s = await snap();
    const [alpha, b] = s.teams;
    expect(alpha.members.map((m: { userId: number }) => m.userId)).toEqual([ids[1]]);
    expect(alpha.leaderUserId).toBeUndefined();
    expect(b.members.map((m: { userId: number }) => m.userId)).toEqual([ids[0]]);
  });

  it('adds crew who never responded, but not a deactivated account', async () => {
    const s0 = await snap();
    const bravo = s0.teams[1];
    expect(s0.responders.some((r: { userId: number }) => r.userId === ids[2])).toBe(false);
    expect((await call(manager, 'PUT', `/api/teams/${bravo.id}/members`, { userIds: [ids[0], ids[2]] })).statusCode).toBe(200);
    expect((await snap()).responders.find((r: { userId: number }) => r.userId === ids[2]).status).toBe('responding');
    await call(admin, 'PATCH', `/api/users/${ids[5]}`, { active: false });
    const res = await call(manager, 'PUT', `/api/teams/${bravo.id}/members`, { userIds: [ids[0], ids[2], ids[5]] });
    expect(res.statusCode).toBe(400);
    expect(json(res).error).toMatch(/active account/);
  });

  it('adds and removes one at a time without overwriting; an empty team is led by a qualified person', async () => {
    const delta = json(await call(manager, 'POST', `/api/incidents/${incId}/teams`, {})).team;
    await call(admin, 'PATCH', `/api/users/${ids[3]}`, { smQualified: true });
    // two adds built from the same stale picture: both people end up in the team
    const [a, b] = await Promise.all([
      call(manager, 'POST', `/api/teams/${delta.id}/members`, { userIds: [ids[1]] }),
      call(manager, 'POST', `/api/teams/${delta.id}/members`, { userIds: [ids[3]] }),
    ]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    let team = (await snap()).teams.find((x: { id: number }) => x.id === delta.id);
    expect(team.members.map((m: { userId: number }) => m.userId).sort()).toEqual([ids[1], ids[3]].sort());
    expect(team.leaderUserId).toBe(ids[1]); // first in leads; a later arrival does not take over
    const rm = await t.app.inject({ method: 'DELETE', url: `/api/teams/${delta.id}/members/${ids[1]}`, headers: { cookie: manager, 'sec-fetch-site': 'same-origin' } });
    expect(rm.statusCode).toBe(200);
    team = (await snap()).teams.find((x: { id: number }) => x.id === delta.id);
    expect(team.members.map((m: { userId: number }) => m.userId)).toEqual([ids[3]]);
    expect(team.leaderUserId).toBeUndefined();
    // emptied, then two added together: the qualified one leads
    await t.app.inject({ method: 'DELETE', url: `/api/teams/${delta.id}/members/${ids[3]}`, headers: { cookie: manager, 'sec-fetch-site': 'same-origin' } });
    const both = json(await call(manager, 'POST', `/api/teams/${delta.id}/members`, { userIds: [ids[1], ids[3]] })).team;
    expect(both.leaderUserId).toBe(ids[3]);
    // leave Delta with one member, so the split below has a single empty team to fill
    await t.app.inject({ method: 'DELETE', url: `/api/teams/${delta.id}/members/${ids[3]}`, headers: { cookie: manager, 'sec-fetch-site': 'same-origin' } });
    await call(admin, 'PATCH', `/api/users/${ids[3]}`, { smQualified: false });
  });

  it('splits the chosen crew into teams, qualified crew leading, filling an empty team first', async () => {
    await call(admin, 'PATCH', `/api/users/${ids[4]}`, { smQualified: true });
    const alpha = (await snap()).teams[0]; // emptied by the moves above
    expect(alpha.members).toEqual([]);
    const empty = json(await call(manager, 'POST', `/api/incidents/${incId}/teams`, {})).team; // a second empty team
    const res = await call(manager, 'POST', `/api/incidents/${incId}/teams/split`, { size: 2, userIds: [ids[3], ids[4], t.seed.member.id] });
    expect(res.statusCode).toBe(200);
    const teams = json(res).teams;
    expect(teams.map((x: { members: unknown[] }) => x.members.length)).toEqual([2, 1]);
    expect(teams.map((x: { id: number }) => x.id)).toEqual([alpha.id, empty.id]); // no new team made
    expect(teams[0].leaderUserId).toBe(ids[4]);
    // nobody left to split; people already in a team are not moved
    const again = await call(manager, 'POST', `/api/incidents/${incId}/teams/split`, { size: 2 });
    expect(again.statusCode).toBe(400);
    expect((await call(manager, 'POST', `/api/incidents/${incId}/teams/split`, { size: 0, userIds: [ids[1]] })).statusCode).toBe(400);
    expect((await call(await t.login('member'), 'POST', `/api/incidents/${incId}/teams/split`, { size: 2 })).statusCode).toBe(403);
  });
});
