import type { DashboardData, TideState } from '../../../shared/types.js';
import type { AppConfig } from '../config.js';
import { erddapTime, fetchErddap, num, tabledapUrl, type ErddapRow } from '../util/erddap.js';
import { round } from '../util/units.js';
import type { Provider, ProviderContext } from './types.js';

export interface GaugeReading {
  time: string;
  levelLatM: number;
  levelOdMalinM?: number;
  rising?: boolean;
}

/** Irish National Tide Gauge Network (5-min data). Picks the latest QC-ok row. */
export function parseGaugeRows(rows: ErddapRow[]): GaugeReading {
  const good = rows
    .map((r) => ({ time: String(r.time), lat: num(r.Water_Level_LAT), odm: num(r.Water_Level_OD_Malin), qc: num(r.QC_Flag) ?? 0 }))
    .filter((r) => r.lat !== undefined && r.qc !== 4 && r.qc !== 9)
    .sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  if (!good.length) throw new Error('tideGauge: no valid water level rows');
  const last = good[good.length - 1];
  const earlier = good.find((r) => Date.parse(last.time) - Date.parse(r.time) >= 25 * 60_000 && Date.parse(last.time) - Date.parse(r.time) <= 40 * 60_000);
  return {
    time: last.time,
    levelLatM: round(last.lat!, 2),
    levelOdMalinM: last.odm !== undefined ? round(last.odm, 2) : undefined,
    rising: earlier ? last.lat! > earlier.lat! : undefined,
  };
}

export function tideGaugeProvider(cfg: AppConfig): Provider {
  const c = cfg.providers.tideGauge;
  return {
    name: 'tideGauge',
    pollIntervalMs: c.pollIntervalMs,
    enabled: c.enabled,
    kind: 'poll',
    staleAfterMs: 40 * 60_000,
    async fetch(ctx: ProviderContext): Promise<Partial<DashboardData>> {
      const since = erddapTime(new Date(Date.now() - 2 * 3600_000));
      const url = tabledapUrl(c.erddap, c.dataset, ['time', 'station_id', 'Water_Level_LAT', 'Water_Level_OD_Malin', 'QC_Flag'], [
        `station_id="${c.stationId}"`,
        `time>=${since}`,
      ]);
      const reading = parseGaugeRows(await fetchErddap(url));
      const prev = ctx.current().tide;
      const tide: TideState = {
        stationId: prev?.stationId ?? c.stationId,
        events: prev?.events ?? [],
        curve: prev?.curve ?? [],
        ...prev,
        observedM: reading.levelLatM,
        observedAt: reading.time,
        rising: prev?.rising ?? reading.rising,
      };
      return { tide };
    },
  };
}
