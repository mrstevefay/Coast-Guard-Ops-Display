import { renderDaylight } from '../../panels/daylight';
import { renderSea } from '../../panels/sea';
import { renderSeaArea } from '../../panels/seaArea';
import { renderTide } from '../../panels/tide';
import { renderWarnings } from '../../panels/warnings';
import { renderForecastStrip, renderWind } from '../../panels/wind';
import { store } from '../store';
import { note } from '../ui';

/** Weather, tide and sea-area pages reuse the TV panel renderers under mobile CSS. */
export function renderWeather(root: HTMLElement): void {
  const s = store.s.state;
  if (!s) return void (root.innerHTML = note('Connecting…'));
  root.innerHTML = `${renderWarnings(s)}${renderWind(s)}${renderForecastStrip(s)}`;
}

export function renderTidePage(root: HTMLElement): void {
  const s = store.s.state;
  if (!s) return void (root.innerHTML = note('Connecting…'));
  root.innerHTML = `${renderTide(s)}${renderSea(s)}${renderDaylight(s)}`;
}

export function renderSaf(root: HTMLElement): void {
  const s = store.s.state;
  if (!s) return void (root.innerHTML = note('Connecting…'));
  const f = s.seaArea;
  root.innerHTML = `${renderSeaArea(s, true)}${
    f
      ? `<section class="card"><h2>Full forecast</h2>
        ${f.smallCraft ? `<p><b>Small Craft:</b> ${esc(f.smallCraft)}</p>` : ''}
        ${f.galeWarning ? `<p><b>Gale warning:</b> ${esc(f.galeWarning)}</p>` : ''}
        ${f.situation ? `<p><b>Situation:</b> ${esc(f.situation)}</p>` : ''}
        ${f.sections.map((sec) => `<h3>${esc(sec.title)}</h3><p><b>Wind:</b> ${esc(sec.wind)}</p><p><b>Weather:</b> ${esc(sec.weather)}</p><p><b>Visibility:</b> ${esc(sec.visibility)}</p>${sec.seaState ? `<p><b>Sea state:</b> ${esc(sec.seaState)}</p>` : ''}`).join('')}
        ${f.outlook ? `<h3>Outlook</h3><p>${esc(f.outlook)}</p>` : ''}
        </section>`
      : ''
  }`;
}

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
