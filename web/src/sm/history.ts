/**
 * History: past (and the current) taskings and callouts — who was on what team, where the
 * teams covered, a replay from start to finish, and the end-of-mission report.
 */
import type { ConditionsSnapshot, DashboardState, Fix, IncidentReplay, IncidentSummary, SearchSnapshot } from '../../../shared/types';
import { get } from '../api';
import { esc, fmtDurationMin, fmtElapsed, fmtTime } from '../format';
import { OpsMap } from '../map';
import { cs } from './state';

interface ReportJson {
  durationMin: number;
  totals: { responders: number; onScene: number; teams: number; targetsDone: number; targetsTotal: number; trackKm: number; sweptKm2: number; fixes: number };
  responders: { userId: number; name: string; callsign?: string; team?: string; teamCallsign?: string; finalStatus: string; respondedAt?: string; responseMin?: number; onSceneAt?: string; toSceneMin?: number; onSceneMin?: number; trackKm: number }[];
  teams: { id: number; name: string; colour: string; status: string; searchWidthM: number; members: { name: string; callsign: string; leftAt?: string }[]; targets: string[]; firstFixAt?: string; lastFixAt?: string; searchingMin: number; trackKm: number; sweptKm2: number }[];
}

const dt = new Intl.DateTimeFormat('en-IE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Europe/Dublin' });
const hms = new Intl.DateTimeFormat('en-IE', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Europe/Dublin' });
const fmtDT = (iso?: string) => (iso ? dt.format(new Date(iso)) : '—');
const fmtMin = (m?: number) => (m === undefined ? '—' : fmtDurationMin(m));
const kindTag = (k: string) => `<span class="mode-tag ${k === 'tasking' ? 'mode-tasking' : 'mode-callout'}">${k === 'tasking' ? 'TASKING' : 'CALLOUT'}</span>`;

let map: OpsMap | undefined;
let mapEl: HTMLElement | undefined;
let replay: IncidentReplay | undefined;
let report: ReportJson | undefined;
let tab: 'summary' | 'timeline' | 'conditions' = 'summary';
let playing = false;
let speed = 60;
let T = 0; // replay cursor, unix seconds
let t0 = 0, t1 = 0;
let timer: number | undefined;
let renderedId = '';

export function renderHistory(root: HTMLElement, id: string | undefined): void {
  if (!id) {
    stopReplay();
    renderedId = '';
    root.innerHTML = `<div class="hist-list" id="hist-list"><div class="set-head"><h2>History</h2><span class="muted small">Taskings and callouts, newest first</span></div><p class="muted">Loading…</p></div><div class="hist-map"><p class="muted pad">Select an incident to see who was where, replay it and produce the report.</p></div>`;
    void loadList(root.querySelector('#hist-list')!);
    return;
  }
  if (renderedId === id) return;
  renderedId = id;
  stopReplay();
  root.innerHTML = `<div class="hist-side" id="hist-side"><p class="muted pad">Loading…</p></div><div class="hist-map" id="hist-map-wrap"><div class="replay-bar" id="replay-bar"></div></div>`;
  void loadDetail(root, id);
}

export function leaveHistory(): void {
  stopReplay();
  renderedId = '';
}

async function loadList(el: HTMLElement): Promise<void> {
  try {
    const { incidents } = await get<{ incidents: IncidentSummary[] }>('/api/incidents?limit=200');
    el.innerHTML = `<div class="set-head"><h2>History</h2><span class="muted small">${incidents.length} incidents</span></div>
      <table class="set-table hist-table"><thead><tr><th>Started</th><th></th><th>Title</th><th>Duration</th><th>Resp.</th><th>Teams</th><th>Targets</th></tr></thead><tbody>
      ${incidents.map((i) => `<tr data-id="${esc(i.id)}" class="${i.endedAt ? '' : 'open'}"><td class="nowrap">${fmtDT(i.startedAt)}</td><td>${kindTag(i.kind)}</td><td>${esc(i.text.slice(0, 90))}${i.endedAt ? '' : ' <span class="badge-s amber">open</span>'}</td><td>${i.endedAt ? fmtMin(Math.round((Date.parse(i.endedAt) - Date.parse(i.startedAt)) / 60000)) : '—'}</td><td>${i.responders}</td><td>${i.teams}</td><td>${i.targets}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">Nothing yet.</td></tr>'}
      </tbody></table>`;
    el.querySelectorAll<HTMLElement>('tr[data-id]').forEach((tr) => tr.addEventListener('click', () => (location.hash = `#history/${tr.dataset.id}`)));
  } catch (e) {
    el.innerHTML = `<p class="note error">${esc(e instanceof Error ? e.message : 'failed')}</p>`;
  }
}

async function loadDetail(root: HTMLElement, id: string): Promise<void> {
  const side = root.querySelector<HTMLElement>('#hist-side')!;
  try {
    [replay, report] = await Promise.all([get<IncidentReplay>(`/api/incidents/${id}/replay`), get<{ report: ReportJson }>(`/api/incidents/${id}/report`).then((r) => r.report)]);
  } catch (e) {
    side.innerHTML = `<p class="note error">${esc(e instanceof Error ? e.message : 'failed')}</p>`;
    return;
  }
  const inc = replay.incident;
  t0 = Math.floor(Date.parse(inc.startedAt) / 1000);
  t1 = Math.floor((inc.endedAt ? Date.parse(inc.endedAt) : Date.now()) / 1000);
  if (replay.fixes.length) {
    t0 = Math.min(t0, replay.fixes[0].t);
    t1 = Math.max(t1, replay.fixes[replay.fixes.length - 1].t);
  }
  T = t1;
  tab = 'summary';
  renderSide(side);
  mountMap(root);
  renderReplayBar();
  applyTime();
}

function renderSide(side: HTMLElement): void {
  const inc = replay!.incident;
  const r = report!;
  const subject = encodeURIComponent(`${cs.s.state?.station.shortName ?? 'Howth CG'} ${inc.kind} report ${fmtDT(inc.startedAt)}`);
  const body = encodeURIComponent(
    `${inc.kind === 'tasking' ? 'Tasking' : 'Callout'}: ${inc.text}\nStarted ${fmtDT(inc.startedAt)}${inc.endedAt ? `, ended ${fmtDT(inc.endedAt)}` : ''} (${fmtMin(r.durationMin)})\nResponders ${r.totals.responders} (${r.totals.onScene} on scene), teams ${r.totals.teams}, targets ${r.totals.targetsDone}/${r.totals.targetsTotal}\nTrack searched ${r.totals.trackKm} km, area swept ~${r.totals.sweptKm2} km²\n\nFull report attached (download it from the console: History → Download report).`,
  );
  side.innerHTML = `<div class="hist-head">
      <a class="btn-sm" href="#history">◀ All</a>
      <div class="grow"><div>${kindTag(inc.kind)} <b>${esc(inc.text)}</b></div><div class="muted small">${fmtDT(inc.startedAt)} → ${inc.endedAt ? fmtDT(inc.endedAt) : '<span class="amber">open</span>'} · ${fmtMin(r.durationMin)}${inc.endReason ? ` · ${esc(inc.endReason)}` : ''}</div></div>
    </div>
    <div class="hist-actions">
      <a class="btn-sm primary" href="/api/incidents/${esc(inc.id)}/report.html" target="_blank" rel="noopener">Report</a>
      <a class="btn-sm" href="/api/incidents/${esc(inc.id)}/report.html?download=1" download>Download</a>
      <a class="btn-sm" href="mailto:?subject=${subject}&body=${body}">Email HQ</a>
      <a class="btn-sm" href="/api/incidents/${esc(inc.id)}/export.geojson" download>GeoJSON</a>
    </div>
    <div class="tabs-sm three"><button class="tab ${tab === 'summary' ? 'active' : ''}" data-htab="summary">Summary</button><button class="tab ${tab === 'timeline' ? 'active' : ''}" data-htab="timeline">Timeline (${replay!.events.length})</button><button class="tab ${tab === 'conditions' ? 'active' : ''}" data-htab="conditions">Conditions</button></div>
    <div class="sb-body" id="hist-body">${tab === 'summary' ? summaryTab() : tab === 'timeline' ? timelineTab() : conditionsTab()}</div>`;
  side.querySelectorAll<HTMLButtonElement>('[data-htab]').forEach((b) => b.addEventListener('click', () => { tab = b.dataset.htab as typeof tab; renderSide(side); }));
  side.querySelectorAll<HTMLElement>('[data-jump]').forEach((el) => el.addEventListener('click', () => { T = Math.floor(Date.parse(el.dataset.jump!) / 1000); pause(); applyTime(); }));
}

function summaryTab(): string {
  const r = report!;
  const inc = replay!.incident;
  const stat = (k: string, v: string) => `<div class="stat"><span>${k}</span><b>${v}</b></div>`;
  return `<div class="stats">${stat('Responders', `${r.totals.responders}`)}${stat('On scene', `${r.totals.onScene}`)}${stat('Teams', `${r.totals.teams}`)}${stat('Targets', `${r.totals.targetsDone}/${r.totals.targetsTotal}`)}${stat('Track', `${r.totals.trackKm} km`)}${stat('Swept', `${r.totals.sweptKm2} km²`)}</div>
    ${inc.ipp ? `<p class="small"><b class="amber">IPP</b> ${esc(inc.ipp.label ?? '')} ${inc.ipp.lat.toFixed(4)}, ${inc.ipp.lon.toFixed(4)}</p>` : ''}
    <h4>Responders</h4>
    <table class="set-table small"><thead><tr><th>Name</th><th>Team</th><th>Resp.</th><th>Scene</th><th>On scene</th><th>Track</th></tr></thead><tbody>
    ${r.responders.map((p) => `<tr><td>${esc(p.name)}</td><td>${p.team ? esc(p.teamCallsign ?? p.team) : '—'}</td><td title="${fmtTime(p.respondedAt)}">${fmtMin(p.responseMin)}</td><td title="${fmtTime(p.onSceneAt)}">${fmtMin(p.toSceneMin)}</td><td>${fmtMin(p.onSceneMin)}</td><td>${p.trackKm} km</td></tr>`).join('') || '<tr><td colspan="6" class="muted">None</td></tr>'}
    </tbody></table>
    <h4>Teams</h4>
    ${r.teams.map((t) => `<div class="team" style="--team:${esc(t.colour)}"><div class="team-head"><span class="dot"></span><b>${esc(t.name)}</b> <span class="muted small">${t.searchWidthM} m · ${t.trackKm} km · ${t.sweptKm2} km² · ${fmtMin(t.searchingMin)} searching</span></div>
      <div class="muted small">${t.members.map((m) => `${esc(m.callsign)} ${esc(m.name)}${m.leftAt ? ` (left ${fmtTime(m.leftAt)})` : ''}`).join(' · ') || 'no members'}</div>
      ${t.targets.length ? `<div class="muted small">Targets: ${t.targets.map(esc).join(', ')}</div>` : ''}</div>`).join('') || '<p class="muted small">No teams.</p>'}`;
}

function timelineTab(): string {
  return `<ul class="timeline">${replay!.events.map((e) => `<li data-jump="${esc(e.at)}" class="${Math.floor(Date.parse(e.at) / 1000) <= T ? 'done' : ''}"><time>${fmtTime(e.at)}</time><span class="badge-s grey">${esc(e.kind)}</span> ${esc(e.text)}</li>`).join('') || '<li class="muted">No events recorded.</li>'}</ul>`;
}

function conditionsTab(): string {
  const c = replay!.conditions;
  if (!c.length) return '<p class="muted pad">No conditions recorded (incident predates this feature).</p>';
  const kv = (s: ConditionsSnapshot) => `<div class="cond"><h4>${s.phase === 'start' ? 'At start' : 'At end'} · ${fmtTime(s.at)}</h4><div class="kv small">
    <span>Wind</span><b>${s.wind ? `${s.wind.speedKt} kt ${esc(s.wind.dirName)} F${s.wind.beaufort}${s.wind.gustKt ? ` g${s.wind.gustKt}` : ''}` : '—'}</b>
    <span>Observed</span><b>${s.observed ? `${s.observed.speedKt} kt ${esc(s.observed.dirName)}${s.observed.gustKt ? ` g${s.observed.gustKt}` : ''} (${esc(s.observed.stationName)})` : '—'}</b>
    <span>Visibility</span><b>${esc(s.visibility ?? '—')}</b>
    <span>Weather</span><b>${esc(s.symbol ?? '—')}${s.tempC !== undefined ? ` · ${s.tempC} °C` : ''}${s.precipMm !== undefined ? ` · ${s.precipMm} mm` : ''}</b>
    <span>Sea</span><b>${s.sea ? `Hs ${s.sea.hsM ?? '—'} m${s.sea.periodS ? ` ${s.sea.periodS} s` : ''}${s.sea.gale ? ' GALE' : ''}` : '—'}</b>
    <span>Tide</span><b>${s.tide ? `${s.tide.heightM?.toFixed(2) ?? '—'} m ${s.tide.rising === undefined ? '' : s.tide.rising ? '▲' : '▼'}${s.tide.next ? ` next ${esc(s.tide.next.kind)} ${fmtTime(s.tide.next.time)}` : ''}` : '—'}</b>
    <span>Daylight</span><b>${s.sun ? `${s.sun.isDaylight ? 'yes' : 'dark'} · dusk ${fmtTime(s.sun.civilDusk)}` : '—'}</b>
    <span>Warnings</span><b>${s.warnings.length ? s.warnings.map(esc).join('<br/>') : 'none'}</b>
  </div></div>`;
  return c.map(kv).join('');
}

// ---------------------------------------------------------------- map + replay
function mountMap(root: HTMLElement): void {
  const wrap = root.querySelector<HTMLElement>('#hist-map-wrap')!;
  if (!mapEl) {
    mapEl = document.createElement('div');
    mapEl.className = 'sm-map-el';
  }
  wrap.prepend(mapEl);
  const s = cs.s.state;
  if (!s) return;
  if (!map) {
    map = new OpsMap({ interactive: true, search: true, autoFit: true, staleSec: 1e9, rings: false, showAis: false });
    map.mount(mapEl, s);
  } else map.resize();
}

/** Positions as they were at time T: latest fix per user ≤ T, tracks up to T. */
function applyTime(): void {
  if (!replay || !map || !cs.s.state) return;
  const latest: Record<number, Fix> = {};
  const byUser = new Map<number, Fix[]>();
  for (const f of replay.fixes) {
    if (f.t > T) break;
    const team = replay.teams.find((x) => x.id === f.team);
    const u = replay.users[f.u];
    const fix: Fix = { userId: f.u, deviceId: 0, name: u?.name ?? '', callsign: team?.memberships.find((m) => m.userId === f.u)?.callsign ?? u?.callsign, teamId: f.team ?? undefined, lat: f.lat, lon: f.lon, tst: f.t, at: '' };
    latest[f.u] = fix;
    byUser.set(f.u, [...(byUser.get(f.u) ?? []), fix]);
  }
  const snap: SearchSnapshot = { incident: replay.incident, responders: replay.responders, teams: replay.teams, targets: replay.targets, latest, updatedAt: '' };
  const state: DashboardState = { ...cs.s.state, mode: { mode: 'standby', changedAt: '' }, ais: undefined };
  map.update(state, snap);
  map.setTracks(byUser, snap, 900);
  const bar = document.getElementById('replay-bar');
  if (bar) {
    const slider = bar.querySelector<HTMLInputElement>('input[type=range]');
    if (slider && document.activeElement !== slider) slider.value = String(T);
    const lab = bar.querySelector('#replay-time');
    if (lab) lab.textContent = `${hms.format(new Date(T * 1000))} · +${fmtElapsed((T - Math.floor(Date.parse(replay.incident.startedAt) / 1000)) * 1000)}`;
    const play = bar.querySelector('#replay-play');
    if (play) play.textContent = playing ? '❚❚' : '▶';
  }
  document.querySelectorAll<HTMLElement>('.timeline li[data-jump]').forEach((li) => li.classList.toggle('done', Math.floor(Date.parse(li.dataset.jump!) / 1000) <= T));
}

function renderReplayBar(): void {
  const bar = document.getElementById('replay-bar');
  if (!bar || !replay) return;
  bar.innerHTML = `<button class="btn-sm" id="replay-restart" title="Back to start">⏮</button><button class="btn-sm primary" id="replay-play">▶</button>
    <select id="replay-speed">${[10, 30, 60, 300, 1200].map((s) => `<option value="${s}" ${s === speed ? 'selected' : ''}>${s}×</option>`).join('')}</select>
    <input type="range" min="${t0}" max="${t1}" step="1" value="${T}" />
    <span id="replay-time" class="mono"></span>
    <span class="muted small">${replay.fixes.length} fixes · ${hms.format(new Date(t0 * 1000))}–${hms.format(new Date(t1 * 1000))}</span>`;
  bar.querySelector('#replay-play')!.addEventListener('click', () => (playing ? pause() : play()));
  bar.querySelector('#replay-restart')!.addEventListener('click', () => { pause(); T = t0; applyTime(); });
  bar.querySelector<HTMLSelectElement>('#replay-speed')!.addEventListener('change', (ev) => (speed = Number((ev.target as HTMLSelectElement).value)));
  bar.querySelector<HTMLInputElement>('input[type=range]')!.addEventListener('input', (ev) => { T = Number((ev.target as HTMLInputElement).value); applyTime(); });
}

function play(): void {
  if (!replay) return;
  if (T >= t1) T = t0;
  playing = true;
  let last = performance.now();
  timer = window.setInterval(() => {
    const nowMs = performance.now();
    T = Math.min(t1, T + ((nowMs - last) / 1000) * speed);
    last = nowMs;
    applyTime();
    if (T >= t1) pause();
  }, 100);
  applyTime();
}

function pause(): void {
  playing = false;
  if (timer) clearInterval(timer);
  timer = undefined;
  applyTime();
}

function stopReplay(): void {
  pause();
  replay = undefined;
  report = undefined;
}

export function historyMapResize(): void {
  map?.resize();
}

