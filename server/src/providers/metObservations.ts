import type { DashboardData, ObservedWeather } from '../../../shared/types.js';
import type { AppConfig } from '../config.js';
import { fetchJson } from '../util/http.js';
import { KMH_TO_KT, round, wind } from '../util/units.js';
import type { Provider } from './types.js';

interface MetObsRow {
  name: string;
  temperature: string;
  symbol: string;
  weatherDescription: string;
  windSpeed: string; // km/h
  windGust: string; // km/h
  cardinalWindDirection: string;
  windDirection: number;
  humidity: string;
  rainfall: string;
  pressure: string;
  date: string; // DD-MM-YYYY
  reportTime: string; // HH:MM (local)
}

/** Met Éireann hourly synoptic observations (prodapi.metweb.ie). */
export function parseObservations(rows: MetObsRow[], stationName: string): ObservedWeather {
  const mine = rows.filter((r) => r.name?.trim().toLowerCase() === stationName.toLowerCase());
  if (!mine.length) throw new Error(`metObservations: no rows for ${stationName}`);
  // Rows are newest-first; be safe and sort by date+time.
  mine.sort((a, b) => toDate(b).getTime() - toDate(a).getTime());
  const r = mine[0];
  const n = (s: string | number | undefined) => {
    const v = Number(String(s ?? '').trim());
    return Number.isFinite(v) ? v : undefined;
  };
  const spd = n(r.windSpeed) ?? 0;
  return {
    stationName: r.name.trim(),
    time: toDate(r).toISOString(),
    wind: wind(spd * KMH_TO_KT, n(r.windDirection) ?? 0, n(r.windGust) !== undefined ? n(r.windGust)! * KMH_TO_KT : undefined),
    tempC: n(r.temperature),
    pressureHpa: n(r.pressure),
    humidityPct: n(r.humidity),
    rainfallMm: n(r.rainfall) !== undefined ? round(n(r.rainfall)!, 1) : undefined,
    description: r.weatherDescription?.trim(),
  };
}

/** Observation date/time are Irish local time; convert via Europe/Dublin offset. */
function toDate(r: MetObsRow): Date {
  const [dd, mm, yyyy] = r.date.split('-').map(Number);
  const [hh, mi] = r.reportTime.split(':').map(Number);
  const guess = new Date(Date.UTC(yyyy, mm - 1, dd, hh, mi));
  const offset = dublinOffsetMs(guess);
  return new Date(guess.getTime() - offset);
}

export function dublinOffsetMs(d: Date): number {
  const f = new Intl.DateTimeFormat('en-IE', { timeZone: 'Europe/Dublin', timeZoneName: 'shortOffset' });
  const part = f.formatToParts(d).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const m = /GMT([+-]\d+)?/.exec(part);
  return m && m[1] ? Number(m[1]) * 3600_000 : 0;
}

export function metObservationsProvider(cfg: AppConfig): Provider {
  const c = cfg.providers.metObservations;
  return {
    name: 'metObservations',
    pollIntervalMs: c.pollIntervalMs,
    enabled: c.enabled,
    kind: 'poll',
    staleAfterMs: 2 * 3600_000,
    async fetch(): Promise<Partial<DashboardData>> {
      const rows = await fetchJson<MetObsRow[]>(c.url);
      return { observed: parseObservations(rows, c.stationName) };
    },
  };
}
