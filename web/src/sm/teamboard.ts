import type { ResponderRow, Team, UserPublic } from '../../../shared/types';
import { del, get, patch, post } from '../api';
import { esc, fmtAgeShort } from '../format';
import { toast } from '../m/ui';
import { cs } from './state';

/**
 * Organising crew into teams on the console's Teams tab.
 *
 * Three ways to do the same thing, so it works with a mouse and on a tablet:
 *  - drag a person onto a team, onto "+ New team", or back to Waiting;
 *  - tick people in Waiting, then tap "+ Add here" on a team;
 *  - tap a member for a menu: Make leader, Move to, Remove.
 * "+ Add crew" on a team finds anyone on the roster, responded or not. "Split" deals the waiting
 * crew into teams, search-management-qualified crew leading.
 */

const SM_TAG = '<span class="tag-sm" title="Search management qualified">SM</span>';
const badge = (s: string) => `<span class="badge-s ${({ responding: 'amber', 'on-scene': 'green', available: 'blue' } as Record<string, string>)[s] ?? 'grey'}">${esc(s)}</span>`;
const fail = (e: unknown) => toast(e instanceof Error ? e.message : 'failed', true);

let dragging = false;
let splitSize = 4;
/** True while a drag is under way: the sidebar must not be redrawn under it. */
export const boardBusy = () => dragging;

const waitingOf = (responders: ResponderRow[], teams: Team[]) => {
  const inTeam = new Set(teams.flatMap((t) => t.members.map((m) => m.userId)));
  return responders.filter((r) => r.status !== 'stood-down' && r.status !== 'unavailable' && !inTeam.has(r.userId));
};

// ------------------------------------------------------------------ html
export function waitingHtml(responders: ResponderRow[], teams: Team[]): string {
  const latest = cs.s.search!.latest;
  const active = waitingOf(responders, teams);
  for (const id of [...cs.s.selected]) if (!active.some((r) => r.userId === id)) cs.s.selected.delete(id); // no stale ticks
  if (!active.length) {
    return `<div class="k pad-k">Waiting for a team</div><div class="waiting empty" data-drop="waiting"><p class="muted small pad0 pad-x">${responders.some((r) => r.status === 'responding' || r.status === 'on-scene') ? 'Everyone responding is in a team.' : 'Nobody has responded yet. Use + Add crew on a team for anyone who is here without the app.'}</p></div>`;
  }
  const rows = active
    .map((r) => {
      const fix = latest[r.userId];
      const age = fix ? Date.now() / 1000 - fix.tst : undefined;
      return `<label class="row person ${cs.s.selected.has(r.userId) ? 'sel' : ''}" draggable="true" data-person="${r.userId}">
        <input type="checkbox" data-sel="${r.userId}" ${cs.s.selected.has(r.userId) ? 'checked' : ''} />
        <div class="grow">
          <div><b>${esc(r.name)}</b> ${r.sm ? SM_TAG : ''} ${badge(r.status)}${r.etaMin && r.status === 'responding' ? ` <span class="muted">ETA ${r.etaMin} m</span>` : ''}</div>
          <div class="muted small">${fix ? `fix ${fmtAgeShort(fix.tst)} ago${fix.alt !== undefined ? ` · ${Math.round(fix.alt)} m` : ''}${fix.batt !== undefined ? ` · 🔋${fix.batt}%` : ''}${age !== undefined && age > 120 ? ' <span class="amber">STALE</span>' : ''}` : '<span class="amber">no position</span>'}${r.note ? ` · ${esc(r.note)}` : ''}</div>
        </div>
        ${fix ? `<button class="mini" data-locate="${fix.lon},${fix.lat}" title="Locate">◎</button>` : ''}
      </label>`;
    })
    .join('');
  const n = cs.s.selected.size;
  const ready = active.filter((r) => r.status === 'responding' || r.status === 'on-scene').length;
  const pool = n || ready;
  const sizes = [2, 3, 4, 5, 6];
  return `<div class="k pad-k">Waiting for a team · ${active.length}</div>
    <div class="waiting" data-drop="waiting">${rows}</div>
    <div class="assign-bar">
      ${n ? `<span><b>${n}</b> selected: tap <b>+ Add here</b> on a team, or</span><button class="btn-sm primary" data-action="sel-new-team">+ New team</button><button class="mini" data-action="clear-sel">clear</button>` : '<span class="muted small">Drag people onto a team, or tick them first.</span>'}
    </div>
    ${pool >= 2 ? `<div class="split-bar"><span>Split ${n ? `the ${n} selected` : `${ready} responding`} into teams of</span>
      <select id="split-size">${sizes.map((s) => `<option ${s === splitSize ? 'selected' : ''}>${s}</option>`).join('')}</select>
      <button class="btn-sm" data-action="split" title="Search-management-qualified crew lead; adjust by dragging afterwards">Split</button></div>` : ''}`;
}

