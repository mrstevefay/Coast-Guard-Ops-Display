import { FIND_LABEL, FIND_TYPES, POINT_KIND_LABEL, type FindType, type TargetCoverage } from '../../../../shared/types';
import { POD_LEVELS } from '../../../../shared/searchtheory';
import { profileBySlug } from '../../../../shared/lpb/index';
import type { IncidentSubject, ResponseStatus, SearchIncident } from '../../../../shared/types';
import { get, post, put } from '../../api';
import { bearingDeg, distanceM, esc, fmtDistance, fmtTime } from '../../format';
import { anchorOf } from '../../map';
import { renderWarnings } from '../../panels/warnings';
import { store } from '../store';
import { tracking } from '../tracking';
import { btn, card, note, statusBadge, toast, wireActions } from '../ui';
import { alertsOffer, wireAlerts } from './alerts';

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

/** Subject details are fetched on demand (never in the snapshot) and cached per incident+version. */
let subjectCache: { key: string; subject: IncidentSubject | null; loading?: boolean } | undefined;
function subjectFor(inc: SearchIncident): IncidentSubject | null | undefined {
  const key = `${inc.id}:${inc.subjectUpdatedAt ?? ''}`;
  if (subjectCache?.key === key) return subjectCache.subject;
  if (!inc.subjectUpdatedAt) return null;
  if (subjectCache?.loading && subjectCache.key === key) return undefined;
  subjectCache = { key, subject: null, loading: true };
  get<{ subject: IncidentSubject | null }>(`/api/incidents/${inc.id}/subject`)
    .then((r) => { subjectCache = { key, subject: r.subject }; store.notify(); })
    .catch(() => { subjectCache = undefined; });
  return undefined;
}

/** Subject card: one line (photo, name, age) until tapped open; the open state survives re-renders. */
let subjectOpen = false;
function subjectCard(inc: SearchIncident): string {
  const s = subjectFor(inc);
  if (s === undefined) return card('Subject', note('Loading details…'));
  if (!s) return '';
  const photo = s.hasPhoto ? `<img src="/api/incidents/${inc.id}/subject/photo?t=${encodeURIComponent(s.photoUpdatedAt ?? '')}" alt="Subject" />` : '';
  const category = profileBySlug(s.category)?.name ?? '';
  const flags = [...new Set([category, s.despondent ? 'Despondent' : '', s.mentalHealth ? 'Mental health' : '', s.selfHarmHistory ? `Previous self-harm${s.selfHarmMeans ? `: ${s.selfHarmMeans}` : ''}` : ''].filter(Boolean))];
  const kv = (label: string, v?: string) => (v ? `<div><span>${label}</span>${esc(v)}</div>` : '');
  const who = [s.sex, s.age !== undefined ? `${s.age} yrs` : ''].filter(Boolean).join(' · ');
  return `<details class="card subject-card" id="subject-card" ${subjectOpen ? 'open' : ''}>
    <summary class="subject-head">${photo}<div class="grow"><div class="k">SUBJECT</div><div class="subject-name">${esc(s.name ?? 'Unknown')}</div><div class="muted">${esc(who)}</div></div><span class="muted small subject-more">${subjectOpen ? 'Less' : 'Details'}</span></summary>
    ${flags.length ? `<div class="subject-flags">${flags.map((f) => `<span class="badge-s amber">${esc(f)}</span>`).join('')}</div>` : ''}
    <div class="subject-kv">${kv('CLOTHING / APPEARANCE', s.clothing)}${kv('DESCRIPTION', s.description)}${kv('SIGNIFICANT LOCATIONS', s.locations)}${kv('RELEVANT HISTORY', s.history)}</div>
    <p class="muted small">Shared with crew only. Do not forward.</p>
  </details>`;
}

/** "How thorough was it?" asked for this target; the tracks' suggestion per target. */
let podFor: number | undefined;
const podHint = new Map<number, TargetCoverage>();

/** Report-a-find form state; kept across re-renders. */
let findOpen = false;
let findType: FindType | undefined;
let findNote = '';

