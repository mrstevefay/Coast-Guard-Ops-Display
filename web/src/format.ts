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

/** "12 s", "4 m", "2 h" from a unix-seconds or ms timestamp. */
export function fmtAgeShort(tstSec: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - tstSec));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} m`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86400)} d`;
}

/** Great-circle distance in metres. */
export function distanceM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Initial bearing in degrees true. */
export function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

export function fmtDistance(m: number): string {
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
}
