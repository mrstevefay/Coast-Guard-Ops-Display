/**
 * /device/ — the station Pi's own settings: Wi-Fi. Served by the Pi, opened from a
 * phone or laptop on the station network (http://howth-cg.local:8080/device/).
 * Protected by the device password (DEVICE_PASSWORD in howth-cg.env).
 */
import '../components.css';
import '../mobile.css';
import './device.css';
import { esc } from '../format';
import { toast } from '../m/ui';

interface SavedWifi { uuid: string; name: string; ssid: string; active: boolean; autoconnect: boolean; priority: number }
interface NearbyWifi { ssid: string; signal: number; security: string; inUse: boolean; saved: boolean }
interface Attempt { id: number; ssid: string; state: 'connecting' | 'connected' | 'failed'; startedAt: string; finishedAt?: string; error?: string; restored?: string }
interface Status {
  available: boolean; reason?: string; hostname: string; iface?: string; radio?: boolean; state?: string;
  ssid?: string; signal?: number; ip4?: string; ethernet?: { iface: string; connected: boolean; ip4?: string };
  saved: SavedWifi[]; attempt?: Attempt;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const PW_KEY = 'cg_device_pw';
const store = {
  get: () => { try { return sessionStorage.getItem(PW_KEY) ?? ''; } catch { return ''; } },
  set: (v: string) => { try { sessionStorage.setItem(PW_KEY, v); } catch { /* private mode: kept in memory only */ } },
  clear: () => { try { sessionStorage.removeItem(PW_KEY); } catch { /* ignore */ } },
};

const app = document.getElementById('app')!;
let password = store.get();
let status: Status | undefined;
let networks: NearbyWifi[] | undefined;
let scanning = false;
let open: string | undefined; // SSID whose join form is showing
let pollTimer: number | undefined;
let lostSince: number | undefined;
let busy = false;

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { ...(password ? { authorization: `Bearer ${password}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: 'no-store',
    credentials: 'same-origin',
  });
  const text = await res.text();
  let data: any;
  try { data = text ? JSON.parse(text) : undefined; } catch { data = undefined; }
  if (!res.ok) throw new HttpError(res.status, data?.error ?? `${res.status} ${res.statusText}`);
  return data as T;
}

// ------------------------------------------------------------------ sign in
function renderLogin(error?: string): void {
  app.innerHTML = `<div class="login">
      <div class="login-brand"><div class="login-title">Display Wi-Fi</div><div class="login-sub">Howth CG station display</div></div>
      <form id="pw-form" autocomplete="on">
        <input type="text" name="username" value="howth-cg-device" autocomplete="username" hidden />
        <label class="field"><span>Device password</span><input name="password" type="password" autocomplete="current-password" required autofocus /></label>
        ${error ? `<p class="note error">${esc(error)}</p>` : ''}
        <button class="btn primary big" type="submit">Open</button>
      </form>
      <p class="note muted">The device password is <span class="mono">DEVICE_PASSWORD</span> in <span class="mono">howth-cg.env</span> on the SD card's boot partition (or the callout token if that is not set).</p>
    </div>`;
  app.querySelector<HTMLFormElement>('#pw-form')!.addEventListener('submit', (ev) => {
    ev.preventDefault();
    password = String(new FormData(ev.target as HTMLFormElement).get('password') ?? '');
    void boot();
  });
}

async function boot(): Promise<void> {
  try {
    status = await call<Status>('GET', '/api/device/wifi');
    store.set(password);
    renderShell();
    if (status.available) void scan();
    schedulePoll();
  } catch (e) {
    const err = e as HttpError;
    if (err.status === 404) app.innerHTML = `<div class="login"><div class="login-title">Display Wi-Fi</div><p class="note muted">Wi-Fi management is off on this server. It runs on the station Pi only.</p></div>`;
    else if (err.status === 401 || err.status === 429 || err.status === 503) {
      store.clear();
      renderLogin(err.status === 401 && !password ? undefined : err.message);
    } else app.innerHTML = `<div class="login"><div class="login-title">Display Wi-Fi</div><p class="note error">${esc(err.message ?? String(e))}</p><button class="btn wide" onclick="location.reload()">Try again</button></div>`;
  }
}

// ------------------------------------------------------------------ page
function renderShell(): void {
  app.innerHTML = `<header class="m-head"><div class="m-head-left"><span class="m-title">DISPLAY WI-FI</span></div><button class="btn small ghost" id="lock">Lock</button></header>
    <main id="page">
      <div id="d-attempt"></div>
      <section class="card" id="d-status"></section>
      <section class="card"><h2>Networks nearby <button class="btn small right" id="scan">Scan</button></h2><div id="d-nearby"></div>
        <details id="d-other"><summary>Other network (hidden name)…</summary>
          <form id="other-form">
            <label class="field"><span>Network name (SSID)</span><input name="ssid" required maxlength="32" autocapitalize="off" autocorrect="off" spellcheck="false" /></label>
            <label class="field"><span>Password (blank for an open network)</span><input name="password" type="password" autocomplete="new-password" /></label>
            <button class="btn primary wide" type="submit">Join</button>
          </form>
        </details>
      </section>
      <section class="card"><h2>Saved networks</h2><div id="d-saved"></div>
        <p class="note muted small">The Pi joins these by itself. The one chosen last is tried first after a restart.</p></section>
    </main>`;
  app.querySelector('#lock')!.addEventListener('click', () => {
    store.clear();
    password = '';
    if (pollTimer) clearTimeout(pollTimer);
    renderLogin();
  });
  app.querySelector('#scan')!.addEventListener('click', () => void scan());
  app.querySelector<HTMLFormElement>('#other-form')!.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.target as HTMLFormElement);
    void join(String(f.get('ssid') ?? ''), String(f.get('password') ?? ''), true);
  });
  app.querySelector('#d-nearby')!.addEventListener('click', onNearbyClick);
  app.querySelector('#d-nearby')!.addEventListener('submit', onNearbySubmit);
  app.querySelector('#d-saved')!.addEventListener('click', onSavedClick);
  renderStatus();
  renderNearby();
}

const bars = (sig?: number) => {
  const n = sig === undefined ? 0 : sig >= 75 ? 4 : sig >= 50 ? 3 : sig >= 30 ? 2 : 1;
  return `<span class="bars" title="${sig ?? 0} %">${[1, 2, 3, 4].map((i) => `<i class="${i <= n ? 'on' : ''}"></i>`).join('')}</span>`;
};

function renderStatus(): void {
  const el = document.getElementById('d-status');
  if (!el || !status) return;
  const s = status;
  const lost = lostSince !== undefined;
  const wifiLine = !s.available
    ? `<p class="note error">${esc(s.reason ?? 'Wi-Fi not available')}</p>`
    : s.radio === false
      ? '<p class="note warn">The Wi-Fi radio is switched off.</p>'
      : s.state === 'connected'
        ? `<div class="d-now">${bars(s.signal)}<div><div class="big-name">${esc(s.ssid ?? '?')}</div><div class="muted small">${s.signal !== undefined ? `${s.signal} % signal · ` : ''}${esc(s.ip4 ?? 'no address yet')}</div></div></div>`
        : `<p class="note warn">Wi-Fi not connected (${esc(s.state ?? 'unknown')}).</p>`;
  const eth = s.ethernet
    ? `<div><span>Ethernet</span><b>${s.ethernet.connected ? `connected · ${esc(s.ethernet.ip4 ?? '')}` : 'not plugged in'}</b></div>`
    : '';
  el.innerHTML = `<h2>This display ${lost ? '<span class="badge-s amber">no contact</span>' : ''}</h2>${wifiLine}
    <div class="kv-list">${eth}<div><span>Address</span><b class="mono">http://${esc(s.hostname)}.local:8080/device/</b></div></div>
    ${s.available && !s.ethernet?.connected && s.state === 'connected' ? `<p class="note muted small">You are probably reaching the Pi over this Wi-Fi. Switching network drops this page. If the new network fails, the Pi goes back to <b>${esc(s.ssid ?? 'the current network')}</b> within about a minute.</p>` : ''}`;
  renderAttempt();
  renderSaved();
}

function renderAttempt(): void {
  const el = document.getElementById('d-attempt');
  if (!el) return;
  const a = status?.attempt;
  if (lostSince !== undefined) {
    const host = status?.hostname ?? 'howth-cg';
    el.innerHTML = `<div class="note warn"><b>Lost contact with the Pi.</b> Expected if it has just switched network. Join the same network on this phone or laptop and open <span class="mono">http://${esc(host)}.local:8080/device/</span>. Still trying here…</div>`;
    return;
  }
  if (!a) return void (el.innerHTML = '');
  const age = Date.now() - Date.parse(a.finishedAt ?? a.startedAt);
  if (a.state !== 'connecting' && age > 10 * 60_000) return void (el.innerHTML = '');
  el.innerHTML =
    a.state === 'connecting'
      ? `<div class="note warn"><span class="spinner"></span> Connecting to <b>${esc(a.ssid)}</b>… this can take up to a minute.</div>`
      : a.state === 'connected'
        ? `<div class="note ok">Connected to <b>${esc(a.ssid)}</b>.</div>`
        : `<div class="note bad">Could not join <b>${esc(a.ssid)}</b>: ${esc(a.error ?? 'failed')}.${a.restored ? ` Back on <b>${esc(a.restored)}</b>.` : ''}</div>`;
}

function renderNearby(): void {
  const el = document.getElementById('d-nearby');
  if (!el) return;
  const scanBtn = document.querySelector<HTMLButtonElement>('#scan');
  if (scanBtn) {
    scanBtn.disabled = scanning;
    scanBtn.textContent = scanning ? 'Scanning…' : 'Scan';
  }
  if (!status?.available) return void (el.innerHTML = '');
  if (!networks) return void (el.innerHTML = `<p class="muted">${scanning ? 'Looking for networks…' : 'Press Scan.'}</p>`);
  if (!networks.length) return void (el.innerHTML = '<p class="muted">No networks found.</p>');
  el.innerHTML = networks
    .map((n) => {
      const secured = Boolean(n.security);
      const form = open === n.ssid && !n.inUse
        ? `<form class="d-join" data-ssid="${esc(n.ssid)}">
            ${secured ? `<label class="field"><span>${n.saved ? 'Password (leave blank to use the saved one)' : 'Password'}</span><input name="password" type="password" autocomplete="new-password" ${n.saved ? '' : 'required minlength="8"'} /></label>` : '<p class="note muted small">Open network: no password, and traffic is not encrypted.</p>'}
            <div class="btn-row"><button class="btn primary" type="submit">Join</button><button class="btn ghost" type="button" data-act="cancel">Cancel</button></div>
          </form>`
        : '';
      return `<div class="d-net ${n.inUse ? 'in-use' : ''}" data-ssid="${esc(n.ssid)}" role="button" tabindex="0">
          ${bars(n.signal)}<div class="d-net-name">${esc(n.ssid)}</div>
          <div class="d-net-tags">${n.inUse ? '<span class="badge-s green">connected</span>' : n.saved ? '<span class="badge-s blue">saved</span>' : ''}${secured ? `<span class="lock" title="${esc(n.security)}">🔒</span>` : '<span class="muted small">open</span>'}</div>
        </div>${form}`;
    })
    .join('');
  el.querySelector<HTMLInputElement>('.d-join input[name=password]')?.focus();
}

function renderSaved(): void {
  const el = document.getElementById('d-saved');
  if (!el || !status) return;
  const saved = status.saved;
  el.innerHTML = saved.length
    ? saved
        .map((s) => `<div class="user-row"><div><b>${esc(s.ssid)}</b> ${s.active ? '<span class="badge-s green">connected</span>' : ''}${s.autoconnect ? '' : ' <span class="badge-s">manual</span>'}<div class="muted small">${esc(s.name)}</div></div>
          <div class="btn-row small-btns">${s.active ? '' : `<button class="btn small" data-act="up" data-uuid="${esc(s.uuid)}">Connect</button>`}<button class="btn small danger" data-act="forget" data-uuid="${esc(s.uuid)}" data-ssid="${esc(s.ssid)}">Forget</button></div></div>`)
        .join('')
    : '<p class="muted">None.</p>';
}

// ------------------------------------------------------------------ actions
async function scan(): Promise<void> {
  if (scanning) return;
  scanning = true;
  renderNearby();
  try {
    networks = (await call<{ networks: NearbyWifi[] }>('POST', '/api/device/wifi/scan')).networks;
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), true);
  } finally {
    scanning = false;
    renderNearby();
  }
}

