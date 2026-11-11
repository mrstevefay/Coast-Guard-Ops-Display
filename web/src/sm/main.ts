import '../components.css';
import './sm.css';
import { buildPlan } from '../../../shared/lpb/index';
import { MANAGER_POINT_KINDS, POINT_KIND_LABEL, POINT_KIND_SHORT, type IncidentOutcome, type Fix, type IncidentSubject, type PlanningPointKind, type Principal, type SearchAreaResult, type Target, type TargetGeometry, type Team, type UserPublic } from '../../../shared/types';
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
import { currentPoa, GROUND_NAME, renderSidebar, segmentToTarget, segmentsTaken } from './sidebar';
import { attachLocationSearch, type LocationPick } from './locate';
import { contactsCount, contactsOnUpdate, contactsOpen, toggleContacts } from './contacts';
import { openOutcome } from './outcome';
import maplibregl from 'maplibre-gl';
import { cs, LAYER_LABEL, LAYER_PRESETS, type LayerPreset } from './state';

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
      <div class="sm-close" id="sm-close"></div>
    </header>
    <aside class="sm-side" id="sm-side"></aside>
    <main class="sm-map" id="sm-map-wrap">
      <div class="layer-panel" id="layer-panel"></div>
      <div class="map-search"><input id="map-search" type="search" placeholder="Search a place or paste a position" aria-label="Search a place or paste a position" /></div>
      <div class="draw-hint" id="draw-hint"></div>
      <div class="find-alerts" id="find-alerts"></div>
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
  attachLocationSearch(document.getElementById('map-search') as HTMLInputElement, {
    near: () => cs.s.search?.incident?.ipp ?? (cs.s.state ? { lat: cs.s.state.station.lat, lon: cs.s.state.station.lon } : undefined),
    onPick: (p) => placeFromSearch(p),
  });
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
        if (!pick) {
          // not placing a point or drawing: a click on a target or segment opens its card
          if ((drawing?.mode ?? 'static') === 'static') { const hit = map!.shapeAt(e.point); if (hit) openShapeCard(hit, e.lngLat); }
          return;
        }
        const inc = cs.s.search?.incident;
        setPicking(undefined);
        if (!inc) return;
        if (pick.pointId) void movePoint(pick, e.lngLat.lat, e.lngLat.lng);
        else openPointBox(e.lngLat.lat, e.lngLat.lng, pick.kind);
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
  announceFinds();
  contactsOnUpdate();
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
    highlight: (g) => map?.highlight(g),
  });
  presetForTab();
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
    hint.textContent = `Click the map, or search above, to ${pick.pointId ? 'move' : 'place'}: ${POINT_KIND_LABEL[pick.kind]} (Esc to cancel)`;
    if (!pick.pointId) (document.getElementById('map-search') as HTMLInputElement | null)?.focus();
    hint.style.display = 'block';
  } else if (hint && !pick && drawing?.mode === 'static') hint.style.display = 'none';
  cs.notify();
}

const POINT_HINT: Record<PlanningPointKind, string> = {
  lkp: 'Label, e.g. Car park, Phone ping',
  pls: 'Label, e.g. Seen by dog walker',
  home: 'Label, e.g. Home, Care home',
  vehicle: 'Label, e.g. Silver Golf 12-D-…',
  significant: 'What is this place to them?',
  other: 'Label',
  find: 'What was found',
};

async function movePoint(pick: { kind: PlanningPointKind; pointId?: number }, lat: number, lon: number): Promise<void> {
  try {
    await patch(`/api/points/${pick.pointId}`, { lat, lon });
    toast(`${POINT_KIND_LABEL[pick.kind]} moved`);
  } catch (err) {
    toast(err instanceof Error ? err.message : 'failed', true);
  }
}

let pointBox: maplibregl.Popup | undefined;

/**
 * The label box for a new point, opened on the map where it goes: kind, label and note in one
 * small form. Enter saves, Escape cancels. Replaces the browser's prompt box.
 */
