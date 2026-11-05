import type { ResponseStatus } from '../../../../shared/types';
import { put } from '../../api';
import { bearingDeg, distanceM, esc, fmtDistance, fmtElapsed, fmtTime } from '../../format';
import { anchorOf } from '../../map';
import { renderWarnings } from '../../panels/warnings';
import { store } from '../store';
import { tracking } from '../tracking';
import { btn, card, note, statusBadge, toast, wireActions } from '../ui';

/** One-tap OwnTracks setup for this phone: the button *is* the config link. */
export function setupCard(): string {
  const p = tracking.pending!;
  return `<section class="card setup">
    <h2>Set up tracking on this phone</h2>
    <p>Your position reaches the team through the free <b>OwnTracks</b> app. Install it, then tap the button: the app opens with this station's settings already filled in.</p>
    <a class="btn primary huge" href="${esc(p.link)}" data-action="ot-launch">Open OwnTracks</a>
    <div class="btn-row"><a class="btn ghost small" href="https://owntracks.org/booklet/guide/apps/" target="_blank" rel="noopener">Get the app</a>${btn('Not now', 'ot-dismiss', 'ghost small')}</div>
    <p class="muted small">Then allow location <b>Always</b> (Android: turn off battery optimisation for OwnTracks). Nothing is sent outside callouts.</p>
  </section>`;
}

export function wireSetup(root: HTMLElement): void {
  // The anchor must keep its default navigation (custom-scheme links need the real tap), so
  // only record the launch here; "Not now" hides the card for this session.
  root.querySelector('[data-action="ot-launch"]')?.addEventListener('click', () => tracking.markLaunched());
  wireActions(root, { 'ot-dismiss': () => tracking.dismiss() });
}

export function renderStatus(root: HTMLElement): void {
  const { state, search, me } = store.s;
  if (!state) {
    root.innerHTML = note('Connecting…');
    return;
  }
  const inc = state.mode.mode === 'callout' ? state.mode.incident : undefined;
  const { response, team, member } = store.mine;
  const responding = (search?.responders ?? []).filter((r) => r.status === 'responding' || r.status === 'on-scene');
  const myFix = me ? search?.latest[me.id] : undefined;

  let html = `<div class="mode-row ${inc ? 'callout' : 'standby'}"><span class="mode-tag ${inc ? 'mode-callout' : 'mode-standby'}">${inc ? 'CALLOUT' : 'STANDBY'}</span>${inc ? `<span class="elapsed-s" data-elapsed="${esc(inc.receivedAt)}">${fmtElapsed(Date.now() - Date.parse(inc.receivedAt))}</span>` : `<span class="muted">${esc(state.station.name)}</span>`}</div>`;
  html += renderWarnings(state);
  if (tracking.needsSetup) html += setupCard();

  if (inc) {
    html += `<section class="card incident-card">
      <div class="k">RECEIVED ${fmtTime(inc.receivedAt)}</div>
      <div class="inc-text-m">${esc(inc.text)}</div>
      ${inc.lat !== undefined && inc.lon !== undefined ? `<div class="muted">${inc.lat.toFixed(4)}, ${inc.lon.toFixed(4)}${myFix ? ` · ${fmtDistance(distanceM(myFix.lat, myFix.lon, inc.lat, inc.lon))} from you` : ''}</div>` : ''}
    </section>`;

    // respond buttons
    const st = response?.status;
    if (!st || st === 'stood-down' || st === 'unavailable' || st === 'available') {
      html += `<section class="card respond">
        ${btn("I'M RESPONDING", 'respond', 'primary huge')}
        <div class="eta-row muted">ETA: ${[5, 10, 15, 20, 30].map((m) => btn(`${m} min`, `respond-eta:${m}`, 'chip')).join('')}</div>
        ${btn("Can't make it", 'unavailable', 'ghost')}
      </section>`;
    } else {
      html += `<section class="card respond">
        <div class="respond-state">${statusBadge(st)} ${response?.etaMin ? `<span class="muted">ETA ${response.etaMin} min</span>` : ''}</div>
        <div class="btn-row">${st !== 'on-scene' ? btn('ON SCENE', 'on-scene', 'primary') : ''}${btn('STAND DOWN', 'stand-down', 'ghost')}</div>
      </section>`;
    }

    // my team
    if (team && member) {
      const targets = (search?.targets ?? []).filter((t) => t.teamId === team.id && t.status !== 'cancelled' && t.status !== 'done');
      html += card(
        `My team · ${team.name}`,
        `<div class="callsign" style="--team:${esc(team.colour)}">${esc(member.callsign)}</div>
         <div class="members">${team.members.map((m) => `<span class="chip-m ${m.position === 0 ? 'leader' : ''}">${esc(m.callsign)} ${esc(m.name.split(' ')[0])}</span>`).join('')}</div>
         ${targets.length ? `<div class="k">TARGETS</div>${targets.map((t) => {
           const [lon, lat] = anchorOf(t.geometry);
           const d = myFix ? `${fmtDistance(distanceM(myFix.lat, myFix.lon, lat, lon))} · ${Math.round(bearingDeg(myFix.lat, myFix.lon, lat, lon)).toString().padStart(3, '0')}°` : '';
           return `<div class="target-row"><b>${esc(t.name)}</b> <span class="badge-s ${t.status === 'in-progress' ? 'amber' : 'grey'}">${esc(t.status)}</span> <span class="muted">${d}</span>${t.notes ? `<div class="muted small">${esc(t.notes)}</div>` : ''}</div>`;
         }).join('')}` : note('No target assigned yet')}`,
      );
    }

    html += card(`Responding · ${responding.length}`, responding.length ? `<div class="members">${responding.map((r) => `<span class="chip-m">${esc(r.teamCallsign ?? r.callsign ?? '')} ${esc(r.name)}${r.etaMin && r.status === 'responding' ? ` <small>${r.etaMin}m</small>` : ''}</span>`).join('')}</div>` : note('Nobody has responded yet'));
    if (!myFix && !tracking.needsSetup) html += note(tracking.linked ? 'Your position is not being received yet. Open OwnTracks and tap Publish; check location is allowed Always. To set it up again: More → Phones.' : 'Your position is not being received. Set up OwnTracks under More → Phones.', 'warn');
  } else {
    html += card('Standby', `<p>No active callout.</p>${state.mode.lastIncident ? `<p class="muted">Last: ${esc(state.mode.lastIncident.text.slice(0, 120))}</p>` : ''}`);
  }

  root.innerHTML = html;
  wireSetup(root);
  wireActions(root, {
    respond: () => respond('responding'),
    'on-scene': () => respond('on-scene'),
    'stand-down': () => respond('stood-down'),
    unavailable: () => respond('unavailable'),
  });
  root.querySelectorAll<HTMLElement>('[data-action^="respond-eta:"]').forEach((el) => el.addEventListener('click', () => respond('responding', Number(el.dataset.action!.split(':')[1]))));

  async function respond(status: ResponseStatus, etaMin?: number) {
    const id = store.s.search?.incident?.id ?? inc?.id;
    if (!id) return toast('No open incident', true);
    // First response on a phone that is not linked yet: hand the credential to OwnTracks now,
    // from this tap, so tracking starts without a second visit to the setup card.
    const launched = status === 'responding' && tracking.needsSetup && tracking.launch();
    await put(`/api/incidents/${id}/response`, { status, etaMin });
    toast(launched ? 'Responding · finishing OwnTracks setup' : status === 'responding' ? 'Marked as responding' : status === 'on-scene' ? 'On scene' : 'Updated');
  }
}
