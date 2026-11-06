import { LPB, LPB_GROUPS, LPB_TERRAINS, buildPlan, outcomeShares, profileBySlug, suggestProfile, terrainsWithData, type Basis, type PlanRing, type SearchPlan, type Tactic } from '../../../shared/lpb/index';
import { PLANNING_POINT_KINDS, POINT_KIND_LABEL, POINT_KIND_SHORT, type IncidentSubject, type SearchAreaResult, type PlanningPointKind, type ResponderRow, type Target, type TargetStatus, type Team, type TeamStatus } from '../../../shared/types';
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
  /** Arm the map so the next click places a point of this kind (or moves `pointId`). Calling again cancels. */
  pickPoint: (kind: PlanningPointKind, pointId?: number) => void;
  /** Zoom the map to the lost-person-behaviour rings. */
  fitRings: () => void;
}

const TEAM_STATUSES: TeamStatus[] = ['forming', 'tasked', 'searching', 'returned', 'stood-down'];
const TARGET_STATUSES: TargetStatus[] = ['planned', 'assigned', 'in-progress', 'done', 'cancelled'];
const badge = (s: string) => `<span class="badge-s ${({ responding: 'amber', 'on-scene': 'green', available: 'blue', searching: 'amber', tasked: 'blue', 'in-progress': 'amber', done: 'green' } as Record<string, string>)[s] ?? 'grey'}">${esc(s)}</span>`;