function openPointBox(lat: number, lon: number, kind: PlanningPointKind, label = ''): void {
  const m = map?.getMap();
  const inc = cs.s.search?.incident;
  if (!m || !inc) return;
  pointBox?.remove();
  let chosen = kind;
  const el = document.createElement('form');
  el.className = 'pt-box';
  const chips = () => MANAGER_POINT_KINDS.map((k) => `<button type="button" class="pt-chip k-${k} ${k === chosen ? 'on' : ''}" data-k="${k}" title="${esc(POINT_KIND_LABEL[k])}">${esc(POINT_KIND_SHORT[k])}</button>`).join('');
  el.innerHTML = `<div class="pt-box-kind"><b id="pt-kind-name">${esc(POINT_KIND_LABEL[chosen])}</b></div>
    <div class="pt-chips">${chips()}</div>
    <input name="label" maxlength="120" value="${esc(label)}" placeholder="${esc(POINT_HINT[chosen])}" />
    <input name="note" maxlength="500" placeholder="Note (optional)" />
    <div class="pt-box-actions"><button type="submit" class="btn-sm primary">Save</button><button type="button" class="btn-sm" data-cancel>Cancel</button><span class="muted small">Enter saves</span></div>`;
  const wireChips = () => el.querySelectorAll<HTMLButtonElement>('[data-k]').forEach((b) => b.addEventListener('click', () => {
    chosen = b.dataset.k as PlanningPointKind;
    el.querySelector('.pt-chips')!.innerHTML = chips();
    el.querySelector('#pt-kind-name')!.textContent = POINT_KIND_LABEL[chosen];
    (el.querySelector('input[name=label]') as HTMLInputElement).placeholder = POINT_HINT[chosen];
    wireChips();
  }));
  wireChips();
  const close = () => { pointBox?.remove(); pointBox = undefined; };
  el.querySelector('[data-cancel]')!.addEventListener('click', close);
  el.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); close(); } });
  el.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = new FormData(el);
    try {
      await post(`/api/incidents/${inc.id}/points`, { kind: chosen, label: String(f.get('label') ?? '').trim() || null, note: String(f.get('note') ?? '').trim() || null, lat, lon });
      toast(`${POINT_KIND_LABEL[chosen]} set`);
      close();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'failed', true);
    }
  });
  pointBox = new maplibregl.Popup({ closeButton: false, closeOnClick: false, maxWidth: '280px', className: 'pt-popup', offset: 10 }).setLngLat([lon, lat]).setDOMContent(el).addTo(m);
  setTimeout(() => (el.querySelector('input[name=label]') as HTMLInputElement).focus(), 0);
}

/** A search result: go there and open the label box, with the kind the manager armed (or the obvious one). */
function placeFromSearch(p: LocationPick): void {
  const inc = cs.s.search?.incident;
  map?.flyTo(p.lon, p.lat, 16);
  if (!inc) return toast('Open a tasking first: then the search places points', true);
  const armed = cs.s.picking;
  if (armed?.pointId) { setPicking(undefined); void movePoint(armed, p.lat, p.lon); return; }
  const kind: PlanningPointKind = armed?.kind ?? (inc.points?.some((x) => x.kind === 'lkp') ? 'other' : 'lkp');
  setPicking(undefined);
  openPointBox(p.lat, p.lon, kind, p.label ?? '');
}

let shapeCard: maplibregl.Popup | undefined;

