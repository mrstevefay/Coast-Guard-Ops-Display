import '../components.css';
import './sm.css';
import { buildPlan } from '../../../shared/lpb/index';
import { POINT_KIND_LABEL, type Fix, type IncidentSubject, type PlanningPointKind, type Principal, type SearchAreaResult, type Target, type TargetGeometry, type Team, type UserPublic } from '../../../shared/types';
import { ApiError, get, patch, post, setUnauthorisedHandler } from '../api';
import { esc, fmtElapsed, fmtTime } from '../format';
import { OpsMap } from '../map';
import { renderLogin } from '../m/pages/login';
import { toast } from '../m/ui';
import { WsClient } from '../ws';
import { TargetDrawing, type DrawKind } from './draw';
import { historyMapResize, leaveHistory, renderHistory } from './history';
import { closeModal, modal, modalOpen } from './modal';
import { isSettingsSection, renderSettings } from './settings';
import { renderSidebar } from './sidebar';
import { cs } from './state';

const app = document.getElementById('app')!;
let ws: WsClient | undefined;
let map: OpsMap | undefined;
let drawing: TargetDrawing | undefined;
let mapEl: HTMLElement | undefined;

async function boot(): Promise<void> {
  setUnauthorisedHandler(() => showLogin());
  try {
    const me = await get<{ principal: Principal; user?: UserPublic }>('/api/auth/me');
    if (me.principal.kind === 'open') return void (app.innerHTML = '<div class="sm-boot">The console needs accounts (AUTH_OPEN=false). This server runs in open mode.</div>');
    if (!me.user) return showLogin();
    cs.s.me = me.user;
    cs.s.principal = me.principal;
    start();
  } catch {
    showLogin();
  }
}

function showLogin(): void {
  ws?.stop();
  app.className = 'm';
  renderLogin(app, (user) => {
    cs.s.me = user;
    cs.s.principal = { kind: 'user', userId: user.id, role: user.role, name: user.name };
    app.className = '';
    start();
  });
}

function start(): void {
  if (!cs.isManager) {
    app.innerHTML = `<div class="sm-boot">Search manager console is for managers and admins. You are signed in as ${esc(cs.s.me?.name ?? '')} (${esc(cs.s.me?.role ?? '')}). <a href="/m/">Open the crew app</a>.</div>`;
    return;
  }
  app.innerHTML = `
    <header class="sm-top">
      <div class="sm-brand">Howth CG · Search Manager</div>
      <div id="sm-incident" class="sm-incident"></div>
      <div class="sm-actions" id="sm-actions"></div>
      <a class="btn-sm sm-view" id="sm-history-btn" href="#history" title="Past taskings and callouts: replay and reports">History</a>
      <button class="btn-sm sm-view" id="sm-view" title="Settings & administration">⚙ Settings</button>
    </header>
    <aside class="sm-side" id="sm-side"></aside>
    <main class="sm-map" id="sm-map-wrap">
      <div class="layer-panel" id="layer-panel"></div>
      <div class="draw-hint" id="draw-hint"></div>
    </main>
    <section class="sm-settings" id="sm-settings"></section>
    <section class="sm-history" id="sm-history"></section>
    <footer class="sm-status" id="sm-status"></footer>
    <div id="modal"></div>`;
  mapEl = document.createElement('div');
  mapEl.className = 'sm-map-el';
  document.getElementById('sm-map-wrap')!.prepend(mapEl);
  document.getElementById('sm-view')!.addEventListener('click', () => {
    location.hash = cs.s.view === 'ops' ? `#settings/${cs.s.section}` : '#map';
  });
  window.addEventListener('hashchange', () => { readHash(); applyView(); });
  // A temporary password must be replaced before anything else.
  if (cs.s.me?.mustChangePassword) location.hash = '#settings/account';
  readHash();
  applyView();

  ws = new WsClient({
    onState: (s) => cs.onMessage({ type: 'state', state: s }),
    onConnection: (c) => { cs.s.connected = c; cs.notify(); },
    onMessage: (m) => { if (m.type !== 'state') cs.onMessage(m); },
    onAuthFail: () => showLogin(),
    reloadAfterMs: 0,
  });
  ws.start();
  cs.subscribe(render);
  document.addEventListener('keydown', onKey);
  setInterval(() => renderTop(), 1000);
}

