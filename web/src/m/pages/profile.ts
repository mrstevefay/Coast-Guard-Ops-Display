import type { DevicePublic } from '../../../../shared/types';
import { del, get, post } from '../../api';
import { esc, fmtTime } from '../../format';
import { navigate } from '../router';
import { store } from '../store';
import { tracking } from '../tracking';
import { btn, card, err, field, formData, note, toast, wireActions } from '../ui';
import { setupCard, wireSetup } from './status';
import { alertsCard, wireAlerts } from './alerts';
import { pushAlerts } from '../push';

interface NewDevice {
  device: DevicePublic;
  secret: string;
  otrc: Record<string, unknown>;
  configLink: string;
}

export async function renderMore(root: HTMLElement): Promise<void> {
  const me = store.s.me!;
  root.innerHTML = `
    ${card('You', `<div class="big-name">${esc(me.name)}</div><div class="muted">${esc(me.email)} · ${esc(me.role)}${me.callsign ? ` · ${esc(me.callsign)}` : ''}</div>`)}
    ${alertsCard()}
    <section class="card" id="devices"><h2>Phones (OwnTracks)</h2>${note('Loading…')}</section>
    ${card('Account', `${btn('Change password', 'password', 'ghost wide')}${btn('Privacy notice', 'privacy', 'ghost wide')}${store.isAdmin ? btn('Admin: users & displays', 'admin', 'ghost wide') : ''}${btn('Sign out', 'logout', 'danger wide')}`)}
    ${card('Install', note('iPhone: Share → Add to Home Screen. Android: menu → Install app. Installed, it opens full screen and stays signed in.'))}
    <p class="note muted small">Howth Coast Guard crew app · v${esc(store.s.state?.version ?? '')}</p>`;
  wireActions(root, {
    password: () => navigate('password'),
    privacy: () => navigate('privacy'),
    admin: () => navigate('admin'),
    logout: async () => {
      await post('/api/auth/logout');
      location.reload();
    },
    'add-device': () => navigate('device', 'new'),
    'revoke-device': async (el) => {
      if (!confirm('Revoke this phone? OwnTracks on it will stop working.')) return;
      await del(`/api/devices/${el.dataset.id}`);
      toast('Revoked');
      await tracking.prepare(); // if that was this phone, offer the setup again
      await renderDevices(root.querySelector('#devices')!);
    },
  });
  // the alerts card follows the phone's state (on, off, blocked) without redrawing the whole page
  wireAlerts(root);
  const key = () => `${pushAlerts.state}:${pushAlerts.busy}:${store.s.state?.alerts?.enabled}:${store.s.state?.alerts?.until ?? ''}`;
  let shown = key();
  const stop = store.subscribe(() => {
    const el = root.querySelector('#alerts');
    if (!el) return stop();
    if (key() === shown) return;
    shown = key();
    el.outerHTML = alertsCard();
  });
  await renderDevices(root.querySelector('#devices')!);
}

async function renderDevices(el: HTMLElement): Promise<void> {
  try {
    const { devices } = await get<{ devices: DevicePublic[] }>('/api/devices');
    const live = devices.filter((d) => !d.revokedAt);
    const linked = tracking.linked;
    el.innerHTML = `<h2>Phones (OwnTracks)</h2>
      ${live.length ? live.map((d) => `<div class="member-row"><b>${esc(d.name)}</b>${linked?.deviceId === d.id ? ' <span class="badge-s blue">this phone</span>' : ''} <span class="muted">${esc(d.username)}</span><span class="right muted">${d.lastSeenAt ? `seen ${fmtTime(d.lastSeenAt)}` : 'never seen'}</span> ${btn('Revoke', 'revoke-device', 'small ghost', `data-id="${d.id}"`)}</div>`).join('') : note('No phone set up yet. Your position only reaches the team once OwnTracks is installed and linked.')}
      ${tracking.needsSetup ? setupCard() : ''}
      <div class="btn-row">${tracking.isMobile ? btn(linked ? 'Send setup to OwnTracks again' : 'Set up this phone', 'link-device', 'primary') : ''}${btn('+ Add another phone (QR)', 'add-device', 'ghost')}</div>`;
    wireSetup(el);
    el.querySelector('[data-action="link-device"]')?.addEventListener('click', async () => {
      // A new credential for this phone; the never-seen one it replaces is revoked server-side.
      tracking.dismissed = false;
      await tracking.prepare(true);
      await renderDevices(el);
      el.querySelector<HTMLElement>('.setup')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  } catch (e) {
    el.innerHTML = `<h2>Phones (OwnTracks)</h2>${err(e instanceof Error ? e.message : 'failed')}`;
  }
}

/** Add-phone flow: create device → show QR + one-tap link + manual settings. */
export async function renderDevicePage(root: HTMLElement, param?: string): Promise<void> {
  if (param !== 'new') return navigate('more');
  root.innerHTML = `${card('Add this phone', `
    <ol class="steps">
      <li>Install <b>OwnTracks</b> from the App Store / Play Store.</li>
      <li>Give this phone a name and tap Create.</li>
      <li>Tap <b>Open in OwnTracks</b> (or scan the QR from another device).</li>
      <li>In OwnTracks allow location <b>Always</b>; on Android turn off battery optimisation for it.</li>
    </ol>
    <form id="dev-form">${field('Phone name', 'name', 'text', 'iPhone', 'required maxlength="40"')}${btn('Create', 'create', 'primary wide', 'type="submit"')}</form>`)}`;
  const form = root.querySelector<HTMLFormElement>('#dev-form')!;
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      const d = await post<NewDevice>('/api/devices', { name: formData(form).name });
      showDevice(root, d);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'failed', true);
    }
  });
}

