import type { DashboardState, ProviderHealth } from '../../../shared/types';
import { esc, fmtTime } from '../format';

/** Panel shell with title and a stale/error badge derived from provider health. */
export function panel(id: string, title: string, body: string, s: DashboardState, providers: string[], extraClass = ''): string {
  const badge = staleBadge(s, providers);
  return `<section class="panel ${esc(extraClass)}" id="panel-${esc(id)}">
    <header class="panel-head"><h2>${esc(title)}</h2>${badge}</header>
    <div class="panel-body">${body}</div>
  </section>`;
}

export function staleBadge(s: DashboardState, providers: string[]): string {
  const hs = providers.map((p) => s.providers[p]).filter(Boolean) as ProviderHealth[];
  const bad = hs.filter((h) => h.status === 'stale' || h.status === 'error');
  if (!bad.length) return '';
  const worst = bad.find((h) => h.status === 'error') ?? bad[0];
  if (!worst.lastSuccess) return `<span class="badge badge-error">NO DATA</span>`;
  return `<span class="badge badge-stale">STALE since ${fmtTime(worst.lastSuccess)}</span>`;
}

export const placeholder = (text: string) => `<div class="placeholder">${esc(text)}</div>`;

export function arrow(deg: number, size = 120, cls = 'wind-arrow'): string {
  // Arrow points in the direction the wind is blowing TO (from + 180).
  return `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 100 100" aria-hidden="true">
    <circle cx="50" cy="50" r="46" class="compass-ring"/>
    <text x="50" y="14" class="compass-n">N</text>
    <g transform="rotate(${(deg + 180) % 360} 50 50)">
      <path d="M50 12 L64 46 L54 46 L54 86 L46 86 L46 46 L36 46 Z" class="arrow-head"/>
    </g>
  </svg>`;
}