// ---------------------------------------------------------------- views
/** #settings/<section> opens the administration pages; anything else is the map. */
function readHash(): void {
  const h = /^#history(?:\/([A-Za-z0-9-]+))?/.exec(location.hash);
  if (h) {
    cs.s.view = 'history';
    cs.s.historyId = h[1] || undefined;
    return;
  }
  const m = /^#settings(?:\/([a-z]+))?/.exec(location.hash);
  cs.s.view = m ? 'settings' : 'ops';
  if (m && isSettingsSection(m[1])) cs.s.section = m[1];
}

function applyView(): void {
  const settings = cs.s.view === 'settings';
  const history = cs.s.view === 'history';
  const wasSettings = app.classList.contains('settings');
  app.classList.toggle('settings', settings);
  app.classList.toggle('history', history);
  const b = document.getElementById('sm-view');
  if (b) b.textContent = settings || history ? '◀ Map' : '⚙ Settings';
  document.getElementById('sm-history-btn')?.classList.toggle('on', history);
  if (!history) leaveHistory();
  if (history) {
    closeModal();
    drawing?.stopEditing();
    renderHistory(document.getElementById('sm-history')!, cs.s.historyId);
    historyMapResize();
  } else if (settings) {
    closeModal();
    drawing?.stopEditing();
    // Coming from the map: reload the section so the data is fresh.
    renderSettings(document.getElementById('sm-settings')!, !wasSettings);
  } else {
    // The map may have been created while hidden (page opened on #settings).
    map?.resize();
  }
}

// ---------------------------------------------------------------- rendering
function render(): void {
  const s = cs.s.state;
  if (!s) return;
  if (!map) {
    map = new OpsMap({ interactive: true, search: true, autoFit: false, staleSec: 120, rings: true });
    map.mount(mapEl!, s);
    map.getMap()!.on('load', () => {
      drawing = new TargetDrawing(map!.getMap()!, {
        onFinished: (kind, geometry) => openTargetModal(kind, geometry),
        onEdited: async (id, geometry) => { await patch(`/api/targets/${id}`, { geometry }); },
        onModeChange: (mode) => { cs.s.editingTargetId = mode === 'select' ? drawing?.editingTargetId : undefined; renderDrawHint(mode); cs.notify(); },
      });
      // Planning points: one click on the map while armed places (or moves) a point.
      map!.getMap()!.on('click', (e) => {
        const pick = cs.s.picking;
        if (!pick) return;
        const inc = cs.s.search?.incident;
        setPicking(undefined);
        if (!inc) return;
        void placePoint(inc.id, pick, e.lngLat.lat, e.lngLat.lng);
      });
      applyLayers();
    });
  }
  map.update(s, cs.s.search);
  map.setTracks(cs.s.tracks, cs.s.search, 300);
  void ensureTracksLoaded();
  ensureSubjectLoaded();
  map.setBehaviourRings(cs.s.search?.incident?.ipp, behaviourRings());
  ensureSearchArea();
  const areaNow = cs.s.searchArea?.key === searchAreaKey() ? cs.s.searchArea?.area : undefined;
  if (areaNow !== shownArea) { map.setSearchArea(areaNow); shownArea = areaNow; applyLayers(); }
  renderTop();
  renderSidebar(document.getElementById('sm-side')!, {
    locate: (lon, lat, zoom) => map!.flyTo(lon, lat, zoom ?? 15),
    fitTeam: (team) => fitTeam(team),
    startDraw: (kind) => drawing?.setMode(kind),
    editTarget: (t) => drawing?.editTarget(t),
    stopEditing: () => drawing?.stopEditing(),
    drawMode: () => drawing?.mode ?? 'static',
    pickPoint: (kind, pointId) => setPicking(cs.s.picking && cs.s.picking.kind === kind && cs.s.picking.pointId === pointId ? undefined : { kind, pointId }),
    fitRings: () => map?.fitBehaviourRings(),
  });
  renderLayers();
  renderStatus();
  if (cs.s.layers.follow && cs.s.search?.incident) map.fitAll(s, cs.s.search);
}