function onNearbyClick(ev: Event): void {
  const t = ev.target as HTMLElement;
  if (t.closest('[data-act=cancel]')) {
    open = undefined;
    return renderNearby();
  }
  if (t.closest('.d-join')) return;
  const row = t.closest<HTMLElement>('.d-net');
  if (!row || row.classList.contains('in-use')) return;
  const ssid = row.dataset.ssid!;
  open = open === ssid ? undefined : ssid;
  renderNearby();
}

function onNearbySubmit(ev: Event): void {
  const form = (ev.target as HTMLElement).closest<HTMLFormElement>('.d-join');
  if (!form) return;
  ev.preventDefault();
  void join(form.dataset.ssid!, String(new FormData(form).get('password') ?? ''), false);
}

async function join(ssid: string, pw: string, hidden: boolean): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    const { attempt } = await call<{ attempt: Attempt }>('POST', '/api/device/wifi/connect', { ssid, password: pw || undefined, hidden });
    if (status) status.attempt = attempt;
    open = undefined;
    renderNearby();
    renderAttempt();
    const other = document.querySelector<HTMLDetailsElement>('#d-other');
    if (other) {
      other.open = false;
      other.querySelector('form')?.reset();
    }
    schedulePoll(2500);
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), true);
  } finally {
    busy = false;
  }
}

