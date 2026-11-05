import { esc, fmtAgeShort } from '../../format';
import { store } from '../store';
import { card, note, statusBadge } from '../ui';

export function renderTeam(root: HTMLElement): void {
  const { search } = store.s;
  if (!search?.incident) {
    root.innerHTML = card('Teams', note('No active incident.'));
    return;
  }
  const inTeam = new Set(search.teams.flatMap((t) => t.members.map((m) => m.userId)));
  const unassigned = search.responders.filter((r) => !inTeam.has(r.userId) && r.status !== 'stood-down' && r.status !== 'unavailable');
  let html = '';
  if (store.isManager) html += `<a class="btn primary wide" href="/sm/" target="_blank" rel="noopener">Open search manager console</a>`;
  for (const t of search.teams) {
    const targets = search.targets.filter((x) => x.teamId === t.id && x.status !== 'cancelled');
    html += `<section class="card team-card" style="--team:${esc(t.colour)}">
      <h2><span class="swatch"></span>${esc(t.name)} <span class="badge-s grey">${esc(t.status)}</span></h2>
      ${t.members.map((m) => {
        const fix = search.latest[m.userId];
        return `<div class="member-row"><b>${esc(m.callsign)}</b> ${esc(m.name)}${m.position === 0 ? ' <span class="badge-s blue">leader</span>' : ''}<span class="muted right">${fix ? `${fmtAgeShort(fix.tst)} ago${fix.alt !== undefined ? ` · ${Math.round(fix.alt)} m` : ''}` : 'no fix'}</span></div>`;
      }).join('') || note('No members yet')}
      ${targets.length ? `<div class="k">TARGETS</div>${targets.map((x) => `<div class="target-row"><b>${esc(x.name)}</b> <span class="badge-s ${x.status === 'done' ? 'green' : x.status === 'in-progress' ? 'amber' : 'grey'}">${esc(x.status)}</span></div>`).join('')}` : ''}
    </section>`;
  }
  html += card(
    `Responding, not yet in a team · ${unassigned.length}`,
    unassigned.length ? unassigned.map((r) => `<div class="member-row">${esc(r.name)} ${statusBadge(r.status)}${r.etaMin ? ` <span class="muted">ETA ${r.etaMin} min</span>` : ''}</div>`).join('') : note('None'),
  );
  root.innerHTML = html;
}
