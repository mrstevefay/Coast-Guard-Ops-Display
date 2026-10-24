const TZ = 'Europe/Dublin';
const hm = new Intl.DateTimeFormat('en-IE', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const hms = new Intl.DateTimeFormat('en-IE', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const dmy = new Intl.DateTimeFormat('en-IE', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' });
const wd = new Intl.DateTimeFormat('en-IE', { timeZone: TZ, weekday: 'long' });

export const fmtTime = (iso: string | Date | undefined) => (iso ? hm.format(typeof iso === 'string' ? new Date(iso) : iso) : '--:--');
export const fmtTimeS = (d: Date) => hms.format(d);
export const fmtDate = (d: Date) => dmy.format(d);
export const fmtWeekday = (d: Date) => wd.format(d);

/** "1 h 23 m", "47 m", "0 m" */
export function fmtDurationMin(min: number): string {
  if (!Number.isFinite(min)) return '--';
  const m = Math.max(0, Math.round(min));
  const h = Math.floor(m / 60);
  return h > 0 ? `${h} h ${String(m % 60).padStart(2, '0')} m` : `${m} m`;
}

/** "01:23:45" elapsed */
export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export const n0 = (v: number | undefined, unit = '') => (v === undefined || v === null ? '—' : `${Math.round(v)}${unit}`);
export const n1 = (v: number | undefined, unit = '') => (v === undefined || v === null ? '—' : `${v.toFixed(1)}${unit}`);
export const n2 = (v: number | undefined, unit = '') => (v === undefined || v === null ? '—' : `${v.toFixed(2)}${unit}`);

export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function ageMin(iso?: string): number | undefined {
  if (!iso) return undefined;
  return (Date.now() - Date.parse(iso)) / 60_000;
}
