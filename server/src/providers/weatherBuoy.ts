import type { DashboardData, SeaStateReading } from '../../../shared/types.js';
import type { AppConfig } from '../config.js';
import { erddapTime, fetchErddap, num, tabledapUrl, type ErddapRow } from '../util/erddap.js';
import { round, wind } from '../util/units.js';
import type { Provider, ProviderContext } from './types.js';

/** Irish Weather Buoy Network (M2 etc.). Hourly; wind already in knots. */
export function parseBuoyRows(rows: ErddapRow[], stationId: string): SeaStateReading {
  const good = rows
    .filter((r) => String(r.station_id) === stationId && (num(r.WaveHeight) !== undefined || num(r.WindSpeed) !== undefined))
    .sort((a, b) => Date.parse(String(a.time)) - Date.parse(String(b.time)));
  if (!good.length) throw new Error(`weatherBuoy: no rows for ${stationId}`);
  const r = good[good.length - 1];
  const ws = num(r.WindSpeed), wd = num(r.WindDirection), g = num(r.Gust);
  const clean = (v: number | undefined) => (v === undefined || v <= -99 ? undefined : v);
  return {
    source: `${stationId} buoy`,
    isModel: false,
    time: new Date(Date.parse(String(r.time))).toISOString(),
    lat: num(r.latitude) ?? 0,
    lon: num(r.longitude) ?? 0,
    hsM: clean(num(r.WaveHeight)) !== undefined ? round(num(r.WaveHeight)!, 1) : undefined,
    periodS: clean(num(r.WavePeriod)) !== undefined ? round(num(r.WavePeriod)!, 0) : undefined,
    dirDeg: clean(num(r.MeanWaveDirection)) !== undefined ? Math.round(num(r.MeanWaveDirection)!) : undefined,
    seaTempC: clean(num(r.SeaTemperature)) !== undefined ? round(num(r.SeaTemperature)!, 1) : undefined,
    hmaxM: clean(num(r.Hmax)) ? round(num(r.Hmax)!, 1) : undefined,
    wind: ws !== undefined && wd !== undefined && ws > -99 ? wind(ws, wd, g !== undefined && g > -99 ? g : undefined) : undefined,
    pressureHpa: clean(num(r.AtmosphericPressure)) !== undefined ? round(num(r.AtmosphericPressure)!, 0) : undefined,
    airTempC: clean(num(r.AirTemperature)) !== undefined ? round(num(r.AirTemperature)!, 1) : undefined,
  };
}

export function weatherBuoyProvider(cfg: AppConfig): Provider {
  const c = cfg.providers.weatherBuoy;
  return {
    name: 'weatherBuoy',
    pollIntervalMs: c.pollIntervalMs,
    enabled: c.enabled,
    kind: 'poll',
    staleAfterMs: 3 * 3600_000,
    async fetch(ctx: ProviderContext): Promise<Partial<DashboardData>> {
      const since = erddapTime(new Date(Date.now() - 6 * 3600_000));
      const vars = ['time', 'station_id', 'longitude', 'latitude', 'WindDirection', 'WindSpeed', 'Gust', 'WaveHeight', 'WavePeriod', 'MeanWaveDirection', 'Hmax', 'SeaTemperature', 'AtmosphericPressure', 'AirTemperature'];
      const url = tabledapUrl(c.erddap, c.dataset, vars, [`station_id="${c.stationId}"`, `time>=${since}`]);
      const offshore = parseBuoyRows(await fetchErddap(url), c.stationId);
      return { sea: { ...ctx.current().sea, offshore } };
    },
  };
}