/** Distance rings for the map from the subject's behaviour plan (25/50/75/90 % where the data allows). */
function behaviourRings(): { pct: number; km: number }[] {
  const s = cs.s.subject;
  if (!s?.category) return [];
  const plan = buildPlan({ category: s.category, terrain: s.terrain, sex: s.sex, age: s.age, suicideThreatened: s.suicideThreatened, previousAttempts: s.selfHarmHistory, depression: s.depression, significantPlaceKnown: s.significantPlaceKnown || hasSignificantPoint() });
  return plan?.rings.items.map((r) => ({ pct: r.pct, km: r.km })) ?? [];
}

let shownArea: SearchAreaResult | undefined;

/** What the terrain area depends on: the planning point and every subject field the rings use. */
function searchAreaKey(): string | undefined {
  const inc = cs.s.search?.incident, s = cs.s.subject;
  if (!inc?.ipp || !s?.category) return undefined;
  const sig = (inc.points ?? []).filter((p) => p.kind === 'significant').map((p) => `${p.lat},${p.lon}`).join(';');
  return [inc.id, inc.ipp.lat, inc.ipp.lon, s.category, s.sex, s.age, s.terrain, s.suicideThreatened, s.depression, s.selfHarmHistory, s.significantPlaceKnown, sig].join('|');
}

/** Fetch the terrain-shaped area when its inputs change. Errors (not built, no point) are kept for the plan card. */
function ensureSearchArea(): void {
  const key = searchAreaKey();
  if (!key) { if (cs.s.searchArea) { cs.s.searchArea = undefined; } return; }
  if (cs.s.searchArea?.key === key) return;
  const incId = cs.s.search!.incident!.id;
  cs.s.searchArea = { key, loading: true };
  get<{ area: SearchAreaResult }>(`/api/incidents/${incId}/search-area`)
    .then((r) => { if (cs.s.searchArea?.key === key) { cs.s.searchArea = { key, loading: false, area: r.area }; cs.notify(); } })
    .catch((e) => { if (cs.s.searchArea?.key === key) { cs.s.searchArea = { key, loading: false, error: e instanceof Error ? e.message : 'failed', status: e instanceof ApiError ? e.status : undefined }; cs.notify(); } });
}

/** Fetch the subject record when the incident or its `subjectUpdatedAt` changes (never in the WS snapshot). */
function ensureSubjectLoaded(): void {
  const inc = cs.s.search?.incident;
  if (!inc) {
    if (cs.s.subjectKey !== undefined) { cs.s.subject = undefined; cs.s.subjectKey = undefined; }
    return;
  }
  const key = `${inc.id}:${inc.subjectUpdatedAt ?? ''}`;
  if (cs.s.subjectKey === key) return;
  cs.s.subjectKey = key;
  if (!inc.subjectUpdatedAt) { cs.s.subject = null; return; }
  get<{ subject: IncidentSubject | null }>(`/api/incidents/${inc.id}/subject`)
    .then((r) => { if (cs.s.subjectKey === key) { cs.s.subject = r.subject; cs.notify(); } })
    .catch(() => { if (cs.s.subjectKey === key) cs.s.subjectKey = undefined; });
}

/** A significant place marked on the map counts as "significant place known" for the plan. */
export function hasSignificantPoint(): boolean {
  return (cs.s.search?.incident?.points ?? []).some((p) => p.kind === 'significant');
}

function setPicking(pick: { kind: PlanningPointKind; pointId?: number } | undefined): void {
  cs.s.picking = pick;
  document.getElementById('sm-map-wrap')?.classList.toggle('picking', Boolean(pick));
  const hint = document.getElementById('draw-hint');
  if (hint && pick) {
    hint.textContent = `Click the map to ${pick.pointId ? 'move' : 'place'}: ${POINT_KIND_LABEL[pick.kind]} (Esc to cancel)`;
    hint.style.display = 'block';
  } else if (hint && !pick && drawing?.mode === 'static') hint.style.display = 'none';
  cs.notify();
}

const POINT_PROMPT: Record<PlanningPointKind, string> = {
  lkp: 'Label for the last known position (optional, e.g. "Car park", "Phone ping")',
  pls: 'Label for the place last seen (optional, e.g. "Seen by dog walker")',
  home: 'Label for home (optional, e.g. "Home", "Care home")',
  vehicle: 'Label for the vehicle (optional, e.g. "Silver Golf 12-D-…")',
  significant: 'What is this place to them? (e.g. "Favourite bench", "Where his wife\'s ashes were scattered")',
  other: 'Label for this point',
};

