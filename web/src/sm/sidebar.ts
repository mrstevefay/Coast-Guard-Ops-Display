import type { IncidentSubject, ResponderRow, Target, TargetStatus, Team, TeamStatus } from '../../../shared/types';
import { del, get, patch, post, put } from '../api';
import { esc, fmtAgeShort, fmtTime } from '../format';
import { toast } from '../m/ui';
import { closeModal, modal } from './modal';
import { cs } from './state';

export interface SidebarActions {
  locate: (lon: number, lat: number, zoom?: number) => void;
  fitTeam: (team: Team) => void;
  startDraw: (kind: 'point' | 'area' | 'line') => void;
  editTarget: (t: Target) => void;
  stopEditing: () => void;
  drawMode: () => string;
  /** Arm the map so the next click sets the planning point. */
  pickIpp: () => void;
}

const TEAM_STATUSES: TeamStatus[] = ['forming', 'tasked', 'searching', 'returned', 'stood-down'];
const TARGET_STATUSES: TargetStatus[] = ['planned', 'assigned', 'in-progress', 'done', 'cancelled'];
const badge = (s: string) => `<span class="badge-s ${({ responding: 'amber', 'on-scene': 'green', available: 'blue', searching: 'amber', tasked: 'blue', 'in-progress': 'amber', done: 'green' } as Record<string, string>)[s] ?? 'grey'}">${esc(s)}</span>`;

export function renderSidebar(root: HTMLElement, a: SidebarActions): void {
  const { search } = cs.s;
  const tabs = (['responders', 'teams', 'targets', 'subject'] as const)
    .map((t) => {
      const n = t === 'responders' ? ` (${search?.responders.filter((r) => r.status === 'responding' || r.status === 'on-scene').length ?? 0})` : t === 'teams' ? ` (${search?.teams.length ?? 0})` : t === 'targets' ? ` (${search?.targets.filter((x) => x.status !== 'cancelled').length ?? 0})` : '';
      return `<button class="tab ${cs.s.tab === t ? 'active' : ''}" data-tab="${t}">${t[0].toUpperCase() + t.slice(1)}${n}</button>`;
    })
    .join('');
  // The subject tab holds a form: never wipe it on a position tick, only when the data key changes.
  if (cs.s.tab === 'subject' && search?.incident) {
    const key = `${search.incident.id}:${search.incident.subjectUpdatedAt ?? ''}`;
    if (root.dataset.subjectKey === key && root.querySelector('#subject-form')) {
      root.querySelector('.tabs-sm')!.innerHTML = tabs;
      wireTabs(root);
      return;
    }
    root.dataset.subjectKey = key;
    root.innerHTML = `<div class="tabs-sm">${tabs}</div><div class="sb-body" id="subject-body"><p class="muted pad">Loading…</p></div>`;
    wireTabs(root);
    void subjectTab(root.querySelector('#subject-body')!, search.incident.id);
    return;
  }
  delete root.dataset.subjectKey;
  let body = '';
  if (!search?.incident) body = `<p class="muted pad">No open tasking. Start one from the top bar (New tasking); a pager callout opens one automatically.</p>`;
  else if (cs.s.tab === 'responders') body = ippBar(a) + respondersTab(search.responders, search.teams);
  else if (cs.s.tab === 'teams') body = teamsTab(search.teams, search.responders, search.targets);
  else if (cs.s.tab === 'targets') body = targetsTab(search.targets, search.teams, a.drawMode());
  else body = `<p class="muted pad">No open tasking.</p>`;
  root.innerHTML = `<div class="tabs-sm">${tabs}</div><div class="sb-body">${body}</div>`;
  wireTabs(root);
  wire(root, a);
}

function wireTabs(root: HTMLElement): void {
  root.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((b) => b.addEventListener('click', () => { cs.s.tab = b.dataset.tab as typeof cs.s.tab; cs.notify(); }));
}

