import type { DashboardState } from '../../../shared/types';
import { esc, fmtDate, fmtTimeS, fmtWeekday } from '../format';

/** `tasking` = a search is open from the console without a callout (display stays in standby). */
export function renderTopbar(s: DashboardState, tasking = false): string {
  const now = new Date();
  const modeTag = s.mode.mode === 'callout' ? '<span class="mode-tag mode-callout">CALLOUT</span>' : tasking ? '<span class="mode-tag mode-tasking">TASKING</span>' : '<span class="mode-tag mode-standby">STANDBY</span>';
  return `<div class="topbar">
    <div class="clock" id="clock">${fmtTimeS(now)}</div>
    <div class="station"><div class="station-name">${esc(s.station.name)}</div>${modeTag}<span class="conn" id="conn"></span></div>
    <div class="date"><div id="date">${fmtDate(now)}</div><div class="weekday" id="weekday">${fmtWeekday(now)}</div></div>
  </div>`;
}