/** The top of a team card's body: "+ Add here" when people are ticked, the members, and "+ Add crew". */
export function teamMembersHtml(t: Team): string {
  const latest = cs.s.search!.latest;
  const n = cs.s.selected.size;
  const chips = t.members
    .map((m) => {
      const fix = latest[m.userId];
      return `<span class="chip ${m.position === 0 ? 'leader' : ''}" role="button" tabindex="0" draggable="true" data-person="${m.userId}" data-member="${t.id}:${m.userId}" title="${esc(m.name)}: tap for Make leader, Move, Remove; or drag to another team">
        ${m.position === 0 ? '<span class="star" title="Team leader">★</span>' : ''}<b>${esc(m.callsign)}</b> ${esc(m.name.split(' ')[0])}${m.sm ? ` ${SM_TAG}` : ''}${fix ? ` <small class="${Date.now() / 1000 - fix.tst > 120 ? 'amber' : 'muted'}">${fmtAgeShort(fix.tst)}</small>` : ' <small class="amber">—</small>'}</span>`;
    })
    .join('');
  return `${n ? `<button class="btn-sm primary wide add-here" data-add-here="${t.id}">+ Add ${n} here</button>` : ''}
    <div class="members">${chips || '<span class="muted small">No members yet: drag people here.</span>'}<button class="chip add" data-add-crew="${t.id}" title="Add anyone on the roster, responded or not">+ Add crew</button></div>
    ${t.members.length && !t.members.some((m) => m.position === 0) ? '<div class="amber small no-leader">No leader: tap a member and choose Make leader.</div>' : ''}`;
}

// ------------------------------------------------------------------ actions
/** Add people to a team (moving them out of any other). The server only adds, so quick changes never overwrite each other. */
async function addToTeam(teamId: number, ids: number[]): Promise<void> {
  if (!ids.length) return;
  await post(`/api/teams/${teamId}/members`, { userIds: ids });
  for (const id of ids) cs.s.selected.delete(id);
}

async function addToNewTeam(ids: number[]): Promise<void> {
  const incidentId = cs.s.search?.incident?.id;
  if (!incidentId || !ids.length) return;
  const r = await post<{ team: Team }>(`/api/incidents/${incidentId}/teams`, {});
  await addToTeam(r.team.id, ids);
}

const removeFromTeam = (teamId: number, userId: number) => del(`/api/teams/${teamId}/members/${userId}`).then(() => undefined);

const act = (fn: () => Promise<void>) => fn().then(() => cs.notify()).catch(fail);

// ------------------------------------------------------------------ popovers
let pop: HTMLElement | undefined;
function closePop(): void {
  pop?.remove();
  pop = undefined;
  document.removeEventListener('pointerdown', outside, true);
  document.removeEventListener('keydown', onKey, true);
}
const outside = (ev: Event) => { if (pop && !pop.contains(ev.target as Node)) closePop(); };
const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') closePop(); };