function onSavedClick(ev: Event): void {
  const b = (ev.target as HTMLElement).closest<HTMLButtonElement>('button[data-act]');
  if (!b || busy) return;
  const uuid = b.dataset.uuid!;
  if (b.dataset.act === 'up') {
    busy = true;
    call<{ attempt: Attempt }>('POST', `/api/device/wifi/saved/${encodeURIComponent(uuid)}/connect`)
      .then(({ attempt }) => {
        if (status) status.attempt = attempt;
        renderAttempt();
        schedulePoll(2500);
      })
      .catch((e) => toast(e.message, true))
      .finally(() => (busy = false));
  } else if (b.dataset.act === 'forget') {
    if (!confirm(`Forget ${b.dataset.ssid}? The Pi will no longer join it by itself.`)) return;
    busy = true;
    call('DELETE', `/api/device/wifi/saved/${encodeURIComponent(uuid)}`)
      .then(() => {
        toast('Forgotten');
        return refresh();
      })
      .catch((e) => toast(e.message, true))
      .finally(() => (busy = false));
  }
}

// ------------------------------------------------------------------ polling
async function refresh(): Promise<void> {
  const wasConnecting = status?.attempt?.state === 'connecting';
  try {
    status = await call<Status>('GET', '/api/device/wifi');
    lostSince = undefined;
  } catch (e) {
    if (e instanceof HttpError && e.status === 401) {
      store.clear();
      password = '';
      return renderLogin('Device password changed. Enter it again.');
    }
    lostSince ??= Date.now();
  }
  renderStatus();
  if (wasConnecting && status?.attempt?.state !== 'connecting' && lostSince === undefined) void scan();
}

function schedulePoll(ms?: number): void {
  if (pollTimer) clearTimeout(pollTimer);
  const fast = status?.attempt?.state === 'connecting' || lostSince !== undefined;
  pollTimer = window.setTimeout(async () => {
    await refresh();
    if (password) schedulePoll();
  }, ms ?? (fast ? 2500 : 15_000));
}

// Try straight away: a saved password, or an admin session where accounts are on.
void boot();
