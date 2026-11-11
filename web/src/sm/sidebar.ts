import { LPB, LPB_GROUPS, LPB_TERRAINS, buildPlan, outcomeShares, profileBySlug, suggestProfile, terrainsWithData, type Basis, type PlanRing, type SearchPlan, type Tactic } from '../../../shared/lpb/index';
import { MANAGER_POINT_KINDS, POINT_KIND_LABEL, POINT_KIND_SHORT, type IncidentSubject, type SearchAreaResult, type SearchSegment, type PlanningPointKind, type ResponderRow, type Target, type TargetStatus, type Team, type TeamStatus } from '../../../shared/types';
import { del, get, patch, post, put } from '../api';
import { updatePoa } from '../../../shared/searchtheory';
import { askPod } from './pod';
import { esc, fmtAgeShort, fmtTime } from '../format';
import { toast } from '../m/ui';
import { closeModal, confirmBox, modal } from './modal';
import { cs } from './state';
import { boardBusy, teamMembersHtml, waitingHtml, wireTeamBoard } from './teamboard';

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
  /** Outline a shape on the map while its list row is hovered. */
  highlight: (g: GeoJSON.Geometry | undefined) => void;
}

const TAB_LABEL = { subject: '1 Subject', behaviour: '2 Plan', teams: '3 Teams' } as const;
const TEAM_STATUSES: TeamStatus[] = ['forming', 'tasked', 'searching', 'returned', 'stood-down'];
const TARGET_STATUSES: TargetStatus[] = ['planned', 'assigned', 'in-progress', 'done', 'cancelled'];
const badge = (s: string) => `<span class="badge-s ${({ responding: 'amber', 'on-scene': 'green', available: 'blue', searching: 'amber', tasked: 'blue', 'in-progress': 'amber', done: 'green' } as Record<string, string>)[s] ?? 'grey'}">${esc(s)}</span>`;

