import type { DashboardState } from '../../../shared/types';
import { esc, fmtTime, n0, n1 } from '../format';
import { arrow, panel, placeholder } from './common';

export function renderWind(s: DashboardState, compact = false): string {
  const w = s.weather?.now;
  if (!w) return panel('wind', 'WIND', placeholder('Waiting for Met Éireann…'), s, ['metForecast']);
  const obs = s.observed;
  const body = `
    <div class="wind-row">
      ${arrow(w.wind.dirDeg, compact ? 96 : 140)}
      <div class="wind-main">
        <div class="headline">${n0(w.wind.speedKt)}<span class="unit">kt</span></div>
        <div class="sub">${esc(w.wind.dirName)} ${n0(w.wind.dirDeg, '°')} · F${w.wind.beaufort}${compact ? ` · <span class="gust">gust <b>${n0(w.wind.gustKt)}</b></span>` : ''}</div>
        ${compact ? '' : `<div class="sub gust">GUST <b>${n0(w.wind.gustKt)}</b> kt</div>`}
      </div>
    </div>
    ${
      compact
        ? ''
        : obs
        ? `<div class="obs-row">${esc(obs.stationName)} obs ${fmtTime(obs.time)} · <b>${n0(obs.wind.speedKt)}</b> kt ${esc(obs.wind.dirName)} · g<b>${n0(obs.wind.gustKt)}</b></div>`
        : `<div class="obs-row muted">Forecast (Harmonie) for ${fmtTime(w.time)}</div>`
    }
    ${
      compact
        ? ''
        : `<div class="kv-grid">
      <div class="kv"><div class="k">VISIBILITY <span class="est">est.</span></div><div class="v vis-${esc(w.visibility.band)}">${esc(w.visibility.label)}</div></div>
      <div class="kv"><div class="k">PRECIP</div><div class="v">${n1(w.precipMm, ' mm')}<span class="small">${w.precipProbPct !== undefined ? ` ${w.precipProbPct}%` : ''}</span></div></div>
      <div class="kv"><div class="k">AIR</div><div class="v">${n0(w.tempC, '°C')}</div></div>
      <div class="kv"><div class="k">QNH</div><div class="v">${n0(w.pressureHpa)}<span class="small"> hPa</span></div></div>
    </div>`
    }`;
  return panel('wind', 'WIND', body, s, ['metForecast', 'metObservations'], compact ? 'compact' : '');
}

export function renderForecastStrip(s: DashboardState): string {
  const hours = s.weather?.hourly?.slice(0, 6) ?? [];
  if (!hours.length) return panel('strip', 'NEXT 6 H', placeholder('—'), s, ['metForecast']);
  const cells = hours
    .map(
      (h) => `<div class="hour">
        <div class="h-time">${fmtTime(h.time)}</div>
        <div class="h-wind">${n0(h.wind.speedKt)}</div>
        <div class="h-gust">g${n0(h.wind.gustKt)}</div>
        <div class="h-dir">${esc(h.wind.dirName)}</div>
        <div class="h-rain ${h.precipMm >= 1 ? 'wet' : ''}">${h.precipMm > 0 ? n1(h.precipMm) : '·'}</div>
      </div>`,
    )
    .join('');
  return panel('strip', 'NEXT 6 H · kt / gust / dir / mm', `<div class="hours">${cells}</div>`, s, ['metForecast']);
}