function ippBar(_a: SidebarActions): string {
  const ipp = cs.s.search?.incident?.ipp;
  if (ipp) return `<div class="ipp-bar"><b>IPP</b> ${esc(ipp.label ?? '')} <span class="muted">${ipp.lat.toFixed(4)}, ${ipp.lon.toFixed(4)} · ${fmtTime(ipp.setAt)}</span><span class="right"></span><button class="mini" data-action="ipp-locate" title="Locate">◎</button><button class="mini" data-action="ipp-pick" title="Move">Move</button><button class="mini danger" data-action="ipp-clear" title="Clear">×</button></div>`;
  return `<div class="ipp-bar"><b>IPP</b> <span class="muted">No planning point yet.</span><span class="right"></span><button class="btn-sm ${cs.s.pickingIpp ? 'on' : ''}" data-action="ipp-pick">${cs.s.pickingIpp ? 'Click the map…' : 'Set planning point'}</button></div>`;
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
  const daylight = cs.s.state?.sun?.isDaylight ?? true;
  const cards = teams
    .map((t) => {
      const tts = targets.filter((x) => x.teamId === t.id && x.status !== 'cancelled');
      return `<div class="team" style="--team:${esc(t.colour)}" data-team="${t.id}">
        <div class="team-head">
          <span class="dot"></span>
          <input class="team-name" data-rename="${t.id}" value="${esc(t.name)}" />
          <select data-team-status="${t.id}">${TEAM_STATUSES.map((s) => `<option value="${s}" ${s === t.status ? 'selected' : ''}>${s}</option>`).join('')}</select>
          <button class="mini" data-fit-team="${t.id}" title="Locate team">◎</button>
          <button class="mini" data-team-settings="${t.id}" title="Team settings: sweep width, colour, name">⚙</button>
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
          <span>Sweep width <span class="width">${t.searchWidthM} m</span></span>
          <span class="muted small">${tts.length} target${tts.length === 1 ? '' : 's'}: ${tts.map((x) => esc(x.name)).join(', ') || '—'}</span>
        </div>
      </div>`;
    })
    .join('');
  const unassigned = responders.filter((r) => !teams.some((t) => t.members.some((m) => m.userId === r.userId)) && (r.status === 'responding' || r.status === 'on-scene'));
  return `${cards || '<p class="muted pad">No teams yet.</p>'}
    <button class="btn-sm primary wide" data-action="new-team">+ New team</button>
    <p class="muted small pad">New teams start at ${daylight ? '20 m (daylight)' : '10 m (after sunset)'} sweep width; change it per team with ⚙.</p>
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

// ---------------------------------------------------------------- team settings
function teamSettingsModal(t: Team): void {
  const root = modal(`<h3>${esc(t.name)} · settings</h3>
    <form id="tsf">
      <label>Name <input name="name" value="${esc(t.name)}" required maxlength="24" /></label>
      <label>Sweep width (metres each side of the track) <input name="searchWidthM" type="number" min="1" max="200" step="1" value="${t.searchWidthM}" required autofocus /></label>
      <p class="muted small">Guide: 20 m in daylight on open ground, 10 m after sunset or in cover. Drives the covered-area overlay.</p>
      <label>Colour <input name="colour" type="color" value="${esc(t.colour)}" /></label>
      <label>Status <select name="status">${TEAM_STATUSES.map((s) => `<option value="${s}" ${s === t.status ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
      <div class="modal-actions"><button type="button" class="btn-sm" id="cancel">Cancel</button><button type="submit" class="btn-sm primary">Save</button></div>
    </form>`);
  root.querySelector('#cancel')!.addEventListener('click', closeModal);
  root.querySelector<HTMLFormElement>('#tsf')!.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = Object.fromEntries(new FormData(ev.target as HTMLFormElement)) as Record<string, string>;
    try {
      await patch(`/api/teams/${t.id}`, { name: f.name, searchWidthM: Number(f.searchWidthM), colour: f.colour, status: f.status });
      closeModal();
      toast(`${f.name}: ${f.searchWidthM} m sweep`);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'failed', true);
    }
  });
}

