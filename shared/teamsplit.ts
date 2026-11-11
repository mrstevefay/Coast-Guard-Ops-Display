/**
 * Split waiting crew into search teams of about `size`.
 *
 * The number of teams is the fewest that keeps every team at or under `size`; people are dealt
 * round so team sizes differ by one at most (nine people in fours make three teams of three, not
 * 4 + 4 + 1). Crew with the search management qualification are dealt first, so each team gets
 * one as its leader while they last; a team without one is led by the first person dealt to it.
 */
export interface SplitPerson { userId: number; sm?: boolean }
export interface SplitTeam { leaderUserId: number; userIds: number[] }

export function splitTeams(people: SplitPerson[], size: number): SplitTeam[] {
  const seen = new Set<number>();
  const crew = people.filter((p) => !seen.has(p.userId) && seen.add(p.userId));
  if (!crew.length) return [];
  const n = Math.max(1, Math.round(size));
  const count = Math.ceil(crew.length / n);
  const order = [...crew.filter((p) => p.sm), ...crew.filter((p) => !p.sm)];
  const teams: SplitTeam[] = Array.from({ length: count }, () => ({ leaderUserId: 0, userIds: [] }));
  order.forEach((p, i) => {
    const t = teams[i % count];
    if (!t.userIds.length) t.leaderUserId = p.userId;
    t.userIds.push(p.userId);
  });
  return teams;
}
