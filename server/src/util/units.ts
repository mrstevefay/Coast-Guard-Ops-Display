import type { WindReading } from '../../../shared/types.js';

export const MPS_TO_KT = 1.943844;
export const KMH_TO_KT = 0.539957;

export function round(n: number, dp = 1): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

const DIRS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

export function compassName(deg: number): string {
  const i = Math.round((((deg % 360) + 360) % 360) / 22.5) % 16;
  return DIRS[i];
}

export function beaufort(kt: number): number {
  const limits = [1, 3, 6, 10, 16, 21, 27, 33, 40, 47, 55, 63];
  for (let i = 0; i < limits.length; i++) if (kt < limits[i]) return i;
  return 12;
}

export function wind(speedKt: number, dirDeg: number, gustKt?: number): WindReading {
  return {
    speedKt: round(speedKt, 0),
    gustKt: gustKt === undefined ? undefined : round(gustKt, 0),
    dirDeg: Math.round(dirDeg),
    dirName: compassName(dirDeg),
    beaufort: beaufort(speedKt),
  };
}

/** Great-circle distance in km. */
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