// ---------------------------------------------------------------- subject (who we are looking for)
async function subjectTab(el: HTMLElement, incidentId: string): Promise<void> {
  let subject: IncidentSubject | null = null;
  try {
    subject = (await get<{ subject: IncidentSubject | null }>(`/api/incidents/${incidentId}/subject`)).subject;
  } catch (e) {
    el.innerHTML = `<p class="note error">${esc(e instanceof Error ? e.message : 'failed')}</p>`;
    return;
  }
  const s = subject ?? ({ incidentId, despondent: false, mentalHealth: false, selfHarmHistory: false, hasPhoto: false } as IncidentSubject);
  const v = (k: keyof IncidentSubject) => esc((s[k] as string | number | undefined) ?? '');
  const photoUrl = s.hasPhoto ? `/api/incidents/${incidentId}/subject/photo?t=${encodeURIComponent(s.photoUpdatedAt ?? '')}` : '';
  el.innerHTML = `<form class="subject-form" id="subject-form">
      <p class="muted small" style="margin:0">Who we are looking for. Shown to logged-in crew on their Status page; never on the TV. Keep it factual.</p>
      <div class="subject-photo">
        ${photoUrl ? `<img src="${photoUrl}" alt="Subject photo" />` : '<div class="ph">No photo</div>'}
        <div>
          <label>Recent photo <input type="file" id="subject-file" accept="image/*" /></label>
          <p class="muted small">Resized to 1280 px before upload.</p>
          ${s.hasPhoto ? '<button type="button" class="btn-sm danger" id="photo-del">Remove photo</button>' : ''}
        </div>
      </div>
      <label>Name <input name="name" value="${v('name')}" maxlength="120" /></label>
      <div class="row2">
        <label>Sex <select name="sex"><option value="">—</option>${['Male', 'Female', 'Other'].map((x) => `<option ${s.sex === x ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
        <label>Age <input name="age" type="number" min="0" max="120" value="${v('age')}" /></label>
        <span></span>
      </div>
      <label>Clothing / appearance <textarea name="clothing" rows="2" placeholder="Height, build, hair, what they were wearing">${v('clothing')}</textarea></label>
      <label>Other description <textarea name="description" rows="2" placeholder="Mobility, phone, vehicle, dog…">${v('description')}</textarea></label>
      <label>Significant locations <textarea name="locations" rows="2" placeholder="Home, where last seen, car parked, favourite spots">${v('locations')}</textarea></label>
      <label>Relevant history <textarea name="history" rows="2" placeholder="Previous incidents, medical conditions, routines">${v('history')}</textarea></label>
      <div class="flags">
        <label><input type="checkbox" name="despondent" ${s.despondent ? 'checked' : ''} /> Despondent</label>
        <label><input type="checkbox" name="mentalHealth" ${s.mentalHealth ? 'checked' : ''} /> Mental health concerns</label>
        <label><input type="checkbox" name="selfHarmHistory" id="sh" ${s.selfHarmHistory ? 'checked' : ''} /> Previous self-harm attempt(s)</label>
        <label id="sh-means" style="${s.selfHarmHistory ? '' : 'display:none'}">Previous means <input name="selfHarmMeans" value="${v('selfHarmMeans')}" maxlength="200" placeholder="e.g. overdose, water" /></label>
      </div>
      <div class="save-row"><button type="submit" class="btn-sm primary">Save details</button><span class="dirty" id="subject-dirty"></span>${s.updatedAt ? `<span class="muted small right">saved ${fmtTime(s.updatedAt)}</span>` : ''}</div>
    </form>`;
  const form = el.querySelector<HTMLFormElement>('#subject-form')!;
  const dirty = el.querySelector<HTMLElement>('#subject-dirty')!;
  form.addEventListener('input', () => (dirty.textContent = 'unsaved changes'));
  el.querySelector<HTMLInputElement>('#sh')!.addEventListener('change', (ev) => (el.querySelector<HTMLElement>('#sh-means')!.style.display = (ev.target as HTMLInputElement).checked ? '' : 'none'));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = new FormData(form);
    const body = {
      name: String(f.get('name') ?? ''), sex: String(f.get('sex') ?? ''), age: f.get('age') ? Number(f.get('age')) : null,
      clothing: String(f.get('clothing') ?? ''), description: String(f.get('description') ?? ''), locations: String(f.get('locations') ?? ''), history: String(f.get('history') ?? ''),
      despondent: f.get('despondent') === 'on', mentalHealth: f.get('mentalHealth') === 'on', selfHarmHistory: f.get('selfHarmHistory') === 'on', selfHarmMeans: String(f.get('selfHarmMeans') ?? ''),
    };
    try {
      await put(`/api/incidents/${incidentId}/subject`, body);
      dirty.textContent = '';
      toast('Subject details saved; crew phones updated');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'failed', true);
    }
  });
  el.querySelector<HTMLInputElement>('#subject-file')!.addEventListener('change', async (ev) => {
    const file = (ev.target as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      const blob = await resizeImage(file, 1280);
      const res = await fetch(`/api/incidents/${incidentId}/subject/photo`, { method: 'PUT', body: blob, headers: { 'content-type': blob.type }, credentials: 'same-origin' });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})) as { error?: string }).error ?? `HTTP ${res.status}`);
      toast('Photo uploaded');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'upload failed', true);
    }
  });
  el.querySelector('#photo-del')?.addEventListener('click', async () => {
    if (!confirm('Remove the photo?')) return;
    await del(`/api/incidents/${incidentId}/subject/photo`);
    toast('Photo removed');
  });
}

/** Downscale on the client so phone photos stay small (JPEG, longest side `max` px). */
async function resizeImage(file: File, max: number): Promise<Blob> {
  const bmp = await createImageBitmap(file).catch(() => undefined);
  if (!bmp) return file;
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d')!.drawImage(bmp, 0, 0, w, h);
  return new Promise((res) => canvas.toBlob((b) => res(b ?? file), 'image/jpeg', 0.85));
}

// ---------------------------------------------------------------- wiring
function wire(root: HTMLElement, a: SidebarActions): void {
  const search = cs.s.search;
  const incidentId = search?.incident?.id;
  const refresh = () => cs.notify();
  root.querySelectorAll<HTMLInputElement>('[data-sel]').forEach((c) => c.addEventListener('change', () => { const id = Number(c.dataset.sel); if (c.checked) cs.s.selected.add(id); else cs.s.selected.delete(id); refresh(); }));
  root.querySelector<HTMLButtonElement>('[data-action=clear-sel]')?.addEventListener('click', () => { cs.s.selected.clear(); refresh(); });
  root.querySelectorAll<HTMLButtonElement>('[data-locate]').forEach((b) => b.addEventListener('click', (ev) => { ev.preventDefault(); const [lon, lat] = b.dataset.locate!.split(',').map(Number); a.locate(lon, lat, 16); }));
  root.querySelector<HTMLButtonElement>('[data-action=ipp-pick]')?.addEventListener('click', () => a.pickIpp());
  root.querySelector<HTMLButtonElement>('[data-action=ipp-locate]')?.addEventListener('click', () => { const p = search?.incident?.ipp; if (p) a.locate(p.lon, p.lat, 16); });
  root.querySelector<HTMLButtonElement>('[data-action=ipp-clear]')?.addEventListener('click', async () => { if (incidentId && confirm('Clear the planning point?')) await patch(`/api/incidents/${incidentId}`, { ipp: null }); });
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
  root.querySelectorAll<HTMLButtonElement>('[data-team-settings]').forEach((b) => b.addEventListener('click', () => { const t = search!.teams.find((x) => x.id === Number(b.dataset.teamSettings)); if (t) teamSettingsModal(t); }));
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
