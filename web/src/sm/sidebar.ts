import type { ResponderRow, Target, TargetStatus, Team, TeamStatus } from '../../../shared/types';
import { del, patch, post, put } from '../api';
import { esc, fmtAgeShort } from '../format';
import { cs } from './state';

export interface SidebarActions {
  locate: (lon: number, lat: number, zoom?: number) => void;
  fitTeam: (team: Team) => void;
  startDraw: (kind: 'point' | 'area' | 'line') => void;
  editTarget: (t: Target) => void;
  stopEditing: () => void;
  drawMode: () => string;
}

const TEAM_STATUSES: TeamStatus[] = ['forming', 'tasked', 'searching', 'returned', 'stood-down'];
const TARGET_STATUSES: TargetStatus[] = ['planned', 'assigned', 'in-progress', 'done', 'cancelled'];
const badge = (s: string) => `<span class="badge-s ${({ responding: 'amber', 'on-scene': 'green', available: 'blue', searching: 'amber', tasked: 'blue', 'in-progress': 'amber', done: 'green' } as Record<string, string>)[s] ?? 'grey'}">${esc(s)}</span>`;

export function renderSidebar(root: HTMLElement, a: SidebarActions): void {
  const { search } = cs.s;
  const tabs = (['responders', 'teams', 'targets'] as const).map((t) => `<button class="tab ${cs.s.tab === t ? 'active' : ''}" data-tab="${t}">${t[0].toUpperCase() + t.slice(1)}${t === 'responders' ? ` (${search?.responders.filter((r) => r.status === 'responding' || r.status === 'on-scene').length ?? 0})` : t === 'teams' ? ` (${search?.teams.length ?? 0})` : ` (${search?.targets.filter((x) => x.status !== 'cancelled').length ?? 0})`}</button>`).join('');
  let body = '';
  if (!search?.incident) body = `<p class="muted pad">No open incident. Start one from the top bar when the pager goes.</p>`;
  else if (cs.s.tab === 'responders') body = respondersTab(search.responders, search.teams);
  else if (cs.s.tab === 'teams') body = teamsTab(search.teams, search.responders, search.targets);
  else body = targetsTab(search.targets, search.teams, a.drawMode());
  root.innerHTML = `<div class="tabs-sm">${tabs}</div><div class="sb-body">${body}</div>`;
  wire(root, a);
}

function respondersTab(responders: ResponderRow[], teams: Team[]): string {
  const latest = cs.s.search!.latest;
  const active = responders.filter((r) => r.status !== 'stood-down');
  if (!active.length) return `<p class="muted pad">Nobody has responded yet.</p>`;
  const rows = active
    .map((r) => {
      const fix = latest[r.userId];
      const age = fix ? Date.now() / 1000 - fix.tst : undefined;
      const team = teams.find((t) => t.id === r.teamId);
      return `<label class="row ${cs.s.selected.has(r.userId) ? 'sel' : ''}">
        <input type="checkbox" data-sel="${r.userId}" ${cs.s.selected.has(r.userId) ? 'checked' : ''} />
        <div class="grow">
          <div><b>${esc(r.name)}</b> ${r.teamCallsign ? `<span class="cs" style="--team:${esc(team?.colour ?? '#9fb3c8')}">${esc(r.teamCallsign)}</span>` : ''} ${badge(r.status)}${r.etaMin && r.status === 'responding' ? ` <span class="muted">ETA ${r.etaMin} m</span>` : ''}</div>
          <div class="muted small">${fix ? `fix ${fmtAgeShort(fix.tst)} ago${fix.alt !== undefined ? ` · ${Math.round(fix.alt)} m` : ''}${fix.batt !== undefined ? ` · 🔋${fix.batt}%` : ''}${age !== undefined && age > 120 ? ' <span class="amber">STALE</span>' : ''}` : '<span class="amber">no position</span>'}${r.note ? ` · ${esc(r.note)}` : ''}</div>
        </div>
        ${fix ? `<button class="mini" data-locate="${fix.lon},${fix.lat}" title="Locate">◎</button>` : ''}
      </label>`;
    })
    .join('');
  const n = cs.s.selected.size;
  return `${rows}
    <div class="assign-bar ${n ? '' : 'disabled'}">
      <span>${n} selected</span>
      <select id="assign-team"><option value="">Assign to…</option>${teams.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}<option value="new">+ New team</option></select>
      <button class="mini" data-action="clear-sel">clear</button>
    </div>`;
}