async function placePoint(incidentId: string, pick: { kind: PlanningPointKind; pointId?: number }, lat: number, lon: number): Promise<void> {
  try {
    if (pick.pointId) {
      await patch(`/api/points/${pick.pointId}`, { lat, lon });
      toast(`${POINT_KIND_LABEL[pick.kind]} moved`);
      return;
    }
    const label = prompt(POINT_PROMPT[pick.kind], '');
    if (label === null) return; // cancelled
    await post(`/api/incidents/${incidentId}/points`, { kind: pick.kind, label, lat, lon });
    toast(`${POINT_KIND_LABEL[pick.kind]} set`);
  } catch (err) {
    toast(err instanceof Error ? err.message : 'failed', true);
  }
}

function renderTop(): void {
  const s = cs.s.state;
  const searchInc = cs.s.search?.incident;
  const callout = s?.mode.mode === 'callout' ? s.mode.incident : undefined;
  const inc = searchInc ?? callout;
  const el = document.getElementById('sm-incident');
  const actions = document.getElementById('sm-actions');
  if (!el || !actions) return;
  if (inc) {
    const tasking = searchInc?.kind === 'tasking' && !callout;
    const startedAt = tasking ? searchInc!.startedAt : inc.receivedAt;
    el.innerHTML = `<span class="mode-tag ${tasking ? 'mode-tasking' : 'mode-callout'}">${tasking ? 'TASKING' : 'CALLOUT'}</span><span class="elapsed ${tasking ? 'tasking' : ''}">${fmtElapsed(Date.now() - Date.parse(startedAt))}</span><span class="inc-txt" title="${esc(inc.text)}">${esc(inc.text)}</span><span class="muted">${fmtTime(startedAt)}</span>`;
    const modeKey = `${tasking ? 'tasking' : 'callout'}:${inc.id}`;
    if (actions.dataset.mode !== modeKey) {
      actions.dataset.mode = modeKey;
      actions.innerHTML = `<a class="btn-sm" href="/api/incidents/${esc(inc.id)}/export.geojson" download>Export</a><button class="btn-sm danger" id="standdown">${tasking ? 'Close tasking' : 'Stand down'}</button><a class="btn-sm" href="/m/" target="_blank">Crew app</a>`;
      actions.querySelector('#standdown')!.addEventListener('click', async () => {
        if (confirm(tasking ? 'Close this tasking? Teams are stood down and tracking stops.' : 'Stand down this incident? Teams are stood down and tracking stops.')) await post(`/api/incidents/${inc.id}/close`);
      });
    }
  } else {
    el.innerHTML = `<span class="mode-tag mode-standby">STANDBY</span><span class="muted">No open tasking</span>`;
    if (actions.dataset.mode !== 'standby') {
      actions.dataset.mode = 'standby';
      actions.innerHTML = `<button class="btn-sm primary" id="new-incident">New tasking</button><a class="btn-sm" href="/m/" target="_blank">Crew app</a>`;
      actions.querySelector('#new-incident')!.addEventListener('click', () => openIncidentModal());
    }
  }
}

function renderLayers(): void {
  const el = document.getElementById('layer-panel')!;
  if (el.dataset.built) return;
  el.dataset.built = '1';
  const L = cs.s.layers;
  el.innerHTML = (Object.keys(L) as (keyof typeof L)[]).map((k) => `<label><input type="checkbox" data-layer="${k}" ${L[k] ? 'checked' : ''}/> ${k[0].toUpperCase() + k.slice(1)}</label>`).join('') + `<button class="mini" id="fit-all" title="Fit everything">⤢</button>`;
  el.querySelectorAll<HTMLInputElement>('[data-layer]').forEach((c) => c.addEventListener('change', () => { (L as any)[c.dataset.layer!] = c.checked; applyLayers(); }));
  el.querySelector('#fit-all')!.addEventListener('click', () => { if (cs.s.state) map?.fitAll(cs.s.state, cs.s.search); });
}