/** Card for a clicked target or segment: what it is, and the one or two things to do with it. */
function openShapeCard(hit: { kind: 'target'; id: number } | { kind: 'segment'; id: string }, at: maplibregl.LngLat): void {
  const m = map?.getMap();
  const search = cs.s.search;
  if (!m || !search?.incident) return;
  shapeCard?.remove();
  const teams = search.teams;
  const el = document.createElement('div');
  el.className = 'shape-card';
  const teamOptions = (sel?: number | null) => teams.map((t) => `<option value="${t.id}" ${t.id === sel ? 'selected' : ''}>${esc(t.name)}${t.status === 'forming' ? '' : ` · ${esc(t.status)}`}</option>`).join('');
  if (hit.kind === 'segment') {
    const seg = cs.s.searchArea?.area?.segments?.find((x) => x.id === hit.id);
    if (!seg) return;
    const taken = segmentsTaken().has(seg.id);
    el.innerHTML = `<b>${esc(seg.id)} · ${esc(GROUND_NAME[seg.dominant] ?? seg.dominant)}</b>
      <div class="muted small">${seg.areaKm2 < 1 ? `${Math.round(seg.areaKm2 * 100)} ha` : `${seg.areaKm2.toFixed(1)} km²`} · POA <b class="amber">${currentPoa(cs.s.searchArea!.area!).get(seg.id)?.nowPct ?? seg.poaPct} %</b> · ${esc(seg.band)}</div>
      ${taken ? '<div class="small muted">Already a target</div>' : `<select id="sc-assign"><option value="">Assign…</option>${teamOptions()}<option value="none">Target, no team yet</option></select>`}`;
    el.querySelector<HTMLSelectElement>('#sc-assign')?.addEventListener('change', async (ev) => {
      const v = (ev.target as HTMLSelectElement).value;
      if (v && (await segmentToTarget(seg, v === 'none' ? null : Number(v)))) shapeCard?.remove();
    });
  } else {
    const t = search.targets.find((x) => x.id === hit.id);
    if (!t) return;
    const team = teams.find((x) => x.id === t.teamId);
    el.innerHTML = `<b>${esc(t.name)}</b> <span class="badge-s ${t.status === 'in-progress' ? 'amber' : t.status === 'done' ? 'green' : 'grey'}">${esc(t.status)}</span>
      ${t.notes ? `<div class="muted small">${esc(t.notes)}</div>` : ''}
      <div class="sc-row"><select id="sc-team"><option value="">${team ? 'No team' : 'Assign…'}</option>${teamOptions(t.teamId)}</select><button class="btn-sm" id="sc-edit">Edit shape</button></div>`;
    el.querySelector<HTMLSelectElement>('#sc-team')!.addEventListener('change', async (ev) => {
      const v = (ev.target as HTMLSelectElement).value;
      await patch(`/api/targets/${t.id}`, { teamId: v ? Number(v) : null });
      shapeCard?.remove();
    });
    el.querySelector('#sc-edit')!.addEventListener('click', () => { shapeCard?.remove(); drawing?.editTarget(t); });
  }
  shapeCard = new maplibregl.Popup({ closeButton: true, closeOnClick: true, maxWidth: '280px', className: 'pt-popup' }).setLngLat(at).setDOMContent(el).addTo(m);
}

/** Finds reported by crew: announced on the console the moment they arrive, until acknowledged. */
let seenFinds: Set<number> | undefined;
function announceFinds(): void {
  if (!cs.s.search) return;
  const finds = (cs.s.search.incident?.points ?? []).filter((p) => p.kind === 'find');
  if (!seenFinds) { seenFinds = new Set(finds.map((p) => p.id)); return; }
  const fresh = finds.filter((p) => !seenFinds!.has(p.id));
  for (const p of fresh) seenFinds.add(p.id);
  if (!fresh.length) return;
  const host = document.getElementById('find-alerts')!;
  for (const p of fresh) {
    const box = document.createElement('div');
    box.className = `find-alert ${/^Subject found/.test(p.label ?? '') ? 'subject' : ''}`;
    box.innerHTML = `<b>${esc(p.label ?? 'Find')}</b> <span class="muted small">${fmtTime(p.setAt)}</span>${p.note ? `<div>${esc(p.note)}</div>` : ''}<div class="fa-actions"><button class="btn-sm primary" data-show>Show</button><button class="btn-sm" data-ack>OK</button></div>`;
    box.querySelector('[data-show]')!.addEventListener('click', () => map?.flyTo(p.lon, p.lat, 17));
    box.querySelector('[data-ack]')!.addEventListener('click', () => box.remove());
    host.prepend(box);
  }
}

