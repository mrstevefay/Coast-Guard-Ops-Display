import type { DashboardState } from '../../../shared/types';
import { esc, fmtTime } from '../format';
import { panel, placeholder } from './common';

/** Met Éireann Sea Area Forecast for the station's stretch of coast. */
export function renderSeaArea(s: DashboardState, large = false): string {
  const f = s.seaArea;
  if (!f) return panel('seaarea', 'SEA AREA FORECAST — MET ÉIREANN', placeholder('Waiting for Met Éireann…'), s, ['metSeaArea']);
  const a = f.area;
  const force = a.forceMin !== undefined ? (a.forceMax !== undefined && a.forceMax !== a.forceMin ? `F${a.forceMin}–${a.forceMax}` : `F${a.forceMin}`) : '—';
  const gale = a.forceMax !== undefined && a.forceMax >= 8;
  const strong = a.forceMax !== undefined && a.forceMax >= 6;
  const areaName = a.title.replace(/^Forecast for\s*/i, '').replace(/^(Irish coastal waters|all Irish coastal waters)\s*/i, (m) => m.replace(/all /i, 'All ')).trim();
  const body = `
    <div class="saf-grid ${large ? 'large' : ''}">
      <div class="saf-col">
        <div class="k">WIND</div>
        <div class="v big ${gale ? 'red' : strong ? 'amber' : ''}">${esc(a.direction ?? '')} ${esc(force)}</div>
        <div class="saf-text">${esc(a.wind)}</div>
      </div>
      <div class="saf-col">
        <div class="k">VISIBILITY</div>
        <div class="v vis-${esc(a.visibilityBand)}">${esc(visLabel(a.visibilityBand))}</div>
        <div class="saf-text">${esc(a.visibility)}</div>
      </div>
      ${large ? `<div class="saf-col"><div class="k">WEATHER</div><div class="saf-text tall">${esc(a.weather)}</div>${a.seaState ? `<div class="k">SEA STATE</div><div class="saf-text">${esc(a.seaState)}</div>` : ''}</div>` : ''}
    </div>
    <div class="saf-foot">
      ${f.galeWarning ? `<span class="chip red">GALE WARNING</span>` : ''}${f.smallCraft ? `<span class="chip amber">SMALL CRAFT</span>` : ''}
      <span class="muted saf-area">${esc(areaName)}</span>
      <span class="muted">· issued ${fmtTime(f.issuedAt)}${f.validTo ? ` · to ${fmtTime(f.validTo)}` : ''}</span>
    </div>`;
  return panel('seaarea', 'SEA AREA FORECAST — MET ÉIREANN', body, s, ['metSeaArea'], large ? 'large' : '');
}

function visLabel(b: string): string {
  return { good: 'Good', moderate: 'Moderate', poor: 'Poor', 'very-poor': 'Very poor', fog: 'Fog' }[b] ?? b;
}