function applyLayers(): void {
  if (!map) return;
  const L = cs.s.layers;
  map.setLayerVisible('tracks-line', L.tracks);
  map.setLayerVisible('coverage-line', L.coverage);
  for (const id of ['targets-fill', 'targets-line', 'targets-point'] as const) map.setLayerVisible(id, L.targets);
  for (const id of ['behaviour-fill', 'behaviour-line'] as const) map.setLayerVisible(id, L.behaviour);
  for (const id of ['area-fill', 'area-line', 'segment-line', 'corridor-line'] as const) map.setLayerVisible(id, L.terrain);
  map.setLayerVisible('heat', L.heat);
  map.setLayerVisible('ais-dot', L.ais);
  map.setLayerVisible('labels', L.labels);
  map.setLayerVisible('topo', L.topo);
}

function renderDrawHint(mode: string): void {
  const el = document.getElementById('draw-hint')!;
  const text = { point: 'Click the map to place a point target', area: 'Click to add corners; click the first point to close the area', line: 'Click to add points; click the last point again to finish', select: 'Drag the shape or its vertices; press Done when finished', static: '' }[mode] ?? '';
  el.textContent = text;
  el.style.display = text ? 'block' : 'none';
}

function renderStatus(): void {
  const el = document.getElementById('sm-status')!;
  const stale = Object.values(cs.s.search?.latest ?? {}).filter((f) => Date.now() / 1000 - f.tst > 120);
  el.innerHTML = `<span class="${cs.s.connected ? 'green' : 'amber'}">● ${cs.s.connected ? 'live' : 'reconnecting'}</span>
    <span>${cs.s.fixTimes.length} fixes/min</span>
    <span>${Object.keys(cs.s.search?.latest ?? {}).length} phones</span>
    ${stale.length ? `<span class="amber">stale: ${stale.map((f) => esc(f.callsign ?? f.name)).join(', ')}</span>` : ''}
    <span class="muted right">${esc(cs.s.me?.name ?? '')} · ${esc(cs.s.me?.role ?? '')}</span>`;
}

function fitTeam(team: Team): void {
  const fixes = team.members.map((m) => cs.s.search?.latest[m.userId]).filter(Boolean) as Fix[];
  if (!fixes.length) return toast('No positions for this team yet', true);
  const lons = fixes.map((f) => f.lon), lats = fixes.map((f) => f.lat);
  const m = map?.getMap();
  m?.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: 80, maxZoom: 16, duration: 500 });
}

// ---------------------------------------------------------------- tracks history
async function ensureTracksLoaded(): Promise<void> {
  const inc = cs.s.search?.incident;
  if (!inc || cs.s.loadedIncidentId === inc.id) return;
  cs.s.loadedIncidentId = inc.id;
  try {
    const fc = await get<{ features: { properties: { userId: number | null; teamId: number | null; from: number; to: number; callsign?: string; name?: string }; geometry: { coordinates: [number, number, number | null][] } }[] }>(`/api/incidents/${inc.id}/tracks`);
    const byUser = new Map<number, Fix[]>();
    for (const f of fc.features) {
      const uid = f.properties.userId;
      if (uid === null) continue;
      const n = f.geometry.coordinates.length;
      const span = Math.max(1, f.properties.to - f.properties.from);
      f.geometry.coordinates.forEach((c, i) => {
        const arr = byUser.get(uid) ?? [];
        arr.push({ userId: uid, deviceId: 0, name: f.properties.name ?? '', callsign: f.properties.callsign, teamId: f.properties.teamId ?? undefined, lat: c[1], lon: c[0], alt: c[2] ?? undefined, tst: f.properties.from + Math.round((span * i) / Math.max(1, n - 1)), at: '' });
        byUser.set(uid, arr);
      });
    }
    // keep anything newer already received live
    for (const [uid, live] of cs.s.tracks) {
      const hist = byUser.get(uid) ?? [];
      const lastHist = hist.length ? hist[hist.length - 1].tst : 0;
      byUser.set(uid, [...hist, ...live.filter((f) => f.tst > lastHist)]);
    }
    cs.s.tracks = byUser;
    cs.notify();
  } catch (e) {
    toast(`Could not load tracks: ${e instanceof Error ? e.message : e}`, true);
  }
}

