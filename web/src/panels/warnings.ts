import type { DashboardState } from '../../../shared/types';
import { esc, fmtTime } from '../format';

export function renderWarnings(s: DashboardState): string {
  const list = (s.warnings?.active ?? []).filter((w) => w.local);
  if (!list.length) return '';
  const top = list[0];
  const others = list.slice(1);
  return `<div class="warnbar level-${esc(top.level)}">
    <div class="warn-main">
      <span class="warn-level">${esc(labelFor(top.level))}</span>
      <span class="warn-type">${esc(top.marine ? 'MARINE ' : '')}${esc(top.type.toUpperCase())}</span>
      <span class="warn-text">${esc(top.headline)} · ${fmtTime(top.onset)}–${fmtTime(top.expires)}</span>
    </div>
    ${others.length ? `<div class="warn-others">${others.map((w) => `<span class="warn-chip level-${esc(w.level)}">${esc(w.marine ? 'Marine ' : '')}${esc(w.type)}</span>`).join('')}</div>` : ''}
  </div>`;
}

function labelFor(level: string): string {
  return level === 'advisory' ? 'WARNING' : `STATUS ${level.toUpperCase()}`;
}
