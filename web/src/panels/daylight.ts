import type { DashboardState } from '../../../shared/types';
import { esc, fmtDurationMin, fmtTime } from '../format';
import { panel, placeholder } from './common';

export function renderDaylight(s: DashboardState, compact = false): string {
  const sun = s.sun;
  if (!sun) return panel('sun', 'DAYLIGHT', placeholder('—'), s, ['sunMoon']);
  const dark = !sun.isDaylight && sun.daylightRemainingMin === 0;
  const title = dark ? 'DARK · SUNRISE IN' : sun.isDaylight ? 'DAYLIGHT REMAINING' : 'TWILIGHT · DARK IN';
  const main = dark
    ? `<div class="headline" data-countdown="${esc(sun.nextSunrise)}">${fmtDurationMin(sun.untilSunriseMin ?? 0)}</div>`
    : `<div class="headline" data-countdown="${esc(sun.civilDusk)}">${fmtDurationMin(sun.daylightRemainingMin)}</div>`;
  const body = `<div class="day-main ${dark ? 'dark' : ''}">${main}</div>
    ${
      compact
        ? ''
        : `<div class="kv-grid four">
      <div class="kv"><div class="k">SUNRISE</div><div class="v">${fmtTime(sun.sunrise)}</div></div>
      <div class="kv"><div class="k">SUNSET</div><div class="v">${fmtTime(sun.sunset)}</div></div>
      <div class="kv"><div class="k">DUSK (CIVIL)</div><div class="v">${fmtTime(sun.civilDusk)}</div></div>
      <div class="kv"><div class="k">MOON</div><div class="v">${sun.moonIlluminationPct}%<span class="small"> ${esc(shortPhase(sun.moonPhaseName))}</span></div></div>
    </div>`
    }`;
  return panel('sun', title, body, s, ['sunMoon'], compact ? 'compact' : '');
}

const shortPhase = (n: string) => n.replace('Waxing ', '↑').replace('Waning ', '↓').replace(' Moon', '').replace('Quarter', 'Qtr').replace('Crescent', 'Cres').replace('Gibbous', 'Gib');