function showDevice(root: HTMLElement, d: NewDevice): void {
  const cfg = d.otrc as { url: string; username: string; password: string; deviceId: string; tid: string };
  root.innerHTML = `${card(`${esc(d.device.name)} linked`, `
    ${note('This code is shown once. If you lose it, revoke the phone and add it again.', 'warn')}
    <a class="btn primary wide" href="${esc(d.configLink)}">Open in OwnTracks</a>
    <div class="qr"><img src="/api/devices/${d.device.id}/qr.svg" alt="OwnTracks setup QR" /></div>
    <p class="muted small">Scan with the OwnTracks app on another phone, or tap the button on this one.</p>
    <details><summary>Manual settings</summary>
      <div class="kv-list">
        <div><span>Mode</span><b>HTTP</b></div>
        <div><span>URL</span><b>${esc(cfg.url)}</b></div>
        <div><span>Authentication</span><b>on</b></div>
        <div><span>User ID</span><b>${esc(cfg.username)}</b></div>
        <div><span>Password</span><b class="mono">${esc(cfg.password)}</b></div>
        <div><span>Device ID</span><b>${esc(cfg.deviceId)}</b></div>
        <div><span>Tracker ID</span><b>${esc(cfg.tid)}</b></div>
      </div>
      <a class="btn ghost wide" href="/api/devices/${d.device.id}/config.otrc" download>Download .otrc file</a>
    </details>
    ${btn('Done', 'done', 'ghost wide')}`)}`;
  wireActions(root, { done: () => navigate('more') });
}

export function renderPassword(root: HTMLElement): void {
  const forced = store.s.me?.mustChangePassword;
  root.innerHTML = card(forced ? 'Set a new password' : 'Change password', `
    ${forced ? note('Your password was set by an admin. Choose your own before continuing.', 'warn') : ''}
    <form id="pw-form">
      ${field('Current password', 'current', 'password', '', 'autocomplete="current-password" required')}
      ${field('New password (8+ characters)', 'new', 'password', '', 'autocomplete="new-password" required minlength="8"')}
      ${field('Repeat new password', 'new2', 'password', '', 'autocomplete="new-password" required minlength="8"')}
      ${btn('Save', 'save', 'primary wide', 'type="submit"')}
    </form>`);
  const form = root.querySelector<HTMLFormElement>('#pw-form')!;
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = formData(form);
    if (f.new !== f.new2) return toast('Passwords do not match', true);
    try {
      await post('/api/auth/password', { current: f.current, new: f.new });
      if (store.s.me) store.s.me.mustChangePassword = false;
      toast('Password changed');
      navigate('status');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'failed', true);
    }
  });
}

export function renderPrivacy(root: HTMLElement): void {
  const accepted = Boolean(store.s.me?.privacyAcceptedAt);
  root.innerHTML = card('Privacy notice', `
    <p>This app is run by Howth Coast Guard for crew coordination during callouts.</p>
    <p><b>What is collected:</b> your name, email, callsign and role; whether you are responding to an incident and your ETA; and, while an incident is open and you are responding or in a search team, your phone's position (latitude, longitude, altitude, accuracy, speed, battery) sent by the OwnTracks app. If you turn on callout alerts, the address your phone's notification service gives this app is kept so alerts can reach it; turning alerts off removes it.</p>
    <p><b>Who sees it:</b> other logged-in crew during an incident, the search manager and station officers, and the station wall display. Positions are visible to the crew responding to the same incident.</p>
    <p><b>Retention:</b> incident records, team assignments and track points are kept as an operational record of the search. Your last known position is cleared after 24 hours of inactivity. You can ask the station admin to remove your account; it is anonymised and track points lose your name.</p>
    <p><b>Your choices:</b> tracking only runs when you press "I'm responding" or are placed in a team, and only while OwnTracks is installed and linked. You can revoke a phone at any time under More → Phones.</p>
    <p class="muted small">Controller: Howth Coast Guard Unit. Questions to the Officer in Charge.</p>
    ${accepted ? note(`Accepted ${fmtTime(store.s.me!.privacyAcceptedAt!)}`) : btn('I understand', 'accept', 'primary wide')}`);
  wireActions(root, {
    accept: async () => {
      await post('/api/auth/privacy-accept');
      if (store.s.me) store.s.me.privacyAcceptedAt = new Date().toISOString();
      navigate('status');
    },
  });
}
