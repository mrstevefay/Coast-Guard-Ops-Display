import { renderDaylight } from '../../panels/daylight';
import { renderSea } from '../../panels/sea';
import { renderSeaArea } from '../../panels/seaArea';
import { renderTide } from '../../panels/tide';
import { renderWarnings } from '../../panels/warnings';
import { renderForecastStrip, renderWind } from '../../panels/wind';
import { store } from '../store';
import { note } from '../ui';

/**
 * Conditions: weather, tide, sea and daylight on one page (they are read together before going
 * out), with the full Sea Area Forecast folded at the end. Old #/weather, #/tide and #/saf links
 * land here, scrolled to their section.
 */
export function renderConditions(root: HTMLElement, from: string = 'conditions'): void {
  const s = store.s.state;
  if (!s) return void (root.innerHTML = note('Connecting…'));
  const f = s.seaArea;
  const open = root.querySelector<HTMLDetailsElement>('#saf-full')?.open ?? from === 'saf';
  root.innerHTML = `${renderWarnings(s)}<div id="c-weather">${renderWind(s)}${renderForecastStrip(s)}</div>
    <div id="c-tide">${renderTide(s)}${renderSea(s)}${renderDaylight(s)}</div>
    <div id="c-saf">${renderSeaArea(s, true)}${f ? `<details class="card" id="saf-full" ${open ? 'open' : ''}><summary><h2 style="display:inline">Full sea area forecast</h2></summary>
        ${f.smallCraft ? `<p><b>Small Craft:</b> ${esc(f.smallCraft)}</p>` : ''}
        ${f.galeWarning ? `<p><b>Gale warning:</b> ${esc(f.galeWarning)}</p>` : ''}
        ${f.situation ? `<p><b>Situation:</b> ${esc(f.situation)}</p>` : ''}
        ${f.sections.map((sec) => `<h3>${esc(sec.title)}</h3><p><b>Wind:</b> ${esc(sec.wind)}</p><p><b>Weather:</b> ${esc(sec.weather)}</p><p><b>Visibility:</b> ${esc(sec.visibility)}</p>${sec.seaState ? `<p><b>Sea state:</b> ${esc(sec.seaState)}</p>` : ''}`).join('')}
        ${f.outlook ? `<h3>Outlook</h3><p>${esc(f.outlook)}</p>` : ''}
      </details>` : ''}</div>`;
  if (from !== 'conditions' && !root.dataset.scrolled) {
    root.dataset.scrolled = '1';
    document.getElementById(from === 'weather' ? 'c-weather' : from === 'tide' ? 'c-tide' : 'c-saf')?.scrollIntoView({ block: 'start' });
  }
}

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