function teamsTab(teams: Team[], responders: ResponderRow[], targets: Target[]): string {
  const latest = cs.s.search!.latest;
  const cards = teams
    .map((t) => {
      const tts = targets.filter((x) => x.teamId === t.id && x.status !== 'cancelled');
      return `<div class="team" style="--team:${esc(t.colour)}" data-team="${t.id}">
        <div class="team-head">
          <span class="dot"></span>
          <input class="team-name" data-rename="${t.id}" value="${esc(t.name)}" />
          <select data-team-status="${t.id}">${TEAM_STATUSES.map((s) => `<option value="${s}" ${s === t.status ? 'selected' : ''}>${s}</option>`).join('')}</select>
          <button class="mini" data-fit-team="${t.id}" title="Locate team">◎</button>
          <button class="mini danger" data-del-team="${t.id}" title="Delete team">×</button>
        </div>
        <div class="members">${t.members.map((m) => {
          const fix = latest[m.userId];
          return `<span class="chip ${m.position === 0 ? 'leader' : ''}" title="${esc(m.name)}">
            <button class="star" data-leader="${t.id}:${m.userId}" title="Make leader">${m.position === 0 ? '★' : '☆'}</button>
            <b>${esc(m.callsign)}</b> ${esc(m.name.split(' ')[0])}${fix ? ` <small class="${Date.now() / 1000 - fix.tst > 120 ? 'amber' : 'muted'}">${fmtAgeShort(fix.tst)}</small>` : ' <small class="amber">—</small>'}
            <button class="x" data-remove="${t.id}:${m.userId}" title="Remove">×</button></span>`;
        }).join('') || '<span class="muted small">No members: select responders and assign.</span>'}</div>
        <div class="team-foot">
          <label>Width <input type="range" min="5" max="60" step="5" value="${t.searchWidthM}" data-width="${t.id}" /> <span>${t.searchWidthM} m</span></label>
          <span class="muted small">${tts.length} target${tts.length === 1 ? '' : 's'}: ${tts.map((x) => esc(x.name)).join(', ') || '—'}</span>
        </div>
      </div>`;
    })
    .join('');
  const unassigned = responders.filter((r) => !teams.some((t) => t.members.some((m) => m.userId === r.userId)) && (r.status === 'responding' || r.status === 'on-scene'));
  return `${cards || '<p class="muted pad">No teams yet.</p>'}
    <button class="btn-sm primary wide" data-action="new-team">+ New team</button>
    ${unassigned.length ? `<p class="muted small pad">Not in a team: ${unassigned.map((r) => esc(r.name)).join(', ')}</p>` : ''}`;
}

function targetsTab(targets: Target[], teams: Team[], drawMode: string): string {
  const live = targets.filter((t) => t.status !== 'cancelled');
  const groups = [...teams.map((t) => ({ label: t.name, colour: t.colour, items: live.filter((x) => x.teamId === t.id) })), { label: 'Unassigned', colour: '#9fb3c8', items: live.filter((x) => !x.teamId) }].filter((g) => g.items.length);
  const editing = cs.s.editingTargetId;
  return `<div class="draw-bar">
      ${(['point', 'area', 'line'] as const).map((k) => `<button class="btn-sm ${drawMode === k ? 'on' : ''}" data-draw="${k}">${k === 'point' ? '● Point' : k === 'area' ? '▱ Area' : '⟋ Line'}</button>`).join('')}
      ${drawMode !== 'static' ? `<button class="btn-sm danger" data-action="cancel-draw">Esc</button>` : ''}
    </div>
    ${groups.length ? groups.map((g) => `<div class="tgroup" style="--team:${esc(g.colour)}"><div class="tgroup-head"><span class="dot"></span>${esc(g.label)}</div>${g.items.map((t) => targetRow(t, teams, editing === t.id)).join('')}</div>`).join('') : '<p class="muted pad">Draw a point, area or line on the map to create a target.</p>'}`;
}

