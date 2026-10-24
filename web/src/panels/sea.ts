import type { DashboardState, SeaStateReading } from '../../../shared/types';
import { esc, fmtTime, n0, n1 } from '../format';
import { panel, placeholder } from './common';

export function renderSea(s: DashboardState): string {
  const sea = s.sea;
  if (!sea?.local && !sea?.offshore) return panel('sea', 'SEA STATE', placeholder('Waiting for Marine Institute…'), s, ['waveModel', 'weatherBuoy']);
  const body = `${sea.local ? block(sea.local, true) : ''}${sea.offshore ? block(sea.offshore, false) : ''}`;
  return panel('sea', 'SEA STATE', body, s, ['waveModel', 'weatherBuoy']);
}

function block(r: SeaStateReading, primary: boolean): string {
  if (!primary) {
    return `<div class="sea-block offshore"><span class="sea-src">${esc(r.source)} ${fmtTime(r.time)}</span> · Hs <b>${n1(r.hsM)}</b> m · ${n0(r.periodS)} s${r.seaTempC !== undefined ? ` · sea <b>${n1(r.seaTempC)}</b>°C` : ''}${r.wind ? ` · wind <b>${n0(r.wind.speedKt)}</b> kt ${esc(r.wind.dirName)}` : ''}</div>`;
  }
  return `<div class="sea-block primary">
    <div class="sea-src">${esc(r.source)} ${fmtTime(r.time)}${r.isModel ? ' <span class="est">SWAN model</span>' : ''}</div>
    <div class="sea-vals">
      <div class="kv"><div class="k">Hs</div><div class="v big">${n1(r.hsM)}<span class="small"> m</span></div></div>
      <div class="kv"><div class="k">PERIOD</div><div class="v">${n0(r.periodS)}<span class="small"> s</span></div></div>
      <div class="kv"><div class="k">FROM</div><div class="v">${n0(r.dirDeg, '°')}</div></div>
      ${r.seaTempC !== undefined ? `<div class="kv"><div class="k">SEA</div><div class="v">${n1(r.seaTempC)}<span class="small">°C</span></div></div>` : ''}
    </div>
  </div>`;
}
