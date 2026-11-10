import '../components.css';
import '../mobile.css';
import type { Principal, UserPublic } from '../../../shared/types';
import { get, setUnauthorisedHandler } from '../api';
import { fmtDurationMin, fmtElapsed } from '../format';
import { WsClient } from '../ws';
import { renderAdmin } from './pages/admin';
import { renderSaf, renderTidePage, renderWeather } from './pages/feeds';
import { renderLogin } from './pages/login';
import { leaveMapPage, renderMapPage } from './pages/map';
import { renderDevicePage, renderMore, renderPassword, renderPrivacy } from './pages/profile';
import { renderStatus } from './pages/status';
import { renderTeam } from './pages/team';
import { currentRoute, navigate, onRoute, type Route } from './router';
import { store } from './store';
import { tracking } from './tracking';

const app = document.getElementById('app')!;
let ws: WsClient | undefined;
let shellBuilt = false;
let currentPage: Route | undefined;

const TABS: [Route, string][] = [
  ['status', 'Status'],
  ['weather', 'Weather'],
  ['tide', 'Tide'],
  ['map', 'Map'],
  ['team', 'Team'],
  ['more', 'More'],
];

async function boot(): Promise<void> {
  setUnauthorisedHandler(() => showLogin());
  try {
    const me = await get<{ principal: Principal; user?: UserPublic }>('/api/auth/me');
    if (me.principal.kind === 'open') {
      // LAN/open mode: no accounts, show the feeds only
      store.setMe({ id: 0, email: '', name: 'Crew', role: 'member', active: true, mustChangePassword: false }, me.principal);
    } else if (me.user) store.setMe(me.user, me.principal);
    else return showLogin();
    start();
  } catch {
    showLogin();
  }
}

function showLogin(): void {
  ws?.stop();
  ws = undefined;
  shellBuilt = false;
  renderLogin(app, (user) => {
    store.setMe(user, { kind: 'user', userId: user.id, role: user.role, name: user.name });
    start();
  });
}

function start(): void {
  buildShell();
  ws = new WsClient({
    onState: (s) => store.setState(s),
    onConnection: (c) => store.setConnected(c),
    onMessage: (m) => store.onMessage(m),
    onAuthFail: () => showLogin(),
    reloadAfterMs: 0, // phones: never hard-reload, just keep reconnecting
  });
  ws.start();
  // First open on a phone: fetch an OwnTracks credential so the Status page can offer the
  // one-tap setup (or hand it over on the first "I'm responding").
  tracking.prepare().catch(() => {});
  store.subscribe(() => {
    renderHeader();
    if (currentPage && ['status', 'weather', 'tide', 'saf', 'team'].includes(currentPage)) render(currentRoute(), true);
  });
  render(currentRoute());
}

function buildShell(): void {
  if (shellBuilt) return;
  shellBuilt = true;
  app.innerHTML = `<header class="m-head"><div class="m-head-left"><span class="m-title">Howth CG</span><span id="m-mode"></span></div><span id="m-conn" class="m-conn"></span></header>
    <main id="page"></main>
    <nav class="tabs">${TABS.map(([r, l]) => `<a href="#/${r}" data-tab="${r}">${l}</a>`).join('')}</nav>`;
  onRoute((m) => render(m));
}

function renderHeader(): void {
  const s = store.s.state;
  const mode = document.getElementById('m-mode');
  const tasking = s?.mode.mode !== 'callout' && store.s.search?.incident?.kind === 'tasking';
  // The one mode badge in the app, with the elapsed timer beside it (ticked by the interval below).
  const startedAt = s?.mode.mode === 'callout' ? s.mode.incident?.receivedAt : tasking ? store.s.search?.incident?.startedAt : undefined;
  const key = `${s?.mode.mode}:${tasking}:${startedAt ?? ''}`;
  if (mode && mode.dataset.key !== key) {
    mode.dataset.key = key;
    mode.innerHTML = s?.mode.mode === 'callout' ? '<span class="mode-tag mode-callout">CALLOUT</span>' : tasking ? '<span class="mode-tag mode-tasking">TASKING</span>' : '<span class="mode-tag mode-standby">STANDBY</span>';
    if (startedAt) mode.innerHTML += `<span class="head-elapsed ${tasking ? 'tasking' : ''}" data-elapsed="${startedAt}">${fmtElapsed(Date.now() - Date.parse(startedAt))}</span>`;
  }
  const conn = document.getElementById('m-conn');
  if (conn) conn.textContent = store.s.connected ? '' : 'offline';
  document.body.classList.toggle('callout', s?.mode.mode === 'callout');
}

function render(m: ReturnType<typeof currentRoute>, soft = false): void {
  const me = store.s.me;
  if (!me) return;
  const page = document.getElementById('page')!;
  let route = m.route;
  // forced flows
  if (me.mustChangePassword && route !== 'password' && route !== 'login') route = 'password';
  else if (!me.privacyAcceptedAt && me.id !== 0 && route !== 'privacy' && route !== 'password') route = 'privacy';
  if (soft && route !== currentPage) return; // a soft re-render never changes page
  if (currentPage === 'map' && route !== 'map') leaveMapPage();
  currentPage = route;
  document.querySelectorAll<HTMLElement>('.tabs a').forEach((a) => a.classList.toggle('active', a.dataset.tab === route || (route === 'saf' && a.dataset.tab === 'weather') || (['profile', 'admin', 'privacy', 'password', 'device'].includes(route) && a.dataset.tab === 'more')));
  page.scrollTop = 0;
  switch (route) {
    case 'status': return renderStatus(page);
    case 'weather': return renderWeather(page);
    case 'tide': return renderTidePage(page);
    case 'saf': return renderSaf(page);
    case 'map': return renderMapPage(page);
    case 'team': return renderTeam(page);
    case 'more':
    case 'profile': return void renderMore(page);
    case 'device': return void renderDevicePage(page, m.param);
    case 'admin': return void renderAdmin(page);
    case 'privacy': return renderPrivacy(page);
    case 'password': return renderPassword(page);
    default: return navigate('status');
  }
}

/** Per-second ticks for the elapsed timer and countdowns. */
setInterval(() => {
  const now = Date.now();
  document.querySelectorAll<HTMLElement>('[data-elapsed]').forEach((el) => (el.textContent = fmtElapsed(now - Date.parse(el.dataset.elapsed!))));
  document.querySelectorAll<HTMLElement>('[data-countdown]').forEach((el) => (el.textContent = fmtDurationMin((Date.parse(el.dataset.countdown!) - now) / 60_000)));
}, 1000);

// Weather tab also hosts the Sea Area Forecast page via a sub-link.
document.addEventListener('click', (ev) => {
  const a = (ev.target as HTMLElement).closest<HTMLAnchorElement>('a[data-tab]');
  if (a && a.dataset.tab === 'weather' && currentPage === 'weather') {
    ev.preventDefault();
    navigate('saf');
  }
});

// PWA service worker (crew app only)
if ('serviceWorker' in navigator && location.pathname.startsWith('/m')) {
  import('virtual:pwa-register').then(({ registerSW }) => registerSW({ immediate: true })).catch(() => {});
}

void boot();
