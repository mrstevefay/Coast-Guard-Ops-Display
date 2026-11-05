import type { DashboardState, SeaStateReading } from '../../../shared/types';
import { esc, fmtTime, n0, n1 } from '../format';
import { panel, placeholder } from './common';

export function renderSea(s: DashboardState): string {
  const sea = s.sea;
  const primary = sea?.local ?? sea?.model;
  if (!primary && !sea?.offshore) return panel('sea', 'SEA STATE', placeholder('Waiting for buoy / Marine Institute…'), s, ['dublinBayBuoy', 'waveModel', 'weatherBuoy']);
  const body = `${primary ? block(primary, true) : ''}${sea?.offshore ? block(sea.offshore, false) : ''}`;
  const providers = sea?.local ? ['dublinBayBuoy', 'weatherBuoy'] : ['waveModel', 'weatherBuoy'];
  return panel('sea', 'SEA STATE', body, s, providers);
}

function block(r: SeaStateReading, primary: boolean): string {
  if (!primary) {
    return `<div class="sea-block offshore"><span class="sea-src">${esc(r.source)} ${fmtTime(r.time)}</span> · Hs <b>${n1(r.hsM)}</b> m · ${n0(r.periodS)} s${r.seaTempC !== undefined ? ` · sea <b>${n1(r.seaTempC)}</b>°C` : ''}${r.wind ? ` · wind <b>${n0(r.wind.speedKt)}</b> kt ${esc(r.wind.dirName)}` : ''}</div>`;
  }
  return `<div class="sea-block primary">
    <div class="sea-src">${esc(r.source)} ${fmtTime(r.time)}${r.isModel ? ' <span class="est">SWAN model</span>' : ''}${r.gale ? ' <span class="gale">GALE</span>' : ''}</div>
    <div class="sea-vals">
      <div class="kv"><div class="k">Hs</div><div class="v big">${n1(r.hsM)}<span class="small"> m</span></div></div>
      ${r.periodS !== undefined ? `<div class="kv"><div class="k">PERIOD</div><div class="v">${n0(r.periodS)}<span class="small"> s</span></div></div>` : ''}
      ${r.dirDeg !== undefined ? `<div class="kv"><div class="k">FROM</div><div class="v">${n0(r.dirDeg, '°')}</div></div>` : ''}
      ${r.wind ? `<div class="kv"><div class="k">WIND</div><div class="v">${n0(r.wind.speedKt)}<span class="small"> kt ${esc(r.wind.dirName)}${r.wind.gustKt !== undefined ? ` g${n0(r.wind.gustKt)}` : ''}</span></div></div>` : ''}
      ${r.seaTempC !== undefined ? `<div class="kv"><div class="k">SEA</div><div class="v">${n1(r.seaTempC)}<span class="small">°C</span></div></div>` : ''}
    </div>
  </div>`;
}
