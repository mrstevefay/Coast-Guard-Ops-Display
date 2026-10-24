import type { DashboardState } from '../../../shared/types';
import { esc, fmtElapsed, fmtTime } from '../format';

export function renderIncident(s: DashboardState): string {
  const inc = s.mode.incident;
  if (!inc) return '';
  const loc = inc.lat !== undefined && inc.lon !== undefined ? `${inc.lat.toFixed(4)}, ${inc.lon.toFixed(4)}` : 'Location not given';
  return `<div class="incident">
    <div class="inc-left">
      <div class="k">CALLOUT RECEIVED ${fmtTime(inc.receivedAt)}</div>
      <div class="inc-text">${esc(inc.text)}</div>
      <div class="inc-loc">${esc(loc)}${inc.autoStanddownAt ? ` · auto stand-down ${fmtTime(inc.autoStanddownAt)}` : ''}</div>
    </div>
    <div class="inc-right">
      <div class="k">ELAPSED</div>
      <div class="elapsed" data-elapsed="${esc(inc.receivedAt)}">${fmtElapsed(Date.now() - Date.parse(inc.receivedAt))}</div>
    </div>
  </div>`;
}