/** Shown on every console screen while callout alerts are switched off: nobody should assume crew were alerted. */
function alertsOffBadge(): string {
  const a = cs.s.state?.alerts;
  if (!a || a.enabled) return '';
  const until = a.until ? ` until ${new Date(a.until).toLocaleString('en-IE', { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Europe/Dublin' })}` : '';
  return `<a class="alerts-off" href="#settings/alerts" title="Crew phones are not being alerted. Admins switch this under Settings → Callout alerts.">ALERTS OFF${esc(until)}</a>`;
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
    el.innerHTML = `<span class="mode-tag ${tasking ? 'mode-tasking' : 'mode-callout'}">${tasking ? 'TASKING' : 'CALLOUT'}</span><span class="elapsed ${tasking ? 'tasking' : ''}">${fmtElapsed(Date.now() - Date.parse(startedAt))}</span><span class="inc-txt" title="${esc(inc.text)}">${esc(inc.text)}</span><span class="muted">${fmtTime(startedAt)}</span>${alertsOffBadge()}`;
    const modeKey = `${tasking ? 'tasking' : 'callout'}:${inc.id}`;
    if (actions.dataset.mode !== modeKey) {
      actions.dataset.mode = modeKey;
      actions.innerHTML = `<button class="btn-sm" id="contacts-btn" title="Gardaí, MRCC, next of kin and the call log">Contacts <span class="tab-n" id="contacts-n"></span></button><a class="btn-sm" href="/api/incidents/${esc(inc.id)}/export.geojson" download>Export</a><a class="btn-sm" href="/m/" target="_blank">Crew app</a>`;
      actions.querySelector('#contacts-btn')!.addEventListener('click', () => { toggleContacts(); renderTop(); });
      const close = document.getElementById('sm-close')!;
      close.innerHTML = `<button class="btn-sm danger" id="standdown">${tasking ? 'Close tasking' : 'Stand down'}</button>`;
      // closing asks how it ended: the outcome builds the evidence base (skippable, editable in History)
      close.querySelector('#standdown')!.addEventListener('click', async () => {
        const label = tasking ? 'Close tasking' : 'Stand down';
        const existing = await get<{ outcome: IncidentOutcome | null }>(`/api/incidents/${inc.id}/outcome`).then((r) => r.outcome ?? undefined).catch(() => undefined);
        openOutcome({ incidentId: inc.id, points: cs.s.search?.incident?.points ?? [], existing, closing: { label, close: async () => { await post(`/api/incidents/${inc.id}/close`); } } });
      });
    }
    const n = contactsCount();
    const cn = document.getElementById('contacts-n');
    if (cn) { cn.textContent = n ? String(n) : ''; cn.hidden = !n; }
    document.getElementById('contacts-btn')?.classList.toggle('on', contactsOpen());
  } else {
    el.innerHTML = `<span class="mode-tag mode-standby">STANDBY</span><span class="muted">No open tasking</span>${alertsOffBadge()}`;
    if (actions.dataset.mode !== 'standby') {
      actions.dataset.mode = 'standby';
      actions.innerHTML = `<button class="btn-sm primary" id="new-incident">New tasking</button><a class="btn-sm" href="/m/" target="_blank">Crew app</a>`;
      document.getElementById('sm-close')!.innerHTML = '';
      actions.querySelector('#new-incident')!.addEventListener('click', () => openIncidentModal());
    }
  }
}

/** Layer bar: three presets for the stages of a search, plus a menu of single layers. */
function renderLayers(): void {
  const el = document.getElementById('layer-panel')!;
  const L = cs.s.layers;
  const mode = drawing?.mode ?? 'static';
  const key = `${cs.s.preset ?? ''}:${Object.values(L).join('')}:${mode}:${Boolean(cs.s.search?.incident)}`;
  if (el.dataset.key === key) return;
  const menuOpen = el.querySelector<HTMLDetailsElement>('details')?.open ?? false;
  el.dataset.key = key;
  el.innerHTML = (['plan', 'teams', 'clean'] as const).map((p) => `<button class="mini ${cs.s.preset === p ? 'on' : ''}" data-preset="${p}">${p[0].toUpperCase() + p.slice(1)}</button>`).join('')
    + `<details class="layer-menu" ${menuOpen ? 'open' : ''}><summary class="mini">Layers ▾</summary><div class="layer-list">${(Object.keys(L) as (keyof typeof L)[]).map((k) => `<label><input type="checkbox" data-layer="${k}" ${L[k] ? 'checked' : ''}/> ${LAYER_LABEL[k]}</label>`).join('')}</div></details>`
    + `<button class="mini" id="fit-all" title="Fit everything">⤢</button>`
    + (cs.s.search?.incident ? `<span class="lp-sep"></span>${(['point', 'area', 'line'] as const).map((k) => `<button class="mini ${mode === k ? 'on' : ''}" data-draw="${k}" title="Draw a ${k} target (${k[0].toUpperCase()})">${k === 'point' ? '● Point' : k === 'area' ? '▱ Area' : '⟋ Line'}</button>`).join('')}${mode !== 'static' ? '<button class="mini danger" data-draw="stop" title="Stop drawing (Esc)">Esc</button>' : ''}` : '');
  el.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach((b) => b.addEventListener('click', () => setPreset(b.dataset.preset as LayerPreset)));
  el.querySelectorAll<HTMLInputElement>('[data-layer]').forEach((c) => c.addEventListener('change', () => { (L as any)[c.dataset.layer!] = c.checked; cs.s.preset = undefined; applyLayers(); renderLayers(); }));
  el.querySelector('#fit-all')!.addEventListener('click', () => { if (cs.s.state) map?.fitAll(cs.s.state, cs.s.search); });
  el.querySelectorAll<HTMLButtonElement>('[data-draw]').forEach((b) => b.addEventListener('click', () => { const k = b.dataset.draw!; if (k === 'stop' || drawing?.mode === k) drawing?.stopEditing(); else drawing?.setMode(k as DrawKind); }));
}

