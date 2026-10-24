import type { DashboardState, TideState } from '../../../shared/types';
import { esc, fmtDurationMin, fmtTime, n2 } from '../format';
import { panel, placeholder } from './common';

export function renderTide(s: DashboardState, compact = false): string {
  const t = s.tide;
  if (!t || !t.next) return panel('tide', 'TIDE — HOWTH', placeholder('Waiting for Marine Institute…'), s, ['tidePrediction', 'tideGauge']);
  const minsToNext = (Date.parse(t.next.time) - Date.now()) / 60_000;
  const trend = t.rising === undefined ? '' : t.rising ? '▲ RISING' : '▼ FALLING';
  const height = t.observedM ?? t.predictedNowM;
  const body = `
    <div class="tide-row">
      <div class="tide-main">
        <div class="headline">${n2(height)}<span class="unit">m</span></div>
        <div class="sub">${t.observedM !== undefined ? `${fmtTime(t.observedAt)}` : 'pred'} ${trend}</div>
      </div>
      <div class="tide-next">
        <div class="k">NEXT ${esc(t.next.kind)}</div>
        <div class="v big" data-countdown="${esc(t.next.time)}">${fmtDurationMin(minsToNext)}</div>
        <div class="sub">${fmtTime(t.next.time)} · ${n2(t.next.heightM, ' m')}</div>
      </div>
    </div>
    ${compact ? '' : tideCurve(t)}
    ${
      compact
        ? ''
        : `<div class="tide-foot">${t.springNeap ? `<span class="chip">${esc(t.springNeap.toUpperCase())}</span>` : ''}${t.following ? `<span>→ ${esc(t.following.kind)} ${fmtTime(t.following.time)} ${n2(t.following.heightM, ' m')}</span>` : ''}${t.surgeM !== undefined ? `<span class="muted">surge ${t.surgeM >= 0 ? '+' : ''}${n2(t.surgeM)}</span>` : ''}</div>`
    }`;
  return panel('tide', 'TIDE — HOWTH', body, s, ['tidePrediction', 'tideGauge'], compact ? 'compact' : '');
}

function tideCurve(t: TideState): string {
  const pts = t.curve;
  if (pts.length < 3) return '';
  const W = 440, H = 64, padL = 8, padR = 8, padT = 5, padB = 17;
  const t0 = Date.parse(pts[0].time), t1 = Date.parse(pts[pts.length - 1].time);
  const hs = pts.map((p) => p.heightM);
  const hMin = Math.min(...hs, t.observedM ?? Infinity) - 0.2, hMax = Math.max(...hs, t.observedM ?? -Infinity) + 0.2;
  const x = (ms: number) => padL + ((ms - t0) / (t1 - t0)) * (W - padL - padR);
  const y = (h: number) => padT + (1 - (h - hMin) / (hMax - hMin)) * (H - padT - padB);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(Date.parse(p.time)).toFixed(1)} ${y(p.heightM).toFixed(1)}`).join(' ');
  const nowX = x(Date.now());
  const obs = t.observedM !== undefined && t.observedAt ? `<circle cx="${x(Date.parse(t.observedAt)).toFixed(1)}" cy="${y(t.observedM).toFixed(1)}" r="6" class="obs-dot"/>` : '';
  const events = t.events
    .filter((e) => Date.parse(e.time) >= t0 && Date.parse(e.time) <= t1)
    .map((e) => `<text x="${x(Date.parse(e.time)).toFixed(1)}" y="${H - 4}" class="ev">${e.kind} ${fmtTime(e.time)}</text>`)
    .join('');
  return `<svg class="tide-curve" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <path d="${d}" class="curve"/>
    <line x1="${nowX.toFixed(1)}" y1="${padT}" x2="${nowX.toFixed(1)}" y2="${H - padB}" class="now-line"/>
    ${obs}${events}
  </svg>`;
}
