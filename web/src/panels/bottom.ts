import type { DashboardState, ProviderHealth } from '../../../shared/types';
import { esc, fmtTime } from '../format';
import { panel, placeholder } from './common';

export function renderMuster(s: DashboardState, large = false): string {
  const m = s.muster;
  if (!m) return panel('muster', 'CREW MUSTER', placeholder('—'), s, ['muster']);
  const responding = m.responders.filter((r) => r.status === 'responding' || r.status === 'on-scene');
  const count = responding.length;
  const ok = count >= m.minimumCrew;
  const roles = m.requiredRoles
    .map((role, i) => {
      const filled = (m.roles[role] ?? [])[i] ?? (m.roles[role] ?? [])[0];
      const who = filled ? m.responders.find((r) => r.id === filled)?.name : undefined;
      return `<div class="role ${who ? 'filled' : 'open'}"><div class="role-name">${esc(role)}</div><div class="role-who">${esc(who ?? '—')}</div></div>`;
    })
    .join('');
  const list = responding.length
    ? `<div class="responders">${responding.map((r) => `<span class="resp ${esc(r.status)}">${esc(r.name)}${r.etaMin !== undefined ? ` <small>${r.etaMin} min</small>` : ''}</span>`).join('')}</div>`
    : `<div class="placeholder">${m.source === 'stub' ? 'Crew muster arrives in Phase 2 (WhatsApp) / Phase 3 (D4H)' : 'No responders yet'}</div>`;
  const body = `<div class="muster-row">
      <div class="muster-count ${ok ? 'ok' : 'short'}"><div class="headline">${count}<span class="unit">/${m.minimumCrew}</span></div><div class="k">RESPONDING</div></div>
      <div class="roles">${roles}</div>
    </div>${large ? list : ''}`;
  return panel('muster', 'CREW MUSTER', body, s, ['muster'], large ? 'large' : '');
}

export function renderAis(s: DashboardState): string {
  const a = s.ais;
  const h = s.providers.ais;
  if (!a || h?.status === 'stub') return panel('ais', 'AIS', `<div class="headline small-head muted">—</div><div class="placeholder">${esc(h?.note ?? 'No AIS key')}</div>`, s, []);
  return panel('ais', 'AIS — DUBLIN BAY', `<div class="headline small-head">${a.count}</div><div class="k">VESSELS IN AREA${a.connected ? '' : ' · LINK DOWN'}</div>${a.updatedAt ? `<div class="muted">last fix ${fmtTime(a.updatedAt)}</div>` : ''}`, s, ['ais']);
}

export function renderWebcam(s: DashboardState): string {
  const w = s.webcam;
  if (!w?.configured || !w.imageUrl) return panel('webcam', 'WEBCAM', placeholder('No webcam configured'), s, []);
  const src = `${w.imageUrl}${w.imageUrl.includes('?') ? '&' : '?'}t=${Math.floor(Date.now() / (w.refreshSec * 1000))}`;
  return panel('webcam', `WEBCAM — ${w.label ?? ''}`, `<img class="webcam-img" src="${esc(src)}" alt="webcam" onerror="this.style.opacity=0.2" />`, s, ['webcam']);
}

export function renderHealth(s: DashboardState): string {
  const list = Object.values(s.providers).filter((p) => p.status !== 'disabled');
  const dots = list
    .map((p: ProviderHealth) => `<div class="dot-row"><span class="dot dot-${esc(p.status)}"></span><span class="dot-name">${esc(short(p.name))}</span><span class="dot-time muted">${p.lastSuccess ? fmtTime(p.lastSuccess) : ''}</span></div>`)
    .join('');
  return panel('health', 'FEEDS', `<div class="dots">${dots}</div>`, s, []);
}

const SHORT: Record<string, string> = {
  metForecast: 'Met forecast',
  metObservations: 'Met obs',
  metWarnings: 'Warnings',
  metSeaArea: 'Sea area fc',
  tidePrediction: 'Tide pred',
  tideGauge: 'Tide gauge',
  waveModel: 'Wave model',
  dublinBayBuoy: 'DB buoy',
  weatherBuoy: 'M2 buoy',
  sunMoon: 'Sun/moon',
  ais: 'AIS',
  webcam: 'Webcam',
  muster: 'Muster',
};
const short = (n: string) => SHORT[n] ?? n;