function targetRow(t: Target, teams: Team[], editing: boolean): string {
  return `<div class="target ${editing ? 'editing' : ''}" data-target="${t.id}">
    <div class="target-head">
      <b data-zoom-target="${t.id}">${esc(t.name)}</b> <span class="muted small">${t.kind} · P${t.priority}</span> ${badge(t.status)}
      <button class="mini danger" data-del-target="${t.id}" title="Delete">×</button>
    </div>
    ${t.notes ? `<div class="muted small">${esc(t.notes)}</div>` : ''}
    <div class="target-ctl">
      <select data-target-status="${t.id}">${TARGET_STATUSES.map((s) => `<option value="${s}" ${s === t.status ? 'selected' : ''}>${s}</option>`).join('')}</select>
      <select data-target-team="${t.id}"><option value="">no team</option>${teams.map((x) => `<option value="${x.id}" ${x.id === t.teamId ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
      ${editing ? `<button class="btn-sm on" data-action="stop-edit">Done</button>` : `<button class="btn-sm" data-edit-target="${t.id}">Edit shape</button>`}
    </div>
  </div>`;
}

function wire(root: HTMLElement, a: SidebarActions): void {
  const search = cs.s.search;
  const incidentId = search?.incident?.id;
  const refresh = () => cs.notify();
  root.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((b) => b.addEventListener('click', () => { cs.s.tab = b.dataset.tab as typeof cs.s.tab; refresh(); }));
  root.querySelectorAll<HTMLInputElement>('[data-sel]').forEach((c) => c.addEventListener('change', () => { const id = Number(c.dataset.sel); if (c.checked) cs.s.selected.add(id); else cs.s.selected.delete(id); refresh(); }));
  root.querySelector<HTMLButtonElement>('[data-action=clear-sel]')?.addEventListener('click', () => { cs.s.selected.clear(); refresh(); });
  root.querySelectorAll<HTMLButtonElement>('[data-locate]').forEach((b) => b.addEventListener('click', (ev) => { ev.preventDefault(); const [lon, lat] = b.dataset.locate!.split(',').map(Number); a.locate(lon, lat, 16); }));
  root.querySelector<HTMLSelectElement>('#assign-team')?.addEventListener('change', async (ev) => {
    const sel = ev.target as HTMLSelectElement;
    if (!sel.value || !incidentId) return;
    const ids = [...cs.s.selected];
    let teamId = Number(sel.value);
    if (sel.value === 'new') {
      const r = await post<{ team: Team }>(`/api/incidents/${incidentId}/teams`, {});
      teamId = r.team.id;
    }
    const team = search!.teams.find((t) => t.id === teamId);
    const existing = team?.members.map((m) => m.userId) ?? [];
    await put(`/api/teams/${teamId}/members`, { userIds: [...new Set([...existing, ...ids])], leaderUserId: team?.leaderUserId ?? (existing.length ? undefined : ids[0]) });
    cs.s.selected.clear();
    cs.s.tab = 'teams';
  });
  root.querySelector<HTMLButtonElement>('[data-action=new-team]')?.addEventListener('click', async () => { if (incidentId) await post(`/api/incidents/${incidentId}/teams`, {}); });
  root.querySelectorAll<HTMLInputElement>('[data-rename]').forEach((i) => i.addEventListener('change', async () => { await patch(`/api/teams/${i.dataset.rename}`, { name: i.value }); }));
  root.querySelectorAll<HTMLSelectElement>('[data-team-status]').forEach((s) => s.addEventListener('change', async () => { await patch(`/api/teams/${s.dataset.teamStatus}`, { status: s.value }); }));
  root.querySelectorAll<HTMLInputElement>('[data-width]').forEach((i) => {
    i.addEventListener('input', () => (i.nextElementSibling!.textContent = `${i.value} m`));
    i.addEventListener('change', async () => { await patch(`/api/teams/${i.dataset.width}`, { searchWidthM: Number(i.value) }); });
  });
  root.querySelectorAll<HTMLButtonElement>('[data-fit-team]').forEach((b) => b.addEventListener('click', () => { const t = search!.teams.find((x) => x.id === Number(b.dataset.fitTeam)); if (t) a.fitTeam(t); }));
  root.querySelectorAll<HTMLButtonElement>('[data-del-team]').forEach((b) => b.addEventListener('click', async () => { if (confirm('Delete this team? Members are released, targets unassigned.')) await del(`/api/teams/${b.dataset.delTeam}`); }));
  root.querySelectorAll<HTMLButtonElement>('[data-leader]').forEach((b) => b.addEventListener('click', async () => { const [teamId, userId] = b.dataset.leader!.split(':').map(Number); await patch(`/api/teams/${teamId}`, { leaderUserId: userId }); }));
  root.querySelectorAll<HTMLButtonElement>('[data-remove]').forEach((b) => b.addEventListener('click', async () => {
    const [teamId, userId] = b.dataset.remove!.split(':').map(Number);
    const team = search!.teams.find((t) => t.id === teamId)!;
    const rest = team.members.filter((m) => m.userId !== userId).map((m) => m.userId);
    await put(`/api/teams/${teamId}/members`, { userIds: rest, leaderUserId: team.leaderUserId === userId ? null : team.leaderUserId });
  }));
  root.querySelectorAll<HTMLButtonElement>('[data-draw]').forEach((b) => b.addEventListener('click', () => a.startDraw(b.dataset.draw as 'point' | 'area' | 'line')));
  root.querySelector<HTMLButtonElement>('[data-action=cancel-draw]')?.addEventListener('click', () => a.stopEditing());
  root.querySelector<HTMLButtonElement>('[data-action=stop-edit]')?.addEventListener('click', () => a.stopEditing());
  root.querySelectorAll<HTMLElement>('[data-zoom-target]').forEach((b) => b.addEventListener('click', () => {
    const t = search!.targets.find((x) => x.id === Number(b.dataset.zoomTarget));
    if (!t) return;
    const pts = t.geometry.type === 'Point' ? [t.geometry.coordinates] : t.geometry.type === 'LineString' ? t.geometry.coordinates : t.geometry.coordinates[0];
    const lon = pts.reduce((s, c) => s + c[0], 0) / pts.length, lat = pts.reduce((s, c) => s + c[1], 0) / pts.length;
    a.locate(lon, lat, t.geometry.type === 'Point' ? 16 : 15);
  }));
  root.querySelectorAll<HTMLSelectElement>('[data-target-status]').forEach((s) => s.addEventListener('change', async () => { await patch(`/api/targets/${s.dataset.targetStatus}`, { status: s.value }); }));
  root.querySelectorAll<HTMLSelectElement>('[data-target-team]').forEach((s) => s.addEventListener('change', async () => { await patch(`/api/targets/${s.dataset.targetTeam}`, { teamId: s.value ? Number(s.value) : null }); }));
  root.querySelectorAll<HTMLButtonElement>('[data-del-target]').forEach((b) => b.addEventListener('click', async () => { if (confirm('Delete this target?')) await del(`/api/targets/${b.dataset.delTarget}`); }));
  root.querySelectorAll<HTMLButtonElement>('[data-edit-target]').forEach((b) => b.addEventListener('click', () => { const t = search!.targets.find((x) => x.id === Number(b.dataset.editTarget)); if (t) a.editTarget(t); }));
}
