import type { ResponseStatus } from '../../../../shared/types';
import { put } from '../../api';
import { bearingDeg, distanceM, esc, fmtDistance, fmtElapsed, fmtTime } from '../../format';
import { anchorOf } from '../../map';
import { renderWarnings } from '../../panels/warnings';
import { store } from '../store';
import { btn, card, note, statusBadge, toast, wireActions } from '../ui';

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
    if (!myFix) html += note('Your position is not being received. Open OwnTracks and check it is set up under More → Phones.', 'warn');
  } else {
    html += card('Standby', `<p>No active callout.</p>${state.mode.lastIncident ? `<p class="muted">Last: ${esc(state.mode.lastIncident.text.slice(0, 120))}</p>` : ''}`);
  }

  root.innerHTML = html;
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
    await put(`/api/incidents/${id}/response`, { status, etaMin });
    toast(status === 'responding' ? 'Marked as responding' : status === 'on-scene' ? 'On scene' : 'Updated');
  }
}