// ---------------------------------------------------------------- modals
function openTargetModal(kind: DrawKind, geometry: TargetGeometry): void {
  const teams = cs.s.search?.teams ?? [];
  const n = (cs.s.search?.targets.length ?? 0) + 1;
  const root = modal(`<h3>New ${kind} target</h3>
    <form id="tf">
      <label>Name <input name="name" value="T${n}" autofocus /></label>
      <label>Assign to <select name="teamId"><option value="">— unassigned —</option>${teams.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select></label>
      <label>Priority <select name="priority"><option value="1">1 — high</option><option value="2" selected>2 — normal</option><option value="3">3 — low</option></select></label>
      <label>Notes <textarea name="notes" rows="3" placeholder="What to look for, hazards, access…"></textarea></label>
      <div class="modal-actions"><button type="button" class="btn-sm" id="cancel">Cancel</button><button type="submit" class="btn-sm primary">Create target</button></div>
    </form>`);
  root.querySelector('#cancel')!.addEventListener('click', closeModal);
  root.querySelector<HTMLFormElement>('#tf')!.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.target as HTMLFormElement);
    const inc = cs.s.search?.incident;
    if (!inc) return toast('No open incident', true);
    try {
      await post(`/api/incidents/${inc.id}/targets`, { kind, geometry, name: f.get('name'), teamId: f.get('teamId') ? Number(f.get('teamId')) : null, priority: Number(f.get('priority')), notes: f.get('notes') });
      closeModal();
      cs.s.tab = 'targets';
    } catch (e) {
      toast(e instanceof Error ? e.message : 'failed', true);
    }
  });
}

function openIncidentModal(): void {
  const root = modal(`<h3>New tasking</h3>
    <p class="muted">Opens the search (responders, teams, targets, tracking) for the crew app and this console. The TV stays in standby and nobody is paged unless you tick the callout box.</p>
    <form id="if">
      <label>Tasking title / details <textarea name="text" rows="3" required placeholder="e.g. Missing walker, Howth Head cliff path — request from Gardaí"></textarea></label>
      <label>Position (optional) <input name="pos" placeholder="53.4105, -6.0550" /></label>
      <label class="check"><input type="checkbox" name="callout" /> Also raise a <b>callout</b>: TV to callout mode, crew app alert, auto stand-down timer (as the pager does)</label>
      <div class="modal-actions"><button type="button" class="btn-sm" id="cancel">Cancel</button><button type="submit" class="btn-sm primary" id="start">Start tasking</button></div>
    </form>`);
  root.querySelector('#cancel')!.addEventListener('click', closeModal);
  const cb = root.querySelector<HTMLInputElement>('input[name=callout]')!;
  const start = root.querySelector<HTMLButtonElement>('#start')!;
  cb.addEventListener('change', () => { start.textContent = cb.checked ? 'CALLOUT' : 'Start tasking'; start.className = `btn-sm ${cb.checked ? 'danger' : 'primary'}`; });
  root.querySelector<HTMLFormElement>('#if')!.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.target as HTMLFormElement);
    const pos = String(f.get('pos') ?? '').split(',').map((x) => Number(x.trim()));
    try {
      await post('/api/incidents', { text: f.get('text'), callout: cb.checked, lat: pos.length === 2 && Number.isFinite(pos[0]) ? pos[0] : undefined, lon: pos.length === 2 && Number.isFinite(pos[1]) ? pos[1] : undefined });
      closeModal();
      cs.s.tab = 'responders';
    } catch (e) {
      toast(e instanceof Error ? e.message : 'failed', true);
    }
  });
}

function onKey(ev: KeyboardEvent): void {
  if ((ev.target as HTMLElement).matches('input, textarea, select')) return;
  const k = ev.key.toLowerCase();
  if (k === 'escape' && modalOpen()) return closeModal();
  if (k === 'escape' && cs.s.picking) return setPicking(undefined);
  if (cs.s.view !== 'ops' || !drawing) return;
  if (k === 'escape') drawing.stopEditing();
  else if (k === 'p') drawing.setMode('point');
  else if (k === 'a') drawing.setMode('area');
  else if (k === 'l') drawing.setMode('line');
}

export type { Target };
// Debug handle (no secrets): window.__sm.cs.s, window.__sm.map()
(window as any).__sm = { cs, map: () => map };
void boot();