/** The phone's own position for a find, if the browser gives it within a few seconds; the server falls back to the last OwnTracks fix. */
function phonePosition(): Promise<{ lat: number; lon: number } | undefined> {
  if (!navigator.geolocation) return Promise.resolve(undefined);
  return new Promise((resolve) => navigator.geolocation.getCurrentPosition((p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }), () => resolve(undefined), { enableHighAccuracy: true, timeout: 6000, maximumAge: 30000 }));
}

/** Opens the phone's maps app with directions (Google Maps link: works on iPhone and Android). */
const navLink = (lat: number, lon: number) => `<a class="btn small nav" href="https://www.google.com/maps/dir/?api=1&destination=${lat.toFixed(6)},${lon.toFixed(6)}" target="_blank" rel="noopener">Navigate</a>`;

export function renderStatus(root: HTMLElement): void {
  const { state, search, me } = store.s;
  if (!state) {
    root.innerHTML = note('Connecting…');
    return;
  }
  const callout = state.mode.mode === 'callout' ? state.mode.incident : undefined;
  // A tasking is a search opened from the console without paging anyone.
  const tasking = !callout && search?.incident?.kind === 'tasking' ? search.incident : undefined;
  const inc = callout ?? tasking;
  const { response, team, member } = store.mine;
  const responding = (search?.responders ?? []).filter((r) => r.status === 'responding' || r.status === 'on-scene');
  const myFix = me ? search?.latest[me.id] : undefined;
  const fromMe = (lat: number, lon: number) => (myFix ? `${fmtDistance(distanceM(myFix.lat, myFix.lon, lat, lon))} · ${Math.round(bearingDeg(myFix.lat, myFix.lon, lat, lon)).toString().padStart(3, '0')}° from you` : '');
  const startedAt = callout?.receivedAt ?? tasking?.startedAt;

  let html = renderWarnings(state);
  if (!inc) {
    html += card('Standby', `<p>No active callout or tasking.</p>${state.mode.lastIncident ? `<p class="muted">Last: ${esc(state.mode.lastIncident.text.slice(0, 120))}</p>` : ''}`);
    root.innerHTML = html + alertsOffer();
    wireSetup(root);
    wireAlerts(root);
    return;
  }

  const st = response?.status;
  const answered = Boolean(st) && st !== 'stood-down' && st !== 'unavailable' && st !== 'available';
  const points = search?.incident?.points ?? (search?.incident?.ipp ? [{ id: 0, kind: 'lkp' as const, label: search.incident.ipp.label, lat: search.incident.ipp.lat, lon: search.incident.ipp.lon }] : []);
  const place = (lat: number, lon: number) => `<div class="place-row"><span class="muted small grow">${myFix ? fromMe(lat, lon) : `${lat.toFixed(4)}, ${lon.toFixed(4)}`}</span>${navLink(lat, lon)}</div>`;
  const incidentCard = `<section class="card incident-card ${tasking ? 'tasking' : ''}">
      <div class="k">${tasking ? 'TASKING STARTED' : 'RECEIVED'} ${fmtTime(startedAt)}</div>
      <div class="inc-text-m">${esc(inc.text)}</div>
      ${inc.lat !== undefined && inc.lon !== undefined && !points.length ? place(inc.lat, inc.lon) : ''}
      ${points.map((p) => `<div class="ipp-row k-${p.kind}"><b>${esc(POINT_KIND_LABEL[p.kind])}${p.label ? ` · ${esc(p.label)}` : ''}</b>${place(p.lat, p.lon)}</div>`).join('')}
    </section>`;
  const respondCard = answered
    ? `<section class="card respond compact">
        <div class="respond-state">${statusBadge(st!)} ${response?.etaMin && st === 'responding' ? `<span class="muted">ETA ${response.etaMin} min</span>` : ''}</div>
        <div class="btn-row">${st !== 'on-scene' ? btn('ON SCENE', 'on-scene', 'primary') : ''}${btn('STAND DOWN', 'stand-down', 'ghost')}</div>
      </section>`
    : `<section class="card respond">
        ${btn("I'M RESPONDING", 'respond', 'primary huge')}
        <div class="eta-row muted">ETA: ${[5, 10, 15, 20, 30].map((m) => btn(`${m} min`, `respond-eta:${m}`, 'chip')).join('')}</div>
        ${btn("Can't make it", 'unavailable', 'ghost')}
      </section>`;

  // my target and team: the next thing to do once the manager has tasked me
  let targetCard = '', teamCard = '';
  if (team && member) {
    const targets = (search?.targets ?? []).filter((t) => t.teamId === team.id && t.status !== 'cancelled' && t.status !== 'done');
    targetCard = targets.length
      ? `<section class="card my-target" style="--team:${esc(team.colour)}"><div class="k">${targets.length > 1 ? 'YOUR TARGETS' : 'YOUR TARGET'}</div>${targets.map((t) => {
          const [lon, lat] = anchorOf(t.geometry);
          const hint = podHint.get(t.id);
          const step = podFor === t.id
            ? `<div class="pod-ask"><div class="k">HOW THOROUGH WAS IT?</div>${hint && hint.trackM > 0 ? `<p class="muted small">Your tracks suggest about ${Math.round(hint.pod * 100)} %.</p>` : ''}
                <div class="pod-grid">${POD_LEVELS.map((l) => `<button class="btn ${hint && Math.abs(hint.pod - l.pod) < 0.1 ? 'primary' : 'ghost'}" data-action="pod-pick" data-id="${t.id}" data-pod="${l.pod}">${esc(l.label)}<small>${Math.round(l.pod * 100)} %</small></button>`).join('')}</div>
                <button class="btn ghost small" data-action="pod-cancel">Not finished yet</button></div>`
            : t.status === 'in-progress'
              ? `<button class="btn primary wide" data-action="pod-open" data-id="${t.id}">AREA SEARCHED</button>`
              : `<button class="btn primary wide" data-action="target-step" data-id="${t.id}" data-status="in-progress">START SEARCH</button>`;
          return `<div class="target-row"><div><b>${esc(t.name)}</b> <span class="badge-s ${t.status === 'in-progress' ? 'amber' : 'grey'}">${t.status === 'in-progress' ? 'searching' : esc(t.status)}</span></div>${t.notes ? `<div class="muted small">${esc(t.notes)}</div>` : ''}${place(lat, lon)}${step}</div>`;
        }).join('')}<div class="muted small">Sweep ${team.searchWidthM} m each side</div>
        <button class="btn ghost wide" data-action="find-open">Report a find</button></section>`
      : '';
    teamCard = `<section class="card team-mine" style="--team:${esc(team.colour)}">
        <div class="team-line"><span class="callsign">${esc(member.callsign)}</span><span class="muted">Team ${esc(team.name)}${member.position === 0 ? ' · leader' : ''}</span></div>
        <div class="members">${team.members.filter((m) => m.userId !== member.userId).map((m) => `<span class="chip-m ${m.position === 0 ? 'leader' : ''}">${esc(m.callsign)} ${esc(m.name.split(' ')[0])}</span>`).join('')}</div>
        ${targetCard ? '' : note('No target assigned yet')}
      </section>`;
  }
  const subject = search?.incident ? subjectCard(search.incident) : '';
  const others = `<a class="card responding-line" href="#/team"><b>${responding.length}</b> responding<span class="muted right">Team ›</span></a>`;
  const noFix = !myFix && !tracking.needsSetup && answered ? note(tracking.linked ? 'Your position is not being received yet. Open OwnTracks and tap Publish; check location is allowed Always.' : 'Your position is not being received. Set up OwnTracks under More → Phones.', 'warn') : '';
  const setup = tracking.needsSetup ? setupCard() : '';

  const findCard = findOpen ? `<section class="card find-card"><h2>Report a find</h2>
      <div class="find-types">${FIND_TYPES.map((t) => `<button class="btn ${findType === t ? 'primary' : 'ghost'} ${t === 'subject' ? 'subject' : ''}" data-action="find-type" data-type="${t}">${esc(FIND_LABEL[t])}</button>`).join('')}</div>
      <textarea id="find-note" rows="2" maxlength="500" placeholder="What, and anything the manager needs to know">${esc(findNote)}</textarea>
      <p class="muted small">Sent with your phone's position${myFix ? '' : ' (allow location if asked)'}.</p>
      <div class="btn-row"><button class="btn primary" data-action="find-send" ${findType ? '' : 'disabled'}>Send</button><button class="btn ghost" data-action="find-cancel">Cancel</button></div>
    </section>` : '';
  if (answered) html += findCard;
  if (answered && !targetCard && !findOpen) html += `<section class="card"><button class="btn ghost wide" data-action="find-open">Report a find</button></section>`;

  // order by stage: alerted → responding → tasked
  if (!answered) html += incidentCard + respondCard + setup + subject + others;
  else if (targetCard) html += targetCard + teamCard + subject + respondCard + incidentCard + setup + noFix + others;
  else html += respondCard + setup + noFix + (teamCard || '') + subject + incidentCard + others;
  html += alertsOffer(); // last: never in the way of responding

  root.innerHTML = html;
  root.querySelector<HTMLTextAreaElement>('#find-note')?.addEventListener('input', (ev) => { findNote = (ev.target as HTMLTextAreaElement).value; });
  root.querySelector<HTMLDetailsElement>('#subject-card')?.addEventListener('toggle', (ev) => {
    subjectOpen = (ev.target as HTMLDetailsElement).open;
    const more = root.querySelector('.subject-more');
    if (more) more.textContent = subjectOpen ? 'Less' : 'Details';
  });
  wireSetup(root);
  wireAlerts(root);
  wireActions(root, {
    respond: () => respond('responding'),
    'on-scene': () => respond('on-scene'),
    'stand-down': () => respond('stood-down'),
    unavailable: () => respond('unavailable'),
    'target-step': async (el) => {
      (el as HTMLButtonElement).disabled = true;
      await post(`/api/targets/${el.dataset.id}/progress`, { status: el.dataset.status });
      toast(el.dataset.status === 'done' ? 'Area searched: the manager can see it' : 'Search started');
    },
    'pod-open': (el) => {
      podFor = Number(el.dataset.id);
      store.notify();
      get<{ coverage: TargetCoverage }>(`/api/targets/${podFor}/coverage`).then((r) => { podHint.set(podFor!, r.coverage); store.notify(); }).catch(() => {});
    },
    'pod-cancel': () => { podFor = undefined; store.notify(); },
    'pod-pick': async (el) => {
      root.querySelectorAll<HTMLButtonElement>('[data-action=pod-pick]').forEach((b) => (b.disabled = true));
      try {
        await post(`/api/targets/${el.dataset.id}/progress`, { status: 'done', pod: Number(el.dataset.pod) });
        podFor = undefined;
        toast('Area searched: the manager can see it');
      } finally {
        store.notify();
      }
    },
    'find-open': () => { findOpen = true; findType = undefined; findNote = ''; store.notify(); window.scrollTo({ top: 0 }); },
    'find-cancel': () => { findOpen = false; store.notify(); },
    'find-type': (el) => {
      // update the form in place: a redraw is held back while the note box has focus
      findType = el.dataset.type as FindType;
      root.querySelectorAll<HTMLElement>('[data-action=find-type]').forEach((b) => { const on = b.dataset.type === findType; b.classList.toggle('primary', on); b.classList.toggle('ghost', !on); });
      const send = root.querySelector<HTMLButtonElement>('[data-action=find-send]');
      if (send) send.disabled = false;
    },
    'find-send': async (el) => {
      if (!findType) return;
      const id = store.s.search?.incident?.id;
      if (!id) return;
      (el as HTMLButtonElement).disabled = true;
      const note = root.querySelector<HTMLTextAreaElement>('#find-note')?.value ?? '';
      const pos = await phonePosition();
      try {
        await post(`/api/incidents/${id}/finds`, { type: findType, note, lat: pos?.lat, lon: pos?.lon });
        findOpen = false;
        toast(`${FIND_LABEL[findType]} reported`);
        store.notify();
      } catch (e) {
        (el as HTMLButtonElement).disabled = false;
        throw e;
      }
    },
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