function openPop(anchor: HTMLElement, html: string, cls = ''): HTMLElement {
  closePop();
  const el = document.createElement('div');
  el.className = `team-pop ${cls}`;
  el.innerHTML = html;
  document.body.append(el);
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth, h = el.offsetHeight;
  el.style.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`;
  el.style.top = `${r.bottom + h + 8 > innerHeight ? Math.max(8, r.top - h - 4) : r.bottom + 4}px`;
  pop = el;
  setTimeout(() => {
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', onKey, true);
  });
  return el;
}

function personMenu(anchor: HTMLElement, teamId: number, userId: number, locate: (lon: number, lat: number, zoom?: number) => void): void {
  const search = cs.s.search!;
  const team = search.teams.find((t) => t.id === teamId);
  const m = team?.members.find((x) => x.userId === userId);
  if (!team || !m) return;
  const fix = search.latest[userId];
  const others = search.teams.filter((t) => t.id !== teamId && t.status !== 'stood-down');
  const el = openPop(anchor, `<div class="pop-head"><b>${esc(m.name)}</b> <span class="muted">${esc(m.callsign)}</span>${m.sm ? ` ${SM_TAG}` : ''}</div>
    ${m.position === 0 ? '<div class="pop-note">★ Team leader</div>' : '<button data-pm="leader">★ Make leader</button>'}
    <div class="pop-k">Move to</div>
    ${others.map((t) => `<button data-pm="move:${t.id}"><span class="dot" style="background:${esc(t.colour)}"></span>${esc(t.name)} <span class="muted small">${t.members.length}</span></button>`).join('')}
    <button data-pm="move:new">+ New team</button>
    <div class="pop-sep"></div>
    ${fix ? '<button data-pm="locate">◎ Show on the map</button>' : ''}
    <button data-pm="remove" class="danger">Remove from ${esc(team.name)}</button>`);
  el.querySelectorAll<HTMLButtonElement>('[data-pm]').forEach((b) => b.addEventListener('click', () => {
    const what = b.dataset.pm!;
    closePop();
    if (what === 'locate') return locate(fix.lon, fix.lat, 16);
    if (what === 'leader') return void act(() => patch(`/api/teams/${teamId}`, { leaderUserId: userId }));
    if (what === 'remove') return void act(() => removeFromTeam(teamId, userId));
    if (what === 'move:new') return void act(() => addToNewTeam([userId]));
    return void act(() => addToTeam(Number(what.split(':')[1]), [userId]));
  }));
}

let roster: { at: number; users: UserPublic[] } | undefined;
async function loadRoster(): Promise<UserPublic[]> {
  if (!roster || Date.now() - roster.at > 60_000) roster = { at: Date.now(), users: (await get<{ users: UserPublic[] }>('/api/users')).users.filter((u) => u.active && !u.pending) };
  return roster.users;
}

/** Find anyone on the roster and put them in this team: for crew at the station without the app. */
function addCrewPop(anchor: HTMLElement, teamId: number): void {
  const el = openPop(anchor, `<input class="pop-search" placeholder="Name or callsign" autocomplete="off" /><div class="pop-list"><p class="muted small">Loading…</p></div><div class="pop-note">Anyone added counts as responding.</div>`, 'wide');
  const input = el.querySelector<HTMLInputElement>('.pop-search')!;
  const list = el.querySelector<HTMLElement>('.pop-list')!;
  const added = new Set<number>();
  let users: UserPublic[] = [];
  const draw = () => {
    const search = cs.s.search!;
    const q = input.value.trim().toLowerCase();
    const where = (id: number) => {
      const t = search.teams.find((x) => x.members.some((m) => m.userId === id));
      if (t) return { text: `in ${t.name}`, rank: 2 };
      const r = search.responders.find((x) => x.userId === id);
      return r && r.status !== 'stood-down' && r.status !== 'unavailable' ? { text: 'waiting', rank: 0 } : { text: 'not responded', rank: 1 };
    };
    const rows = users
      .filter((u) => !added.has(u.id) && !search.teams.find((t) => t.id === teamId)?.members.some((m) => m.userId === u.id))
      .filter((u) => !q || u.name.toLowerCase().includes(q) || (u.callsign ?? '').toLowerCase().includes(q))
      .map((u) => ({ u, w: where(u.id) }))
      .sort((a, b) => a.w.rank - b.w.rank || a.u.name.localeCompare(b.u.name));
    list.innerHTML = rows.length
      ? rows.slice(0, 40).map(({ u, w }) => `<button data-add-user="${u.id}"><b>${esc(u.name)}</b>${u.callsign ? ` <span class="muted">${esc(u.callsign)}</span>` : ''}${u.smQualified ? ` ${SM_TAG}` : ''}<span class="muted small where">${w.text}</span></button>`).join('')
      : `<p class="muted small">${users.length ? 'Nobody matches.' : 'Loading…'}</p>`;
    list.querySelectorAll<HTMLButtonElement>('[data-add-user]').forEach((b) => b.addEventListener('click', () => {
      const id = Number(b.dataset.addUser);
      added.add(id);
      draw();
      act(() => addToTeam(teamId, [id]));
      input.focus();
    }));
  };
  input.addEventListener('input', draw);
  input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') list.querySelector<HTMLButtonElement>('[data-add-user]')?.click(); });
  input.focus();
  loadRoster().then((u) => { users = u; draw(); }).catch(fail);
}

// ------------------------------------------------------------------ wiring
export function wireTeamBoard(root: HTMLElement, locate: (lon: number, lat: number, zoom?: number) => void): void {
  const incidentId = cs.s.search?.incident?.id;
  if (!incidentId) return;
  root.querySelector('[data-action=sel-new-team]')?.addEventListener('click', () => act(() => addToNewTeam([...cs.s.selected])));
  root.querySelectorAll<HTMLButtonElement>('[data-add-here]').forEach((b) => b.addEventListener('click', () => act(() => addToTeam(Number(b.dataset.addHere), [...cs.s.selected]))));
  root.querySelector<HTMLSelectElement>('#split-size')?.addEventListener('change', (ev) => { splitSize = Number((ev.target as HTMLSelectElement).value); });
  root.querySelector('[data-action=split]')?.addEventListener('click', () => act(async () => {
    const r = await post<{ teams: Team[] }>(`/api/incidents/${incidentId}/teams/split`, { size: splitSize, userIds: [...cs.s.selected] });
    cs.s.selected.clear();
    toast(`${r.teams.length} team${r.teams.length === 1 ? '' : 's'}: ${r.teams.map((t) => t.name).join(', ')}`);
  }));
  root.querySelectorAll<HTMLElement>('[data-add-crew]').forEach((b) => b.addEventListener('click', () => addCrewPop(b, Number(b.dataset.addCrew))));
  root.querySelectorAll<HTMLElement>('[data-member]').forEach((c) => {
    const open = () => { const [teamId, userId] = c.dataset.member!.split(':').map(Number); personMenu(c, teamId, userId, locate); };
    c.addEventListener('click', open);
    c.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); } });
  });

  // drag and drop
  let ids: number[] = [];
  let from: number | undefined;
  root.querySelectorAll<HTMLElement>('[data-person]').forEach((p) => {
    p.addEventListener('dragstart', (ev) => {
      const id = Number(p.dataset.person);
      from = p.dataset.member ? Number(p.dataset.member.split(':')[0]) : undefined;
      // dragging one of several ticked people takes them all
      ids = from === undefined && cs.s.selected.has(id) ? [...cs.s.selected] : [id];
      ev.dataTransfer?.setData('text/plain', ids.join(','));
      if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move';
      closePop();
      dragging = true;
      root.classList.add('dragging-crew');
      p.classList.add('dragged');
    });
    p.addEventListener('dragend', () => {
      dragging = false;
      root.classList.remove('dragging-crew');
      root.querySelectorAll('.drop-over').forEach((x) => x.classList.remove('drop-over'));
      cs.notify();
    });
  });
  root.querySelectorAll<HTMLElement>('[data-drop]').forEach((z) => {
    const kind = z.dataset.drop!;
    const takes = () => dragging && (kind === 'waiting' ? from !== undefined : kind !== `team:${from}`);
    z.addEventListener('dragover', (ev) => { if (!takes()) return; ev.preventDefault(); z.classList.add('drop-over'); });
    z.addEventListener('dragleave', (ev) => { if (!z.contains(ev.relatedTarget as Node)) z.classList.remove('drop-over'); });
    z.addEventListener('drop', (ev) => {
      if (!takes()) return;
      ev.preventDefault();
      const moving = ids, src = from;
      if (kind === 'waiting') return void act(() => removeFromTeam(src!, moving[0]));
      if (kind === 'new') return void act(() => addToNewTeam(moving));
      return void act(() => addToTeam(Number(kind.split(':')[1]), moving));
    });
  });
}