export function renderSidebar(root: HTMLElement, a: SidebarActions): void {
  const { search } = cs.s;
  // Teams shows how many responders are waiting for a team: the number that needs action.
  const waiting = search ? search.responders.filter((r) => (r.status === 'responding' || r.status === 'on-scene') && !search.teams.some((t) => t.members.some((m) => m.userId === r.userId))).length : 0;
  const tabs = (['subject', 'behaviour', 'teams'] as const)
    .map((t) => `<button class="tab ${cs.s.tab === t ? 'active' : ''}" data-tab="${t}">${TAB_LABEL[t]}${t === 'teams' && waiting ? ` <span class="tab-n amber" title="Responding, not yet in a team">${waiting}</span>` : ''}</button>`)
    .join('');
  // The subject tab holds a form: never wipe it on a position tick, only when the data key changes.
  if (cs.s.tab === 'subject' && search?.incident) {
    const key = `${search.incident.id}:${search.incident.subjectUpdatedAt ?? ''}`;
    const form = root.querySelector('#subject-form');
    // keep the form when nothing changed, while someone types in it, or when the change is our own autosave
    if (form && (root.dataset.subjectKey === key || form.contains(document.activeElement) || Date.now() - subjectSavedAt < 5000)) {
      root.dataset.subjectKey = key;
      root.querySelector('.tabs-sm')!.innerHTML = tabs;
      wireTabs(root);
      refreshPoints(root, a);
      return;
    }
    root.dataset.subjectKey = key;
    root.innerHTML = `<div class="tabs-sm">${tabs}</div><div class="sb-body"><div class="k pad-k">Where</div><div id="points-host"></div><div id="subject-body"><p class="muted pad">Loading…</p></div></div>`;
    wireTabs(root);
    refreshPoints(root, a);
    void subjectTab(root.querySelector('#subject-body')!, search.incident.id);
    return;
  }
  delete root.dataset.subjectKey;
  // The behaviour tab has its own terrain selector: keep it across position ticks too.
  if (cs.s.tab === 'behaviour' && search?.incident) {
    const sa = cs.s.searchArea;
    const key = `${search.targets.map((t) => `${t.id}${t.status}`).join(',')}:${search.teams.map((t) => `${t.id}${t.status}`).join(',')}:${cs.s.subjectKey ?? ''}:${cs.s.subject?.category ?? ''}:${cs.s.subject?.terrain ?? ''}:${search.incident.ipp ? 1 : 0}:${significantPoints().map((p) => p.id).join(',')}:${sa?.key ?? ''}:${sa?.loading ? 'l' : sa?.area ? 'a' : sa?.error ? 'e' : ''}`;
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
  // never redraw the board under a drag, or under a team name being typed
  if (cs.s.tab === 'teams' && (boardBusy() || root.querySelector('.team-name:focus'))) return;
  let body = '';
  if (!search?.incident) body = `<p class="muted pad">No open tasking. Start one from the top bar (New tasking); a pager callout opens one automatically.</p>`;
  else if (cs.s.tab === 'teams') body = waitingHtml(search.responders, search.teams) + teamsTab(search.teams, search.responders, search.targets) + targetsTab(search.targets, search.teams);
  else body = `<p class="muted pad">No open tasking.</p>`;
  root.innerHTML = `<div class="tabs-sm">${tabs}</div><div class="sb-body">${body}</div>`;
  wireTabs(root);
  wire(root, a);
}

/** The points list on the Subject tab: redrawn on every update, while the form below it is kept. */
function refreshPoints(root: HTMLElement, a: SidebarActions): void {
  const host = root.querySelector<HTMLElement>('#points-host');
  if (!host) return;
  const html = pointsBar();
  if (host.dataset.html === html) return;
  host.dataset.html = html;
  host.innerHTML = html;
  wire(host, a);
}

function wireTabs(root: HTMLElement): void {
  root.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((b) => b.addEventListener('click', () => { cs.s.tab = b.dataset.tab as typeof cs.s.tab; cs.notify(); }));
}

const significantPoints = () => (cs.s.search?.incident?.points ?? []).filter((p) => p.kind === 'significant');

function pointsBar(): string {
  const pts = cs.s.search?.incident?.points ?? [];
  const pick = cs.s.picking;
  const has = (k: PlanningPointKind) => pts.some((p) => p.kind === k);
  const addable = MANAGER_POINT_KINDS.filter((k) => !((k === 'lkp' || k === 'pls') && has(k)));
  const rows = pts
    .map((p) => `<div class="pt-row k-${p.kind}"><span class="pt-kind" title="${esc(POINT_KIND_LABEL[p.kind])}">${esc(POINT_KIND_SHORT[p.kind])}</span>
      <span class="grow"><b>${esc(p.label ?? POINT_KIND_LABEL[p.kind])}</b> <span class="muted small">${fmtTime(p.setAt)}</span>${p.note ? `<span class="muted small pt-note">${esc(p.note)}</span>` : ''}</span>
      <button class="mini" data-pt-locate="${p.id}" title="Show on the map">◎</button><button class="mini ${pick?.pointId === p.id ? 'on' : ''}" data-pt-move="${p.id}" title="Move">Move</button><button class="mini danger" data-pt-del="${p.id}" title="Remove">×</button></div>`)
    .join('');
  const chip = (k: PlanningPointKind) => `<button class="pt-add k-${k} ${pick?.kind === k && !pick.pointId ? 'on' : ''}" data-pt-add="${k}">+ ${esc(k === 'lkp' ? 'Last known position' : k === 'pls' ? 'Last seen' : POINT_KIND_LABEL[k])}</button>`;
  return `<div class="points-bar">
      <div class="pt-head"><b>Points</b></div>
      ${rows || '<p class="muted small pad0">Start with the last known position: click a button, then the map, or search above the map.</p>'}
      <div class="pt-adds">${addable.map(chip).join('')}</div>
    </div>`;
}

function teamsTab(teams: Team[], responders: ResponderRow[], targets: Target[]): string {
  const daylight = cs.s.state?.sun?.isDaylight ?? true;
  const cards = teams
    .map((t) => {
      const tts = targets.filter((x) => x.teamId === t.id && x.status !== 'cancelled');
      return `<div class="team" style="--team:${esc(t.colour)}" data-team="${t.id}" data-drop="team:${t.id}">
        <div class="team-head">
          <span class="dot"></span>
          <input class="team-name" data-rename="${t.id}" value="${esc(t.name)}" />
          <select data-team-status="${t.id}">${TEAM_STATUSES.map((s) => `<option value="${s}" ${s === t.status ? 'selected' : ''}>${s}</option>`).join('')}</select>
          <button class="mini" data-fit-team="${t.id}" title="Locate team">◎</button>
          <button class="mini" data-team-settings="${t.id}" title="Team settings: sweep width, colour, name">⚙</button>
          <button class="mini danger" data-del-team="${t.id}" title="Delete team">×</button>
        </div>
        ${teamMembersHtml(t)}
        ${teamTargetLine(t, tts, targets)}
        <div class="team-foot">
          <span>Sweep width <span class="width">${t.searchWidthM} m</span></span>
        </div>
      </div>`;
    })
    .join('');
  void responders;
  return `<div class="k pad-k">Teams</div>${cards || '<p class="muted small pad0 pad-x">No teams yet: drag people onto + New team, or use Split above.</p>'}
    <button class="btn-sm primary wide" data-action="new-team" data-drop="new">+ New team</button>
    <p class="muted small pad">New teams start at ${daylight ? '20 m (daylight)' : '10 m (after sunset)'} sweep width; change it per team with ⚙.</p>
`;
}

/**
 * The team's current target and the one next step for it: assign a target, start the search,
 * mark it searched. Team status follows on the server.
 */
function teamTargetLine(t: Team, mine: Target[], all: Target[]): string {
  const live = mine.filter((x) => x.status !== 'done');
  const cur = live.find((x) => x.status === 'in-progress') ?? live[0];
  const free = all.filter((x) => !x.teamId && x.status !== 'cancelled' && x.status !== 'done');
  const done = mine.filter((x) => x.status === 'done').length;
  const assign = free.length && t.members.length ? `<select class="next-step" data-assign-target="${t.id}"><option value="">${cur ? 'Add target…' : 'Assign target…'}</option>${free.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}</select>` : '';
  if (!cur) return `<div class="team-target"><span class="muted small grow">${done ? `${done} searched · ` : ''}${t.members.length ? (free.length ? 'No target' : 'No target: draw one or use a segment on the Plan tab') : 'Add members first'}</span>${assign}</div>`;
  const step = cur.status === 'in-progress' ? `<button class="btn-sm primary" data-target-step="${cur.id}:done">Mark searched</button>` : `<button class="btn-sm primary" data-target-step="${cur.id}:in-progress">Start search</button>`;
  return `<div class="team-target"><span class="grow"><b data-zoom-target="${cur.id}">${esc(cur.name)}</b> ${badge(cur.status)}${live.length > 1 ? ` <span class="muted small">+${live.length - 1} more</span>` : ''}${done ? ` <span class="muted small">${done} searched</span>` : ''}</span>${step}</div>${assign && live.length < 2 ? `<div class="team-target">${assign}</div>` : ''}`;
}

function targetsTab(targets: Target[], teams: Team[]): string {
  const live = targets.filter((t) => t.status !== 'cancelled');
  const groups = [{ label: 'Unassigned', colour: '#9fb3c8', items: live.filter((x) => !x.teamId) }, ...teams.map((t) => ({ label: t.name, colour: t.colour, items: live.filter((x) => x.teamId === t.id) }))].filter((g) => g.items.length);
  const editing = cs.s.editingTargetId;
  return `<div class="k pad-k">Targets · ${live.length}</div>
    ${groups.length ? groups.map((g) => `<div class="tgroup" style="--team:${esc(g.colour)}"><div class="tgroup-head"><span class="dot"></span>${esc(g.label)}</div>${g.items.map((t) => targetRow(t, teams, editing === t.id)).join('')}</div>`).join('') : '<p class="muted small pad0 pad-x">Draw a point, area or line with the tools on the map, or assign a segment on the Plan tab.</p>'}`;
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
/** The categories most searches start from, offered as chips; the rest are under More. */
const COMMON_CATEGORIES = ['despondent', 'dementia', 'psychological-illness', 'children-aged-1-16', 'walker-solo', 'water-related'];
const CATEGORY_SHORT: Record<string, string> = { 'psychological-illness': 'Mental illness', 'children-aged-1-16': 'Child', 'walker-solo': 'Walker', 'water-related': 'Water' };

/** When the form last saved itself; a snapshot echo of our own save must not redraw the form under the typist. */
export let subjectSavedAt = 0;

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
  const name = (slug: string) => CATEGORY_SHORT[slug] ?? profileBySlug(slug)?.name ?? slug;
  const radio = (field: string, value: string, label: string, on: boolean) => `<label class="opt"><input type="radio" name="${field}" value="${esc(value)}" ${on ? 'checked' : ''} /><span>${esc(label)}</span></label>`;
  const check = (field: string, label: string, on: boolean, id = '') => `<label class="opt"><input type="checkbox" name="${field}" ${id ? `id="${id}"` : ''} ${on ? 'checked' : ''} /><span>${esc(label)}</span></label>`;
  const isCommon = COMMON_CATEGORIES.includes(s.category ?? '');
  el.innerHTML = `<form class="subject-form" id="subject-form">
      <div class="k">Who</div>
      <div class="opts">${['Male', 'Female', 'Other'].map((x) => radio('sex', x, x, s.sex === x)).join('')}<label class="age">Age <input name="age" type="number" min="0" max="120" value="${v('age')}" /></label></div>
      <div class="opts">${check('despondent', 'Low mood', s.despondent)}${check('mentalHealth', 'Mental health concerns', s.mentalHealth)}${check('selfHarmHistory', 'Previous self-harm', s.selfHarmHistory, 'sh')}</div>
      <div class="k">Behaviour category</div>
      <div class="opts" id="cat-opts">${COMMON_CATEGORIES.map((slug) => radio('category', slug, name(slug), s.category === slug)).join('')}
        <select name="categoryMore" id="cat-more" class="${s.category && !isCommon ? 'on' : ''}"><option value="">More…</option>${LPB_GROUPS.map((g) => `<optgroup label="${esc(g.label)}">${g.slugs.map((slug) => { const p = profileBySlug(slug)!; return `<option value="${slug}" ${s.category === slug && !isCommon ? 'selected' : ''}>${esc(p.name)} (n=${p.n})</option>`; }).join('')}</optgroup>`).join('')}</select></div>
      <p class="small lpb-hint" id="lpb-hint"></p>
      <label id="sh-means" style="${s.selfHarmHistory ? '' : 'display:none'}">Previous means <input name="selfHarmMeans" value="${v('selfHarmMeans')}" maxlength="200" placeholder="e.g. overdose, water" /></label>
      <div class="opts" id="desp-flags" style="${s.despondent || s.category === 'despondent' ? '' : 'display:none'}">${check('suicideThreatened', 'Threat made', s.suicideThreatened)}${check('depression', 'Depression', s.depression)}${check('significantPlaceKnown', 'Significant place known', s.significantPlaceKnown)}</div>
      <label>Terrain for the statistics <select name="terrain"><option value="">All / unknown</option>${LPB_TERRAINS.map((t) => `<option ${s.terrain === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>

      <div class="k">For crew <span class="muted small">(on their phones, never the TV)</span></div>
      <label>Name <input name="name" value="${v('name')}" maxlength="120" /></label>
      <label>Clothing and appearance <textarea name="clothing" rows="2" placeholder="Height, build, hair, what they were wearing">${v('clothing')}</textarea></label>
      <div class="subject-photo">
        ${photoUrl ? `<img src="${photoUrl}" alt="Subject photo" />` : '<div class="ph">No photo</div>'}
        <div><label>Recent photo <input type="file" id="subject-file" accept="image/*" /></label>
          ${s.hasPhoto ? '<button type="button" class="btn-sm danger" id="photo-del">Remove photo</button>' : ''}</div>
      </div>
      <details class="subject-more" ${s.description || s.locations || s.history ? 'open' : ''}><summary>More: description, places, history</summary>
        <label>Other description <textarea name="description" rows="2" placeholder="Mobility, phone, vehicle, dog…">${v('description')}</textarea></label>
        <label>Places that matter <textarea name="locations" rows="2" placeholder="Mark them on the map too: they shape the plan">${v('locations')}</textarea></label>
        <label>Relevant history <textarea name="history" rows="2" placeholder="Previous incidents, medical conditions, routines">${v('history')}</textarea></label>
      </details>
      <div class="save-row"><span class="muted small" id="subject-saved">${s.updatedAt ? `Saved ${fmtTime(s.updatedAt)}` : 'Saves as you go'}</span></div>
    </form>`;
  const form = el.querySelector<HTMLFormElement>('#subject-form')!;
  const saved = el.querySelector<HTMLElement>('#subject-saved')!;
  const more = el.querySelector<HTMLSelectElement>('#cat-more')!;
  const category = () => String(new FormData(form).get('category') ?? '') || more.value;
  const refreshHint = () => {
    const f = new FormData(form);
    const cur = category();
    const hint = el.querySelector<HTMLElement>('#lpb-hint')!;
    const sug = !cur ? suggestProfile({ age: f.get('age') ? Number(f.get('age')) : undefined, despondent: f.get('despondent') === 'on', mentalHealth: f.get('mentalHealth') === 'on' }) : undefined;
    hint.innerHTML = cur ? `<span class="muted">${esc(profileBySlug(cur)?.definition ?? '')}</span>` : sug ? `Suggested: <button type="button" class="mini on" id="use-sug" data-slug="${esc(sug)}">Use ${esc(profileBySlug(sug)?.name ?? sug)}</button>` : '<span class="muted">Pick a category to get the plan and the distance rings.</span>';
    hint.querySelector<HTMLButtonElement>('#use-sug')?.addEventListener('click', (ev) => setCategory((ev.currentTarget as HTMLElement).dataset.slug!));
    el.querySelector<HTMLElement>('#desp-flags')!.style.display = f.get('despondent') === 'on' || cur === 'despondent' ? '' : 'none';
    el.querySelector<HTMLElement>('#sh-means')!.style.display = f.get('selfHarmHistory') === 'on' ? '' : 'none';
    more.classList.toggle('on', Boolean(more.value));
  };
  const setCategory = (slug: string) => {
    const r = form.querySelector<HTMLInputElement>(`input[name=category][value="${slug}"]`);
    form.querySelectorAll<HTMLInputElement>('input[name=category]').forEach((x) => (x.checked = false));
    if (r) { r.checked = true; more.value = ''; } else more.value = slug;
    refreshHint();
    schedule(0);
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const save = async () => {
    const f = new FormData(form);
    const body = {
      name: String(f.get('name') ?? ''), sex: String(f.get('sex') ?? ''), age: f.get('age') ? Number(f.get('age')) : null,
      clothing: String(f.get('clothing') ?? ''), description: String(f.get('description') ?? ''), locations: String(f.get('locations') ?? ''), history: String(f.get('history') ?? ''),
      despondent: f.get('despondent') === 'on', mentalHealth: f.get('mentalHealth') === 'on', selfHarmHistory: f.get('selfHarmHistory') === 'on', selfHarmMeans: String(f.get('selfHarmMeans') ?? ''),
      category: category(), terrain: String(f.get('terrain') ?? ''),
      suicideThreatened: f.get('suicideThreatened') === 'on', depression: f.get('depression') === 'on', significantPlaceKnown: f.get('significantPlaceKnown') === 'on',
    };
    try {
      subjectSavedAt = Date.now();
      await put(`/api/incidents/${incidentId}/subject`, body);
      subjectSavedAt = Date.now();
      saved.textContent = `Saved ${fmtTime(new Date().toISOString())}`;
    } catch (e) {
      saved.innerHTML = `<span class="amber">Not saved: ${esc(e instanceof Error ? e.message : 'failed')}</span>`;
    }
  };
  const schedule = (ms: number) => { clearTimeout(timer); saved.textContent = 'Saving…'; timer = setTimeout(() => void save(), ms); };
  form.addEventListener('submit', (ev) => { ev.preventDefault(); schedule(0); });
  form.addEventListener('change', (ev) => {
    const t = ev.target as HTMLElement;
    if (t.id === 'subject-file') return;
    if (t === more && more.value) form.querySelectorAll<HTMLInputElement>('input[name=category]').forEach((x) => (x.checked = false));
    if ((t as HTMLInputElement).name === 'category') more.value = '';
    refreshHint();
    schedule(300);
  });
  // typing saves a moment after the last key
  form.addEventListener('input', (ev) => { const t = ev.target as HTMLElement; if (t.matches('textarea, input[type=text], input:not([type]), input[type=number]')) schedule(1200); });
  refreshHint();
  el.querySelector<HTMLInputElement>('#subject-file')!.addEventListener('change', async (ev) => {
    const file = (ev.target as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      const blob = await resizeImage(file, 1280);
      const res = await fetch(`/api/incidents/${incidentId}/subject/photo`, { method: 'PUT', body: blob, headers: { 'content-type': blob.type }, credentials: 'same-origin' });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})) as { error?: string }).error ?? `HTTP ${res.status}`);
      toast('Photo uploaded');
      subjectSavedAt = 0; // let the form redraw with the new photo
      (document.activeElement as HTMLElement | null)?.blur();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'upload failed', true);
    }
  });
  el.querySelector('#photo-del')?.addEventListener('click', async () => {
    if (!(await confirmBox('Remove the photo?', 'Remove'))) return;
    await del(`/api/incidents/${incidentId}/subject/photo`);
    subjectSavedAt = 0;
    (document.activeElement as HTMLElement | null)?.blur();
    toast('Photo removed');
  });
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
    el.innerHTML = `<div class="pad lpb-empty"><p>Set the subject's behaviour category to get the plan: distance rings, where people like them are found, and tasks to start with.</p>
      <button class="btn-sm primary" data-tab="subject">Set category</button></div>
      <div class="lpb">${tasksBlock()}</div>
      <details class="lpb-evidence"><summary>Evidence and sources</summary>${immediateStats()}${attribution}</details>`;
    wireTabs(el);
    return;
  }
  renderPlan(el, subject!, hasIpp, attribution, a, subject!.terrain ?? '');
}

const areaText = (km2: number) => (km2 < 1 ? `${Math.round(km2 * 100)} ha` : `${km2.toFixed(1)} km²`);

/** One line on the terrain area (or why there is none); the method sits in the evidence section. */
function terrainLine(): string {
  const sa = cs.s.searchArea;
  if (!sa) return '';
  if (sa.loading) return '<p class="small muted">Shaping the rings to the ground…</p>';
  if (sa.error) return `<p class="small ${sa.status === 503 ? 'muted' : 'amber'}">Terrain area: ${esc(sa.error)}</p>`;
  const a = sa.area!;
  if (!a.regions.length) return '<p class="small muted">No terrain area: half or more are found at the point itself.</p>';
  return `<p class="small"><span class="muted">On the ground</span> ${a.regions.map((r) => `${r.pct} % ${areaText(r.areaKm2)}`).join(' · ')}</p>`;
}

/** Method notes for the terrain area, for the evidence section. */
function terrainEvidence(): string {
  const a = cs.s.searchArea?.area;
  if (!a?.regions.length) return '';
  const cov = a.coverage.lidarPct ? `${a.coverage.lidarPct} % LiDAR, ${a.coverage.copernicusPct} % satellite heights` : `${a.coverage.copernicusPct} % satellite heights`;
  return `<h4>Terrain area <span class="src terrain" title="Cost-distance over heights, land cover, coast, cliffs, paths">MODEL ${a.cellM} m</span></h4>
    <p class="small">${a.regions.map((r) => `<b>${r.pct} %</b> ${areaText(r.areaKm2)} <span class="muted">(${Math.round(r.ratio * 100)} % of the circle)</span>`).join(', ')}. The rest of each circle is sea, water, cliff or ground too steep or rough to reach in that distance. ${esc(cov)}.</p>
    ${(a.corridors ?? []).map((c) => `<p class="small"><span class="corr-key"></span><b>Route to ${esc(c.label)}</b>: ${c.effortKm} km of walking effort for ${c.straightKm} km straight-line; the route and the place are weighted up.</p>`).join('')}
    <p class="small muted">Segments: ${a.modelledPct ?? ''} % of subjects in this category fall inside the outer area; the segments are its most likely pieces, highest first.${a.atPointPct ? ` ${a.atPointPct} % are recorded at the point itself, so the segment holding the planning point carries that share.` : ''}</p>`;
}

/** Plain-language ground names, used in segment rows and in target names crew see. */
export const GROUND_NAME: Record<string, string> = { 'Open Ground': 'Open ground', 'Travel Aid': 'Roads and paths', 'Linear Feature': 'Streams and ditches', Trees: 'Woods and scrub', Water: "Water's edge", Habitation: 'Houses and gardens' };
const ground = (d: string) => GROUND_NAME[d] ?? d;

/** POA of each segment now, after the searches recorded so far (search theory: see shared/searchtheory.ts). */
export function currentPoa(a: SearchAreaResult): Map<string, { basePct: number; nowPct: number; cumPod: number }> {
  const segs = a.segments ?? [];
  const searched = (cs.s.search?.targets ?? []).filter((t) => t.segmentId && t.status === 'done' && typeof t.pod === 'number').map((t) => ({ segmentId: t.segmentId!, pod: t.pod! }));
  return new Map(updatePoa(segs.map((x) => ({ id: x.id, poaPct: x.poaPct })), searched, a.modelledPct ?? 100).map((x) => [x.id, x]));
}

function segmentsTable(a: SearchAreaResult): string {
  const segs = a.segments ?? [];
  if (!segs.length) return '';
  const teams = cs.s.search?.teams ?? [];
  const taken = segmentsTaken();
  const poa = currentPoa(a);
  const anySearched = [...poa.values()].some((x) => x.cumPod > 0);
  // highest probability now first: a searched segment drops down the list, the rest move up
  const ordered = [...segs].sort((x, y) => (poa.get(y.id)?.nowPct ?? y.poaPct) - (poa.get(x.id)?.nowPct ?? x.poaPct));
  const row = (s: SearchSegment) => {
    const p = poa.get(s.id)!;
    const changed = Math.abs(p.nowPct - p.basePct) >= 0.1;
    const pct = changed ? `<span class="muted small was">${p.basePct}</span> <b class="amber">${p.nowPct} %</b>` : `<b class="amber">${s.poaPct} %</b>`;
    const state = p.cumPod > 0 ? `<span class="badge-s green seg-searched" title="Cumulative probability of detection">searched ${Math.round(p.cumPod * 100)} %</span>` : taken.has(s.id) ? '<span class="muted small seg-added">Assigned</span>' : `<select class="seg-assign" data-seg-target="${esc(s.id)}" title="Make this an area target, for a team or for later"><option value="">Assign…</option>${teams.map((t) => `<option value="${t.id}">${esc(t.name)}${t.status === 'forming' ? '' : ` · ${esc(t.status)}`}</option>`).join('')}<option value="none">Target, no team yet</option></select>`;
    return `<tr class="${p.cumPod > 0 ? 'searched' : ''}"><td><b>${esc(s.id)}</b></td><td class="small">${esc(ground(s.dominant))} · ${areaText(s.areaKm2)}</td><td class="num nowrap">${pct}</td><td class="nowrap"><button class="mini" data-seg-locate="${esc(s.id)}" title="Show on the map">◎</button>${state}</td></tr>`;
  };
  const top = ordered.slice(0, 5), rest = ordered.slice(5);
  return `<h4>Search segments <span class="src terrain" title="Probability of area: % of subjects in this category expected in each segment">POA</span></h4>
    ${anySearched ? '<p class="small muted seg-note">Updated for the areas searched so far: their probability has moved to the rest.</p>' : ''}
    <table class="lpb-table seg-table"><tbody>${top.map(row).join('')}</tbody></table>
    ${rest.length ? `<details class="seg-more"><summary>Show all ${segs.length}</summary><table class="lpb-table seg-table"><tbody>${rest.map(row).join('')}</tbody></table></details>` : ''}`;
}

/** Tasks to start with: category tasks then first-hour tasks, by priority, without duplicates. Evidence on hover and in the evidence section. */
function tasksBlock(plan?: SearchPlan): string {
  const seen = new Set<string>();
  const items = [...(plan?.tactics.category ?? []), ...(plan?.tactics.immediate ?? LPB_IMMEDIATE_TACTICS())].filter((t) => (seen.has(t.task) ? false : (seen.add(t.task), true))).sort((x, y) => x.priority - y.priority);
  if (!items.length) return '';
  const li = (t: Tactic) => `<li title="${esc(t.evidence.stat)} (${esc(t.evidence.source)} · ${esc(t.evidence.ref)})"><span class="pri p${t.priority}">${t.priority}</span>${esc(t.task)}</li>`;
  const top = items.slice(0, 4), rest = items.slice(4);
  return `<h4>Do first</h4><ul class="lpb-tactics">${top.map(li).join('')}</ul>${rest.length ? `<details class="seg-more"><summary>${rest.length} more tasks</summary><ul class="lpb-tactics">${rest.map(li).join('')}</ul></details>` : ''}`;
}

/** First-hour tactics need a plan; without a category there is none, so take them from any plan. */
function LPB_IMMEDIATE_TACTICS(): Tactic[] {
  return buildPlan({ category: LPB_GROUPS[0]?.slugs[0] ?? '' })?.tactics.immediate ?? [];
}

function tacticList(items: Tactic[]): string {
  return `<ul class="lpb-tactics">${items.map((t) => `<li><span class="pri p${t.priority}">${t.priority}</span>${esc(t.task)} <span class="why" title="${esc(t.evidence.source)} · ${esc(t.evidence.ref)}">${esc(t.evidence.stat)}</span></li>`).join('')}</ul>`;
}

function immediateStats(): string {
  const im = LPB.immediate;
  return `<h4>First hour · all categories</h4>
    <div class="stats"><div class="stat"><span>Found alive</span><b>${im.foundAlivePct} %</b></div><div class="stat"><span>Fatality</span><b>${im.fatalityPct} %</b></div><div class="stat"><span>No trace</span><b>${im.noTracePct} %</b></div></div>
    <p class="small">Within 500 m of the planning point: <b>${im.within500mPct} %</b>; within 1 km: <b>${im.within1kmPct} %</b>. ${esc(im.notes[0] ?? '')}</p>`;
}

function renderPlan(el: HTMLElement, s: IncidentSubject, hasIpp: boolean, attribution: string, a: SidebarActions, terrainView: string): void {
  const sig = significantPoints();
  const plan = buildPlan({ category: s.category!, terrain: terrainView || undefined, sex: s.sex, age: s.age, suicideThreatened: s.suicideThreatened, previousAttempts: s.selfHarmHistory, depression: s.depression, significantPlaceKnown: s.significantPlaceKnown || sig.length > 0 }, planContext());
  if (!plan) return;
  const { profile } = plan;
  const terrains = terrainsWithData(profile);
  const saved = s.terrain ?? '';
  const factors = [s.sex, s.age !== undefined ? `${s.age}` : '', s.suicideThreatened ? 'threat made' : '', s.selfHarmHistory ? 'previous attempts' : '', s.depression ? 'depression' : ''].filter(Boolean);
  const c = plan.condition;
  const isridRings = plan.isrid ? plan.isrid.rings.map((r) => `${r.pct} % ${km(r.km)}`).join(' · ') : '';
  const area = cs.s.searchArea?.area;
  const warnings = [...plan.warnings, ...(area?.warnings ?? [])];
  // the live conditions (dark, Met Éireann warnings) come first: they change what teams do now
  const live = warnings.filter((w) => /^(Dark|Active warning)/.test(w));
  const other = warnings.filter((w) => !live.includes(w));
  const where = plan.locations.shares.filter((x) => !/not found|unknown/i.test(x.key)).slice(0, 3).map((x) => `${esc(x.key.toLowerCase())} ${Math.round(x.pct)} %`).join(', ');
  const worst = c.modifiers?.lines.length ? c.modifiers.lines.reduce((m, l) => (l.pct > m.pct ? l : m)) : undefined;
  const ringTiles = plan.rings.items.length
    ? `<div class="stats rings">${plan.rings.items.map((r) => `<div class="stat"><span>${r.pct} % within</span><b>${km(r.km)}${r.interpolated ? '<sup title="Interpolated between the source\'s 10 % steps">~</sup>' : ''}</b></div>`).join('')}</div>`
    : '<p class="small">Half or more of this category are found at the planning point itself: search it first and thoroughly.</p>';
  el.innerHTML = `<div class="lpb">
      <div class="lpb-head"><b>${esc(profile.name)}</b>${factors.length ? ` <span class="muted small">${esc(factors.join(' · '))}</span>` : ''}${profile.lowNumbersCaution ? ' <span class="badge-s amber" title="The source warns the numbers in this category are small">low numbers</span>' : ''}<a href="#" class="small right" data-tab="subject">Edit</a></div>
      ${ringTiles}
      <div class="lpb-sum small">
        ${hasIpp ? terrainLine() : '<p class="amber">Set the last known position (Crew tab, Points) to draw the rings on the map.</p>'}
        <p><span class="muted">Found in</span> ${where}</p>
        <p><span class="muted">Outcome</span> fatality ${Math.round(c.fatalityPct)} %${worst ? `, ${worst.pct} % ${esc(worst.text.toLowerCase())}` : ''}</p>
        ${hasIpp && plan.rings.items.length ? '<button type="button" class="mini" id="lpb-fit">Show on map</button>' : ''}
      </div>
      ${live.length ? `<div class="lpb-live small">${live.map((w) => `<p>${esc(w)}</p>`).join('')}</div>` : ''}
      ${tasksBlock(plan)}
      ${hasIpp && area ? segmentsTable(area) : ''}
      ${other.length ? `<h4>Watch for</h4><ul class="lpb-warn small">${other.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
    </div>
    <details class="lpb-evidence" id="lpb-evidence"><summary>Evidence and sources</summary><div class="lpb">
      <p class="small"><label>Statistics for terrain <select id="lpb-terrain" class="inline"><option value="">unknown / all</option>${LPB_TERRAINS.map((t) => `<option ${t === terrainView ? 'selected' : ''} ${terrains.includes(t) ? '' : 'class="nodata"'}>${esc(t)}${t === saved ? ' (saved)' : ''}</option>`).join('')}</select></label></p>
      <h4>Rings ${srcTag(plan.rings.basis)}</h4>
      ${plan.rings.items.length ? `<p class="small">${plan.rings.items.map(ringText).join(', ')}.</p>` : ''}
      ${plan.studyDistance ? `<p class="small">2011 study, ${esc(plan.studyDistance.basis.ref.replace(/^Table \d+ /, ''))} ${srcTag(plan.studyDistance.basis)}: ${plan.studyDistance.points.filter((x) => x.pct < 100).map((x) => `<b>${x.pct} %</b> ${km(x.km)}`).join(', ')}; furthest ${km(plan.studyDistance.points[plan.studyDistance.points.length - 1].km)}.${plan.studyDistance.stepPct > 10 ? ` <span class="muted">(${plan.studyDistance.stepPct} % steps: fewer cases)</span>` : ''}</p>` : ''}
      ${plan.rawDistancesKm ? `<p class="small">2011 study, every case ${srcTag(plan.rawDistancesKm.basis)}: ${plan.rawDistancesKm.km.map(km).join(', ')}.</p>` : ''}
      ${plan.isrid ? `<p class="small">ISRID ${esc(plan.isrid.group.name)}, ${esc(plan.isrid.ecoregion.toLowerCase())} ${srcTag(plan.isrid.basis)}: ${isridRings}.</p>` : ''}
      ${hasIpp ? terrainEvidence() : ''}

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
      <h4>Why these tasks</h4>
      ${tacticList([...plan.tactics.category, ...plan.tactics.immediate])}
      ${immediateStats()}

      <h4>Live percentiles and outcome</h4>
      <table class="lpb-table"><tbody>${profile.distanceKm.map((d) => `<tr class="${d.pct === 100 ? 'muted' : ''}"><td>${d.pct} %</td><td>found within</td><td class="num">${km(d.km)}</td><td class="muted small">${d.pct === 100 ? 'furthest case, not drawn' : ''}</td></tr>`).join('')}</tbody></table>
      ${bars(outcomeShares(profile), 'outcome')}
      ${profile.notes.length ? profile.notes.map((n) => `<p class="small lpb-note">${esc(n)}</p>`).join('') : ''}
      ${plan.study?.notes.length ? `<p class="muted small">2011 study notes:</p>${plan.study.notes.map((n) => `<p class="small lpb-note">${esc(n)}</p>`).join('')}` : ''}
      <p class="muted small">Sources: ${plan.sources.map(esc).join(' ')} <a href="${esc(profile.sourceUrl)}" target="_blank" rel="noopener">Live page</a></p>
    </div>${attribution}</details>`;
  wireTabs(el);
  const ev = el.querySelector<HTMLDetailsElement>('#lpb-evidence')!;
  ev.open = evidenceOpen;
  ev.addEventListener('toggle', () => { evidenceOpen = ev.open; });
  el.querySelector<HTMLSelectElement>('#lpb-terrain')!.addEventListener('change', (e) => renderPlan(el, s, hasIpp, attribution, a, (e.target as HTMLSelectElement).value));
  el.querySelector('#lpb-fit')?.addEventListener('click', () => a.fitRings());
  const segById = (id: string) => area?.segments?.find((x) => x.id === id);
  el.querySelectorAll<HTMLButtonElement>('[data-seg-locate]').forEach((b) => b.addEventListener('click', () => {
    const seg = segById(b.dataset.segLocate!);
    const ring = seg?.targetRing ?? [];
    if (!ring.length) return;
    a.locate(ring.reduce((t, p) => t + p[0], 0) / ring.length, ring.reduce((t, p) => t + p[1], 0) / ring.length, 16);
  }));
  el.querySelectorAll<HTMLSelectElement>('[data-seg-target]').forEach((sel) => sel.addEventListener('change', async () => {
    const seg = segById(sel.dataset.segTarget!);
    if (!sel.value || !seg) return;
    sel.disabled = true;
    if (!(await segmentToTarget(seg, sel.value === 'none' ? null : Number(sel.value)))) sel.disabled = false;
  }));
  el.querySelectorAll<HTMLElement>('tr:has([data-seg-locate])').forEach((tr) => {
    const id = tr.querySelector<HTMLElement>('[data-seg-locate]')!.dataset.segLocate!;
    tr.addEventListener('mouseenter', () => a.highlight(segById(id)?.geometry));
    tr.addEventListener('mouseleave', () => a.highlight(undefined));
  });
}

/**
 * Make a terrain segment an area target, for a team or for later. Name and notes are read by
 * crew: plain ground, size and how to search it; the probability stays on the console.
 */
export async function segmentToTarget(seg: SearchSegment, teamId: number | null): Promise<boolean> {
  const incId = cs.s.search?.incident?.id;
  const area = cs.s.searchArea?.area;
  if (!incId || seg.targetRing.length < 4) return false;
  try {
    await post(`/api/incidents/${incId}/targets`, {
      name: `${seg.id} · ${ground(seg.dominant)}`.slice(0, 60),
      kind: 'area',
      geometry: { type: 'Polygon', coordinates: [seg.targetRing] },
      priority: seg.rank <= 3 ? 1 : seg.rank <= 6 ? 2 : 3,
      teamId,
      segmentId: seg.id,
      notes: `Mostly ${ground(seg.dominant).toLowerCase()}, ${areaText(seg.areaKm2)}.${seg.rank === 1 && (area?.atPointPct ?? 0) > 0 ? ' Holds the last known position: search it closely, including cover.' : ''}`,
    });
    const team = (cs.s.search?.teams ?? []).find((t) => t.id === teamId);
    toast(team ? `${seg.id} assigned to ${team.name}` : `${seg.id} added as a target`);
    return true;
  } catch (e) {
    toast(e instanceof Error ? e.message : 'failed', true);
    return false;
  }
}

/** Segment ids already made into targets (a segment target's name starts with its id). */
export function segmentsTaken(): Set<string> {
  return new Set((cs.s.search?.targets ?? []).filter((t) => t.status !== 'cancelled').map((t) => t.segmentId ?? /^(S\d+)\b/.exec(t.name)?.[1]).filter(Boolean) as string[]);
}

/** Whether the evidence section is open; kept across re-renders. */
let evidenceOpen = false;

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
  root.querySelectorAll<HTMLButtonElement>('[data-pt-locate]').forEach((b) => b.addEventListener('click', () => { const p = pointById(Number(b.dataset.ptLocate)); if (p) a.locate(p.lon, p.lat, 16); }));
  root.querySelectorAll<HTMLButtonElement>('[data-pt-move]').forEach((b) => b.addEventListener('click', () => { const p = pointById(Number(b.dataset.ptMove)); if (p) a.pickPoint(p.kind, p.id); }));
  root.querySelectorAll<HTMLButtonElement>('[data-pt-del]').forEach((b) => b.addEventListener('click', async () => {
    const p = pointById(Number(b.dataset.ptDel));
    if (p && (await confirmBox(`Remove ${POINT_KIND_LABEL[p.kind]}${p.label ? ` "${p.label}"` : ''}?`, 'Remove'))) await del(`/api/points/${p.id}`);
  }));
  root.querySelector<HTMLButtonElement>('[data-action=new-team]')?.addEventListener('click', async () => { if (incidentId) await post(`/api/incidents/${incidentId}/teams`, {}); });
  root.querySelectorAll<HTMLInputElement>('[data-rename]').forEach((i) => {
    i.addEventListener('change', async () => { await patch(`/api/teams/${i.dataset.rename}`, { name: i.value }).catch((e) => toast(e instanceof Error ? e.message : 'failed', true)); });
    i.addEventListener('blur', () => setTimeout(refresh));
    i.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') i.blur(); });
  });
  root.querySelectorAll<HTMLSelectElement>('[data-team-status]').forEach((s) => s.addEventListener('change', async () => { await patch(`/api/teams/${s.dataset.teamStatus}`, { status: s.value }); }));
  root.querySelectorAll<HTMLButtonElement>('[data-team-settings]').forEach((b) => b.addEventListener('click', () => { const t = search!.teams.find((x) => x.id === Number(b.dataset.teamSettings)); if (t) teamSettingsModal(t); }));
  root.querySelectorAll<HTMLButtonElement>('[data-fit-team]').forEach((b) => b.addEventListener('click', () => { const t = search!.teams.find((x) => x.id === Number(b.dataset.fitTeam)); if (t) a.fitTeam(t); }));
  root.querySelectorAll<HTMLButtonElement>('[data-del-team]').forEach((b) => b.addEventListener('click', async () => { if (await confirmBox('Delete this team? Members are released, targets unassigned.', 'Delete team')) await del(`/api/teams/${b.dataset.delTeam}`); }));
  if (cs.s.tab === 'teams' && root.querySelector('.team, .waiting')) wireTeamBoard(root, a.locate);
  root.querySelectorAll<HTMLButtonElement>('[data-draw]').forEach((b) => b.addEventListener('click', () => a.startDraw(b.dataset.draw as 'point' | 'area' | 'line')));
  root.querySelector<HTMLButtonElement>('[data-action=cancel-draw]')?.addEventListener('click', () => a.stopEditing());
  root.querySelector<HTMLButtonElement>('[data-action=stop-edit]')?.addEventListener('click', () => a.stopEditing());
  root.querySelectorAll<HTMLElement>('.target[data-target]').forEach((row) => {
    const t = search?.targets.find((x) => x.id === Number(row.dataset.target));
    row.addEventListener('mouseenter', () => a.highlight(t?.geometry as GeoJSON.Geometry | undefined));
    row.addEventListener('mouseleave', () => a.highlight(undefined));
  });
  root.querySelectorAll<HTMLElement>('[data-zoom-target]').forEach((b) => b.addEventListener('click', () => {
    const t = search!.targets.find((x) => x.id === Number(b.dataset.zoomTarget));
    if (!t) return;
    const pts = t.geometry.type === 'Point' ? [t.geometry.coordinates] : t.geometry.type === 'LineString' ? t.geometry.coordinates : t.geometry.coordinates[0];
    const lon = pts.reduce((s, c) => s + c[0], 0) / pts.length, lat = pts.reduce((s, c) => s + c[1], 0) / pts.length;
    a.locate(lon, lat, t.geometry.type === 'Point' ? 16 : 15);
  }));
  root.querySelectorAll<HTMLButtonElement>('[data-target-step]').forEach((b) => b.addEventListener('click', async () => {
    const [id, status] = b.dataset.targetStep!.split(':');
    if (status === 'done') {
      // how thorough was it? the answer moves probability to the segments not yet searched
      const t = search?.targets.find((x) => x.id === Number(id));
      if (t) await askPod(t, async (pod) => { await patch(`/api/targets/${id}`, { status: 'done', pod }); });
      return;
    }
    b.disabled = true;
    await patch(`/api/targets/${id}`, { status });
  }));
  root.querySelectorAll<HTMLSelectElement>('[data-assign-target]').forEach((sel) => sel.addEventListener('change', async () => { if (sel.value) await patch(`/api/targets/${sel.value}`, { teamId: Number(sel.dataset.assignTarget) }); }));
  root.querySelectorAll<HTMLSelectElement>('[data-target-status]').forEach((s) => s.addEventListener('change', async () => { await patch(`/api/targets/${s.dataset.targetStatus}`, { status: s.value }); }));
  root.querySelectorAll<HTMLSelectElement>('[data-target-team]').forEach((s) => s.addEventListener('change', async () => { await patch(`/api/targets/${s.dataset.targetTeam}`, { teamId: s.value ? Number(s.value) : null }); }));
  root.querySelectorAll<HTMLButtonElement>('[data-del-target]').forEach((b) => b.addEventListener('click', async () => { if (await confirmBox('Delete this target?', 'Delete')) await del(`/api/targets/${b.dataset.delTarget}`); }));
  root.querySelectorAll<HTMLButtonElement>('[data-edit-target]').forEach((b) => b.addEventListener('click', () => { const t = search!.targets.find((x) => x.id === Number(b.dataset.editTarget)); if (t) a.editTarget(t); }));
}