export function renderSidebar(root: HTMLElement, a: SidebarActions): void {
  const { search } = cs.s;
  const tabs = (['responders', 'teams', 'targets', 'subject', 'behaviour'] as const)
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
  // The behaviour tab has its own terrain selector: keep it across position ticks too.
  if (cs.s.tab === 'behaviour' && search?.incident) {
    const sa = cs.s.searchArea;
    const key = `${cs.s.subjectKey ?? ''}:${cs.s.subject?.category ?? ''}:${cs.s.subject?.terrain ?? ''}:${search.incident.ipp ? 1 : 0}:${significantPoints().map((p) => p.id).join(',')}:${sa?.key ?? ''}:${sa?.loading ? 'l' : sa?.area ? 'a' : sa?.error ? 'e' : ''}`;
    if (root.dataset.behaviourKey === key && root.querySelector('#behaviour-body')) {
      root.querySelector('.tabs-sm')!.innerHTML = tabs;
      wireTabs(root);
      return;
    }
    root.dataset.behaviourKey = key;
    root.innerHTML = `<div class="tabs-sm">${tabs}</div><div class="sb-body" id="behaviour-body"></div>`;
    wireTabs(root);
    behaviourTab(root.querySelector('#behaviour-body')!, cs.s.subject, Boolean(search.incident.ipp), a);
    return;
  }
  delete root.dataset.behaviourKey;
  let body = '';
  if (!search?.incident) body = `<p class="muted pad">No open tasking. Start one from the top bar (New tasking); a pager callout opens one automatically.</p>`;
  else if (cs.s.tab === 'responders') body = pointsBar() + respondersTab(search.responders, search.teams);
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

const significantPoints = () => (cs.s.search?.incident?.points ?? []).filter((p) => p.kind === 'significant');

function pointsBar(): string {
  const pts = cs.s.search?.incident?.points ?? [];
  const pick = cs.s.picking;
  const has = (k: PlanningPointKind) => pts.some((p) => p.kind === k);
  const addable = PLANNING_POINT_KINDS.filter((k) => !((k === 'lkp' || k === 'pls') && has(k)));
  const rows = pts
    .map((p) => `<div class="pt-row k-${p.kind}"><span class="pt-kind" title="${esc(POINT_KIND_LABEL[p.kind])}">${esc(POINT_KIND_SHORT[p.kind])}</span>
      <span class="grow"><b>${esc(p.label ?? POINT_KIND_LABEL[p.kind])}</b> <span class="muted small">${p.lat.toFixed(4)}, ${p.lon.toFixed(4)} · ${fmtTime(p.setAt)}</span>${p.note ? `<span class="muted small pt-note">${esc(p.note)}</span>` : ''}</span>
      <button class="mini" data-pt-locate="${p.id}" title="Locate">◎</button><button class="mini ${pick?.pointId === p.id ? 'on' : ''}" data-pt-move="${p.id}" title="Move">Move</button><button class="mini danger" data-pt-del="${p.id}" title="Remove">×</button></div>`)
    .join('');
  return `<div class="points-bar">
      <div class="pt-head"><b>Points</b><span class="right"></span>
        ${has('lkp') ? '' : `<button class="btn-sm ${pick?.kind === 'lkp' && !pick.pointId ? 'on' : ''}" data-pt-add="lkp">${pick?.kind === 'lkp' && !pick.pointId ? 'Click the map…' : 'Set LKP'}</button>`}
        <select id="pt-add" title="Add a point"><option value="">+ Add point…</option>${addable.map((k) => `<option value="${k}">${esc(POINT_KIND_LABEL[k])}</option>`).join('')}</select>
      </div>
      ${rows || '<p class="muted small pad0">Start with the last known position. Then add the place last seen, home, vehicle and any place significant to them: they shape the plan and the search areas.</p>'}
      ${pick ? `<p class="small amber pad0">Click the map to ${pick.pointId ? 'move' : 'place'}: ${esc(POINT_KIND_LABEL[pick.kind])} (Esc to cancel)</p>` : ''}
    </div>`;
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
  const s = subject ?? ({ incidentId, despondent: false, mentalHealth: false, selfHarmHistory: false, suicideThreatened: false, depression: false, significantPlaceKnown: false, hasPhoto: false } as IncidentSubject);
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
        <div id="desp-flags" class="desp-flags" style="${s.despondent || s.category === 'despondent' ? '' : 'display:none'}">
          <p class="muted small">Despondent factors (change the fatality odds for men, UK study 2011):</p>
          <label><input type="checkbox" name="suicideThreatened" ${s.suicideThreatened ? 'checked' : ''} /> Suicide threatened (explicit threat)</label>
          <label><input type="checkbox" name="depression" ${s.depression ? 'checked' : ''} /> Depression diagnosed or suspected</label>
          <label><input type="checkbox" name="significantPlaceKnown" ${s.significantPlaceKnown ? 'checked' : ''} /> A significant place is known (beauty spot, memories, regular walk: name it under locations)</label>
        </div>
      </div>
      <div class="row2 lpb-pick">
        <label>Behaviour category <select name="category" id="subject-category"><option value="">—</option>${LPB_GROUPS.map((g) => `<optgroup label="${esc(g.label)}">${g.slugs.map((slug) => { const p = profileBySlug(slug)!; return `<option value="${slug}" ${s.category === slug ? 'selected' : ''}>${esc(p.name)} (n=${p.n})</option>`; }).join('')}</optgroup>`).join('')}</select></label>
        <label>Terrain <select name="terrain"><option value="">All / unknown</option>${LPB_TERRAINS.map((t) => `<option ${s.terrain === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>
      </div>
      <p class="muted small lpb-hint" id="lpb-hint">${lpbHint(s)}</p>
      <div class="save-row"><button type="submit" class="btn-sm primary">Save details</button><span class="dirty" id="subject-dirty"></span>${s.updatedAt ? `<span class="muted small right">saved ${fmtTime(s.updatedAt)}</span>` : ''}</div>
    </form>`;
  const form = el.querySelector<HTMLFormElement>('#subject-form')!;
  const dirty = el.querySelector<HTMLElement>('#subject-dirty')!;
  form.addEventListener('input', () => {
    dirty.textContent = 'unsaved changes';
    const f = new FormData(form);
    el.querySelector('#lpb-hint')!.innerHTML = lpbHint({ category: String(f.get('category') ?? ''), age: f.get('age') ? Number(f.get('age')) : undefined, despondent: f.get('despondent') === 'on', mentalHealth: f.get('mentalHealth') === 'on' });
    el.querySelector<HTMLElement>('#desp-flags')!.style.display = f.get('despondent') === 'on' || f.get('category') === 'despondent' ? '' : 'none';
  });
  el.querySelector<HTMLInputElement>('#sh')!.addEventListener('change', (ev) => (el.querySelector<HTMLElement>('#sh-means')!.style.display = (ev.target as HTMLInputElement).checked ? '' : 'none'));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = new FormData(form);
    const body = {
      name: String(f.get('name') ?? ''), sex: String(f.get('sex') ?? ''), age: f.get('age') ? Number(f.get('age')) : null,
      clothing: String(f.get('clothing') ?? ''), description: String(f.get('description') ?? ''), locations: String(f.get('locations') ?? ''), history: String(f.get('history') ?? ''),
      despondent: f.get('despondent') === 'on', mentalHealth: f.get('mentalHealth') === 'on', selfHarmHistory: f.get('selfHarmHistory') === 'on', selfHarmMeans: String(f.get('selfHarmMeans') ?? ''),
      category: String(f.get('category') ?? ''), terrain: String(f.get('terrain') ?? ''),
      suicideThreatened: f.get('suicideThreatened') === 'on', depression: f.get('depression') === 'on', significantPlaceKnown: f.get('significantPlaceKnown') === 'on',
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

/** Hint under the category picker: what is chosen, or what the flags and age suggest. */
function lpbHint(s: { category?: string; age?: number; despondent?: boolean; mentalHealth?: boolean }): string {
  const chosen = profileBySlug(s.category);
  if (chosen) return `${esc(chosen.name)}: ${esc(chosen.definition)} Statistics on the Behaviour tab; distance rings on the map.`;
  const sug = profileBySlug(suggestProfile(s));
  return sug ? `Suggested from the details above: <b>${esc(sug.name)}</b>. Pick a category to get find-location statistics and distance rings around the planning point.` : 'Pick a category to get find-location statistics and distance rings around the planning point (MISPER-UK data).';
}

// ---------------------------------------------------------------- behaviour: the plan card
function bars<K extends string>(rows: { key: K; n?: number; pct: number }[], cls = ''): string {
  if (!rows.length) return '<p class="muted small">No data.</p>';
  const max = rows[0].pct || 1;
  return `<div class="lpb-bars ${cls}">${rows.map((r) => `<div class="lpb-bar"><span class="lk" title="${esc(r.key)}">${esc(r.key)}</span><span class="track"><span class="fill" style="width:${(r.pct / max) * 100}%"></span></span><span class="lv">${r.pct} %${r.n !== undefined ? `<small> ${r.n}</small>` : ''}</span></div>`).join('')}</div>`;
}
const srcTag = (b: Basis) => `<span class="src ${b.source === 'MISPER-UK' ? 'live' : b.source === 'UKMPBS_2011' ? 'study' : 'isrid'}" title="${esc(b.source)} · ${esc(b.ref)} · match: ${esc(b.level)}">${esc(b.tag)}</span>`;
const km = (v: number) => (v < 1 ? `${Math.round(v * 1000)} m` : `${v} km`);
const ringText = (r: PlanRing) => `<b>${r.pct} %</b> within ${km(r.km)}${r.interpolated ? '<sup title="Interpolated between the source\'s 10 % steps">~</sup>' : ''}`;

function planContext(): { daylight?: boolean; tempC?: number; warnings?: string[] } {
  const st = cs.s.state;
  if (!st) return {};
  return { daylight: st.sun?.isDaylight, tempC: st.observed?.tempC ?? st.weather?.now?.tempC, warnings: (st.warnings?.active ?? []).map((w) => `${w.level.toUpperCase()} ${w.headline}`) };
}

function behaviourTab(el: HTMLElement, subject: IncidentSubject | null | undefined, hasIpp: boolean, a: SidebarActions): void {
  const attribution = `<p class="muted small lpb-src">${esc(LPB.source.attribution)} <a href="${esc(LPB.source.url)}" target="_blank" rel="noopener">misper.uk</a>. UK land-search data: use alongside tide, drift and local knowledge, not instead of them.</p>`;
  if (subject === undefined) {
    el.innerHTML = `<p class="muted pad">Loading subject details…</p>`;
    return;
  }
  if (!profileBySlug(subject?.category)) {
    el.innerHTML = `<div class="pad"><p class="muted">No behaviour category yet. Set one on the <a href="#" data-tab="subject">Subject</a> tab (category, terrain, sex, age and the despondent factors) and this tab turns into a search plan: distance rings, where people in that category are found, condition, scenarios and reflex tasks, each with its source.</p>
      ${immediateBlock()}</div>${attribution}`;
    wireTabs(el);
    return;
  }
  renderPlan(el, subject!, hasIpp, attribution, a, subject!.terrain ?? '');
}

/** The terrain-shaped area lines under the rings: how much of each circle the ground allows. */
function terrainBlock(): string {
  const sa = cs.s.searchArea;
  if (!sa) return '';
  if (sa.loading) return '<p class="small muted">Terrain area: modelling the ground around the point…</p>';
  if (sa.error) return `<p class="small ${sa.status === 503 ? 'muted' : 'amber'}">Terrain area: ${esc(sa.error)}</p>`;
  const a = sa.area!;
  if (!a.regions.length) return '<p class="small muted">Terrain area: nothing to draw for this category (half or more are found at the point itself).</p>';
  const cov = a.coverage.lidarPct ? `${a.coverage.lidarPct} % LiDAR, ${a.coverage.copernicusPct} % satellite heights` : `${a.coverage.copernicusPct} % satellite heights`;
  return `<div class="lpb-terrain"><p class="small"><b>Terrain areas</b> <span class="src terrain" title="Cost-distance over heights, land cover, coast, cliffs, paths">MODEL ${a.cellM} m</span> (solid shapes on the map): ${a.regions.map((r) => `<b>${r.pct} %</b> ${r.areaKm2 < 1 ? `${Math.round(r.areaKm2 * 100)} ha` : `${r.areaKm2.toFixed(1)} km²`} <span class="muted">(${Math.round(r.ratio * 100)} % of the circle)</span>`).join(', ')}.</p>
    <p class="small muted">The rest of each circle is sea, water, cliff or ground too steep or rough to reach in that distance. ${esc(cov)}; computed in ${(a.computedMs / 1000).toFixed(1)} s.</p>
    ${(a.corridors ?? []).map((c) => `<p class="small"><span class="corr-key"></span><b>Route to ${esc(c.label)}</b>: ${c.effortKm} km of walking effort for ${c.straightKm} km straight-line; the route and the place are weighted up.</p>`).join('')}
    ${segmentsTable(a)}</div>`;
}

function segmentsTable(a: SearchAreaResult): string {
  const segs = a.segments ?? [];
  if (!segs.length) return '';
  return `<h4>Search segments <span class="src terrain" title="Probability of area from the distance bands, where this category is found, and corridors to significant places">POA</span></h4>
    <p class="small muted">${a.modelledPct ?? ''} % of subjects in this category fall inside the outer area; these are its most likely pieces, highest first. Heat on the map shows the same thing cell by cell.${a.atPointPct ? ` ${a.atPointPct} % are recorded at the point itself, so the segment holding the planning point carries that share: search it first and thoroughly.` : ''}</p>
    <table class="lpb-table seg-table"><thead><tr><th></th><th class="num">POA</th><th class="num">Area</th><th>Ground</th><th></th></tr></thead><tbody>
    ${segs.map((s) => `<tr><td><b>${esc(s.id)}</b></td><td class="num">${s.poaPct} %</td><td class="num">${s.areaKm2 < 1 ? `${Math.round(s.areaKm2 * 100)} ha` : `${s.areaKm2.toFixed(1)} km²`}</td><td class="small">${esc(s.dominant)} · ${esc(s.band)}</td><td class="nowrap"><button class="mini" data-seg-locate="${esc(s.id)}" title="Show">◎</button><button class="mini" data-seg-target="${esc(s.id)}" title="Make this an area target">Target</button></td></tr>`).join('')}
    </tbody></table>`;
}

function tacticList(items: Tactic[]): string {
  return `<ul class="lpb-tactics">${items.map((t) => `<li><span class="pri p${t.priority}">${t.priority}</span>${esc(t.task)} <span class="why" title="${esc(t.evidence.source)} · ${esc(t.evidence.ref)}">${esc(t.evidence.stat)}</span></li>`).join('')}</ul>`;
}

function immediateBlock(plan?: SearchPlan): string {
  const im = LPB.immediate;
  return `<h4>First hour · all categories</h4>
    <div class="stats"><div class="stat"><span>Found alive</span><b>${im.foundAlivePct} %</b></div><div class="stat"><span>Fatality</span><b>${im.fatalityPct} %</b></div><div class="stat"><span>No trace</span><b>${im.noTracePct} %</b></div></div>
    <p class="small">Within 500 m of the planning point: <b>${im.within500mPct} %</b>; within 1 km: <b>${im.within1kmPct} %</b>. ${esc(im.notes[0] ?? '')}</p>
    ${tacticList(plan?.tactics.immediate ?? [])}`;
}

function renderPlan(el: HTMLElement, s: IncidentSubject, hasIpp: boolean, attribution: string, a: SidebarActions, terrainView: string): void {
  const sig = significantPoints();
  const plan = buildPlan({ category: s.category!, terrain: terrainView || undefined, sex: s.sex, age: s.age, suicideThreatened: s.suicideThreatened, previousAttempts: s.selfHarmHistory, depression: s.depression, significantPlaceKnown: s.significantPlaceKnown || sig.length > 0 }, planContext());
  if (!plan) return;
  const { profile } = plan;
  const terrains = terrainsWithData(profile);
  const saved = s.terrain ?? '';
  const factors = [s.sex, s.age !== undefined ? `${s.age} yrs` : '', terrainView || 'terrain unknown', s.suicideThreatened ? 'threat made' : '', s.selfHarmHistory ? 'previous attempts' : '', s.depression ? 'depression' : '', s.significantPlaceKnown || sig.length ? `significant place known${sig.length ? `: ${sig.map((p) => p.label ?? 'marked').join(', ')}` : ''}` : ''].filter(Boolean);
  const c = plan.condition;
  const isridRings = plan.isrid ? plan.isrid.rings.map((r) => `${r.pct} % ${km(r.km)}`).join(' · ') : '';
  el.innerHTML = `<div class="lpb">
      <div class="lpb-head"><b>${esc(profile.name)}</b> ${srcTag(plan.rings.basis)}${profile.lowNumbersCaution ? ' <span class="badge-s amber" title="The source warns the numbers in this category are small">low numbers</span>' : ''}</div>
      <p class="muted small lpb-factors">Plan for: ${esc(factors.join(' · '))}. <label>View terrain <select id="lpb-terrain" class="inline"><option value="">unknown / all</option>${LPB_TERRAINS.map((t) => `<option ${t === terrainView ? 'selected' : ''} ${terrains.includes(t) ? '' : 'class="nodata"'}>${esc(t)}${t === saved ? ' (saved)' : ''}</option>`).join('')}</select></label></p>

      <h4>Rings ${srcTag(plan.rings.basis)}</h4>
      ${plan.rings.items.length ? `<p class="small">${plan.rings.items.map(ringText).join(', ')}.${hasIpp ? ' <button type="button" class="mini" id="lpb-fit">Show on map</button>' : ''}</p>` : '<p class="small">Half or more of this category are recorded at the planning point itself; no ring is drawn below the first non-zero distance.</p>'}
      ${hasIpp ? '' : '<p class="small amber">Set the last known position (Responders tab, Points) to draw the rings on the map.</p>'}
      ${hasIpp ? terrainBlock() : ''}
      ${plan.studyDistance ? `<p class="small">2011 study, ${esc(plan.studyDistance.basis.ref.replace(/^Table \d+ /, ''))} ${srcTag(plan.studyDistance.basis)}: ${plan.studyDistance.points.filter((x) => x.pct < 100).map((x) => `<b>${x.pct} %</b> ${km(x.km)}`).join(', ')}; furthest ${km(plan.studyDistance.points[plan.studyDistance.points.length - 1].km)}.${plan.studyDistance.stepPct > 10 ? ` <span class="muted">(${plan.studyDistance.stepPct} % steps: fewer cases)</span>` : ''}</p>` : ''}
      ${plan.rawDistancesKm ? `<p class="small">2011 study, every case ${srcTag(plan.rawDistancesKm.basis)}: ${plan.rawDistancesKm.km.map(km).join(', ')}.</p>` : ''}
      ${plan.isrid ? `<p class="small">ISRID ${esc(plan.isrid.group.name)}, ${esc(plan.isrid.ecoregion.toLowerCase())} ${srcTag(plan.isrid.basis)}: ${isridRings}.</p>` : ''}

      <h4>Where found ${srcTag(plan.locations.basis)}</h4>
      ${bars(plan.locations.shares)}
      ${plan.studyLocations ? `<p class="small lpb-detail">2011 ${esc(plan.studyLocations.basis.ref.replace(/^Table \d+ /, ''))} ${srcTag(plan.studyLocations.basis)}: ${plan.studyLocations.groups.map((g) => `<b>${esc(g.key)}</b> ${g.pct} %`).join(', ')}.${plan.studyLocations.detail.length ? ` Detail: ${plan.studyLocations.detail.slice(0, 6).map((d) => `${esc(d.key)} ${d.pct} %`).join(', ')}.` : ''}</p>` : ''}
      ${plan.isrid ? `<p class="small lpb-detail">ISRID ${esc(plan.isrid.ecoregion.toLowerCase())}: ${plan.isrid.findLocation.slice(0, 5).map((f) => `<b>${esc(f.key)}</b> ${f.pct} %`).join(', ')}.</p>` : ''}

      <h4>Condition ${srcTag(c.basis)}</h4>
      <div class="stats"><div class="stat"><span>Alive</span><b>${c.alivePct} %</b></div><div class="stat"><span>Fatality</span><b>${c.fatalityPct} %</b></div><div class="stat"><span>Unknown</span><b>${c.unknownPct} %</b></div></div>
      ${c.segment ? `<p class="small">2011 ${esc(c.segment.basis.ref.replace(/^Table \d+ /, ''))} ${srcTag(c.segment.basis)}: unhurt ${c.segment.pct.unhurt} %, injured ${c.segment.pct.injured} %, fatal <b>${c.segment.pct.fatal} %</b>, no trace ${c.segment.pct['no trace']} %.</p>` : ''}
      ${c.modifiers ? (c.modifiers.lines.length ? `<div class="lpb-mod"><p class="small"><b>Indicative fatality rate, male despondents</b> ${srcTag(c.modifiers.basis)}</p><ul class="small">${c.modifiers.lines.map((l) => `<li>${esc(l.text)}: <b>${l.pct} %</b></li>`).join('')}</ul></div>` : `<p class="small muted">Female despondents: the 2011 study found no significant change in the fatality rate with any of the reported characteristics.</p>`) : ''}
      ${plan.isrid ? `<p class="small">ISRID: found well ${plan.isrid.group.outcomePct.well} %, dead ${plan.isrid.group.outcomePct.dead} %. Chance of a live find falls to 50 % after ${plan.isrid.survivalDays.p50} days and 5 % after ${plan.isrid.survivalDays.p05} days. Typically mobile ${plan.isrid.mobilityHours.p50} h (95 % under ${plan.isrid.mobilityHours.p95} h); half found within ${plan.isrid.trackOffsetM.p50} m of a path, road or stream.</p>` : ''}

      ${plan.scenarios.items.length ? `<h4>Likely scenarios ${srcTag(plan.scenarios.basis)}</h4><ul class="lpb-scen small">${plan.scenarios.items.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}

      <h4>Reflex tasks</h4>
      ${plan.tactics.category.length ? tacticList(plan.tactics.category) : '<p class="muted small">No category-specific tasks; use the first-hour list.</p>'}
      ${immediateBlock(plan)}

      <h4>Warnings</h4>
      <ul class="lpb-warn small">${[...plan.warnings, ...(cs.s.searchArea?.area?.warnings ?? [])].map((w) => `<li>${esc(w)}</li>`).join('')}</ul>

      <details class="lpb-data"><summary>Data: live percentiles and outcome</summary>
        <table class="lpb-table"><tbody>${profile.distanceKm.map((d) => `<tr class="${d.pct === 100 ? 'muted' : ''}"><td>${d.pct} %</td><td>found within</td><td class="num">${km(d.km)}</td><td class="muted small">${d.pct === 100 ? 'furthest case, not drawn' : ''}</td></tr>`).join('')}</tbody></table>
        ${bars(outcomeShares(profile), 'outcome')}
        ${profile.notes.length ? profile.notes.map((n) => `<p class="small lpb-note">${esc(n)}</p>`).join('') : ''}
        ${plan.study?.notes.length ? `<p class="muted small">2011 study notes:</p>${plan.study.notes.map((n) => `<p class="small lpb-note">${esc(n)}</p>`).join('')}` : ''}
      </details>
      <p class="muted small">Sources: ${plan.sources.map(esc).join(' ')} <a href="${esc(profile.sourceUrl)}" target="_blank" rel="noopener">Live page</a></p>
    </div>${attribution}`;
  el.querySelector<HTMLSelectElement>('#lpb-terrain')!.addEventListener('change', (ev) => renderPlan(el, s, hasIpp, attribution, a, (ev.target as HTMLSelectElement).value));
  el.querySelector('#lpb-fit')?.addEventListener('click', () => a.fitRings());
  const area = cs.s.searchArea?.area;
  const segById = (id: string) => area?.segments?.find((x) => x.id === id);
  el.querySelectorAll<HTMLButtonElement>('[data-seg-locate]').forEach((b) => b.addEventListener('click', () => {
    const seg = segById(b.dataset.segLocate!);
    const ring = seg?.targetRing ?? [];
    if (!ring.length) return;
    a.locate(ring.reduce((t, p) => t + p[0], 0) / ring.length, ring.reduce((t, p) => t + p[1], 0) / ring.length, 16);
  }));
  el.querySelectorAll<HTMLButtonElement>('[data-seg-target]').forEach((b) => b.addEventListener('click', async () => {
    const seg = segById(b.dataset.segTarget!);
    const incId = cs.s.search?.incident?.id;
    if (!seg || !incId || seg.targetRing.length < 4) return;
    try {
      await post(`/api/incidents/${incId}/targets`, {
        name: `${seg.id} ${seg.dominant}`.slice(0, 60),
        kind: 'area',
        geometry: { type: 'Polygon', coordinates: [seg.targetRing] },
        priority: seg.rank <= 3 ? 1 : seg.rank <= 6 ? 2 : 3,
        notes: `Terrain model: POA ${seg.poaPct} % (${seg.densityPerKm2} %/km²), ${seg.band}, ${seg.areaKm2 < 1 ? `${Math.round(seg.areaKm2 * 100)} ha` : `${seg.areaKm2.toFixed(1)} km²`}, mostly ${seg.dominant.toLowerCase()}.`,
      });
      toast(`${seg.id} added as a target`);
      b.disabled = true;
      b.textContent = 'Added';
    } catch (e) {
      toast(e instanceof Error ? e.message : 'failed', true);
    }
  }));
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
  const pointById = (id: number) => search?.incident?.points?.find((p) => p.id === id);
  root.querySelectorAll<HTMLButtonElement>('[data-pt-add]').forEach((b) => b.addEventListener('click', () => a.pickPoint(b.dataset.ptAdd as PlanningPointKind)));
  root.querySelector<HTMLSelectElement>('#pt-add')?.addEventListener('change', (ev) => { const v = (ev.target as HTMLSelectElement).value as PlanningPointKind; if (v) a.pickPoint(v); });
  root.querySelectorAll<HTMLButtonElement>('[data-pt-locate]').forEach((b) => b.addEventListener('click', () => { const p = pointById(Number(b.dataset.ptLocate)); if (p) a.locate(p.lon, p.lat, 16); }));
  root.querySelectorAll<HTMLButtonElement>('[data-pt-move]').forEach((b) => b.addEventListener('click', () => { const p = pointById(Number(b.dataset.ptMove)); if (p) a.pickPoint(p.kind, p.id); }));
  root.querySelectorAll<HTMLButtonElement>('[data-pt-del]').forEach((b) => b.addEventListener('click', async () => {
    const p = pointById(Number(b.dataset.ptDel));
    if (p && confirm(`Remove ${POINT_KIND_LABEL[p.kind]}${p.label ? ` "${p.label}"` : ''}?`)) await del(`/api/points/${p.id}`);
  }));
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
