import './style.css';
import type { DashboardState } from '../../shared/types';
import { fmtDate, fmtDurationMin, fmtElapsed, fmtTimeS, fmtWeekday } from './format';
import { OpsMap } from './map';
import { renderAis, renderHealth, renderMuster, renderWebcam } from './panels/bottom';
import { renderDaylight } from './panels/daylight';
import { renderIncident } from './panels/incident';
import { renderSea } from './panels/sea';
import { renderSeaArea } from './panels/seaArea';
import { renderTide } from './panels/tide';
import { renderTopbar } from './panels/topbar';
import { renderWarnings } from './panels/warnings';
import { renderForecastStrip, renderWind } from './panels/wind';
import { WsClient } from './ws';

const app = document.getElementById('app')!;
const map = new OpsMap();
let state: DashboardState | undefined;
let mapEl: HTMLElement | undefined;
let builtMode = '';
let serverVersion = '';

/** Build the grid skeleton for a mode once; panels re-render into slots. */
function skeleton(mode: string): void {
  if (mode === builtMode) return;
  builtMode = mode;
  // Keep the map container alive across mode switches: MapLibre dislikes re-mounting.
  if (!mapEl) {
    mapEl = document.createElement('div');
    mapEl.id = 'map';
  }
  app.innerHTML =
    mode === 'callout'
      ? `<div id="slot-topbar"></div>
         <div id="slot-incident" class="area-incident"></div>
         <div id="slot-map" class="area-map"></div>
         <aside class="area-right"><div id="slot-wind"></div><div id="slot-tide"></div><div id="slot-sun"></div></aside>
         <div id="slot-muster" class="area-bottom"></div>`
      : `<div id="slot-topbar"></div>
         <div id="slot-warnings" class="area-warn"></div>
         <aside class="area-left"><div id="slot-wind"></div><div id="slot-strip"></div></aside>
         <div id="slot-map" class="area-map"></div>
         <aside class="area-right"><div id="slot-tide"></div><div id="slot-sea"></div><div id="slot-sun"></div></aside>
         <div class="area-bottom bottom-strip"><div id="slot-muster"></div><div id="slot-ais"></div><div id="slot-webcam"></div><div id="slot-health"></div></div>`;
  document.getElementById('slot-map')!.appendChild(mapEl);
}

const set = (id: string, html: string) => {
  const el = document.getElementById(id);
  if (el && el.innerHTML !== html) el.innerHTML = html;
};

function render(s: DashboardState): void {
  state = s;
  document.body.dataset.mode = s.mode.mode;
  skeleton(s.mode.mode);
  set('slot-topbar', renderTopbar(s));
  if (s.mode.mode === 'callout') {
    set('slot-incident', renderIncident(s));
    set('slot-wind', s.panels.wind ? renderWind(s, true) : '');
    set('slot-tide', s.panels.tide ? renderTide(s, true) : '');
    set('slot-sun', s.panels.sun ? renderDaylight(s, true) : '');
    set('slot-muster', s.panels.muster ? renderMuster(s, true) : s.panels.seaArea ? renderSeaArea(s, true) : '');
  } else {
    set('slot-warnings', s.panels.warnings ? renderWarnings(s) : '');
    set('slot-wind', s.panels.wind ? renderWind(s) : '');
    set('slot-strip', s.panels.wind ? renderForecastStrip(s) : '');
    set('slot-tide', s.panels.tide ? renderTide(s) : '');
    set('slot-sea', s.panels.sea ? renderSea(s) : '');
    set('slot-sun', s.panels.sun ? renderDaylight(s) : '');
    set('slot-muster', s.panels.muster ? renderMuster(s) : s.panels.seaArea ? renderSeaArea(s) : '');
    set('slot-ais', s.panels.ais ? renderAis(s) : '');
    set('slot-webcam', s.panels.webcam ? renderWebcam(s) : '');
    set('slot-health', renderHealth(s));
  }
  document.body.classList.toggle('has-warning', s.mode.mode === 'standby' && (s.warnings?.active ?? []).some((w) => w.local));
  if (mapEl && s.panels.map) {
    if (!(mapEl as any).__mounted) {
      (mapEl as any).__mounted = true;
      map.mount(mapEl, s);
    } else map.update(s);
  }
  setConn(connected);
  if (serverVersion && s.version !== serverVersion) location.reload();
  serverVersion = s.version;
}

let connected = false;
function setConn(c: boolean): void {
  connected = c;
  document.body.dataset.connected = String(c);
  const el = document.getElementById('conn');
  if (el) el.textContent = c ? '' : 'LINK LOST — showing last data';
}

/** Per-second ticks: clock, elapsed timer, countdowns — no server round trip. */
function tick(): void {
  const now = new Date();
  const clock = document.getElementById('clock');
  if (clock) clock.textContent = fmtTimeS(now);
  const date = document.getElementById('date');
  if (date) date.textContent = fmtDate(now);
  const wdEl = document.getElementById('weekday');
  if (wdEl) wdEl.textContent = fmtWeekday(now);
  document.querySelectorAll<HTMLElement>('[data-elapsed]').forEach((el) => (el.textContent = fmtElapsed(now.getTime() - Date.parse(el.dataset.elapsed!))));
  document.querySelectorAll<HTMLElement>('[data-countdown]').forEach((el) => (el.textContent = fmtDurationMin((Date.parse(el.dataset.countdown!) - now.getTime()) / 60_000)));
  // Daily hygiene reload at 04:00:00 local (kiosk runs for weeks).
  if (now.getHours() === 4 && now.getMinutes() === 0 && now.getSeconds() === 0) location.reload();
}

new WsClient({ onState: render, onConnection: setConn, reloadAfterMs: 5 * 60_000 }).start();
setInterval(tick, 1000);
// Re-render periodically so "stale" badges, webcam cache-buster and
// hour boundaries update even if the server is quiet.
setInterval(() => state && render(state), 30_000);
window.addEventListener('resize', () => map.resize());