function setPreset(p: LayerPreset): void {
  Object.assign(cs.s.layers, LAYER_PRESETS[p]);
  cs.s.preset = p;
  applyLayers();
  renderLayers();
}

/** Opening a stage's tab shows that stage's layers, unless the manager has picked layers by hand. */
let lastTab = cs.s.tab;
function presetForTab(): void {
  if (cs.s.tab === lastTab) return;
  lastTab = cs.s.tab;
  if (cs.s.preset === undefined) return;
  const p: LayerPreset | undefined = cs.s.tab === 'behaviour' ? 'plan' : cs.s.tab === 'teams' ? 'teams' : undefined;
  if (p && p !== cs.s.preset) setPreset(p);
}

function applyLayers(): void {
  if (!map) return;
  const L = cs.s.layers;
  map.setLayerVisible('tracks-line', L.tracks);
  map.setLayerVisible('coverage-line', L.coverage);
  for (const id of ['targets-fill', 'targets-line', 'targets-point'] as const) map.setLayerVisible(id, L.targets);
  for (const id of ['behaviour-fill', 'behaviour-line'] as const) map.setLayerVisible(id, L.behaviour);
  map.setLayerVisible('area-line', L.terrain);
  map.setLayerVisible('corridor-line', L.terrain);
  map.setLayerVisible('area-fill', L.terrain && L.areaFill);
  map.setLayerVisible('segment-line', L.segments);
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
      cs.s.tab = 'teams';
    } catch (e) {
      toast(e instanceof Error ? e.message : 'failed', true);
    }
  });
}

function openIncidentModal(): void {
  const root = modal(`<h3>New tasking</h3>
    <form id="if">
      <label>What and where <textarea name="text" rows="3" required autofocus placeholder="e.g. Missing walker, Howth Head cliff path, request from Gardaí"></textarea></label>
      <label>Last known position <span class="muted small">(optional: set it on the map later)</span>
        <span class="loc-wrap"><input id="if-pos" type="search" placeholder="Search a place or paste a position" /></span>
        <span class="small" id="if-pos-read"></span></label>
      <div class="start-pair">
        <button type="submit" class="btn-sm primary" data-callout="0"><b>Start tasking</b><small>Console and crew app only. Nobody is paged.</small></button>
        <button type="submit" class="btn-sm danger" data-callout="1"><b>Raise callout</b><small>Alerts crew, TV to callout mode, auto stand-down.</small></button>
      </div>
      <div class="modal-actions"><button type="button" class="btn-sm" id="cancel">Cancel</button></div>
    </form>`);
  root.querySelector('#cancel')!.addEventListener('click', closeModal);
  let pos: LocationPick | undefined;
  const read = root.querySelector<HTMLElement>('#if-pos-read')!;
  attachLocationSearch(root.querySelector<HTMLInputElement>('#if-pos')!, {
    near: () => (cs.s.state ? { lat: cs.s.state.station.lat, lon: cs.s.state.station.lon } : undefined),
    onPick: (p) => {
      pos = p;
      read.innerHTML = `Set: <b>${esc(p.label ?? `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`)}</b> <button type="button" class="mini" id="if-pos-clear">×</button>`;
      read.querySelector('#if-pos-clear')!.addEventListener('click', () => { pos = undefined; read.innerHTML = ''; });
    },
  });
  root.querySelector<HTMLFormElement>('#if')!.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const callout = (ev as SubmitEvent).submitter?.getAttribute('data-callout') === '1';
    const f = new FormData(ev.target as HTMLFormElement);
    try {
      await post('/api/incidents', { text: f.get('text'), callout, lat: pos?.lat, lon: pos?.lon, label: pos?.label });
      closeModal();
      cs.s.tab = 'subject';
    } catch (e) {
      toast(e instanceof Error ? e.message : 'failed', true);
    }
  });
}

function onKey(ev: KeyboardEvent): void {
  if ((ev.target as HTMLElement).matches('input, textarea, select')) return;
  const k = ev.key.toLowerCase();
  if (k === 'escape' && modalOpen()) return closeModal();
  if (k === 'escape' && pointBox) { pointBox.remove(); pointBox = undefined; return; }
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
