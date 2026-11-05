import type { DashboardData, SeaStateReading } from '../../../shared/types.js';
import type { AppConfig } from '../config.js';
import { fetchText } from '../util/http.js';
import { round, wind } from '../util/units.js';
import type { Provider, ProviderContext } from './types.js';

/**
 * Dublin Bay Buoy (dublinbaybuoy.com) — Irish Lights MetOcean telemetry from the
 * Dublin Bay safe water mark (53.332 N, 6.077 W), hourly, served via PostgREST.
 * Data from Dublin Bay Buoy, sourced from Irish Lights MetOcean. Not for navigation.
 */
export interface DublinBayReading {
  id: number;
  timestamp: string;
  water_temp: number | null;
  wave_height: number | null;
  wave_period: number | null;
  wind_dir: number | null;
  gust_dir: number | null;
  avg_wind: number | null; // knots
  gust_speed: number | null; // knots
  is_gale: boolean | null;
  source?: string;
}

export const DUBLIN_BAY_BUOY_POS = { lat: 53.332, lon: -6.077 };

export function parseDublinBayReadings(rows: DublinBayReading[], label = 'Dublin Bay buoy'): SeaStateReading {
  const usable = rows
    .filter((r) => r && r.timestamp && (r.wave_height !== null || r.avg_wind !== null))
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  if (!usable.length) throw new Error('dublinBayBuoy: no usable readings');
  const r = usable[0];
  const n = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? undefined : v);
  return {
    source: label,
    isModel: false,
    time: new Date(Date.parse(r.timestamp)).toISOString(),
    lat: DUBLIN_BAY_BUOY_POS.lat,
    lon: DUBLIN_BAY_BUOY_POS.lon,
    hsM: n(r.wave_height) !== undefined ? round(r.wave_height!, 1) : undefined,
    periodS: n(r.wave_period) !== undefined ? round(r.wave_period!, 0) : undefined,
    seaTempC: n(r.water_temp) !== undefined ? round(r.water_temp!, 1) : undefined,
    wind: n(r.avg_wind) !== undefined && n(r.wind_dir) !== undefined ? wind(r.avg_wind!, r.wind_dir!, n(r.gust_speed)) : undefined,
    gale: r.is_gale === true ? true : undefined,
  };
}

export function dublinBayBuoyProvider(cfg: AppConfig): Provider {
  const c = cfg.providers.dublinBayBuoy;
  const hasKey = Boolean(c.apiKey);
  return {
    name: 'dublinBayBuoy',
    pollIntervalMs: c.pollIntervalMs,
    enabled: c.enabled && hasKey,
    kind: 'poll',
    note: hasKey ? undefined : 'DUBLINBAY_API_KEY not set',
    staleAfterMs: 3 * 3600_000,
    async fetch(ctx: ProviderContext): Promise<Partial<DashboardData>> {
      const url = `${c.url.replace(/\/$/, '')}/readings?select=*&order=timestamp.desc&limit=6`;
      const text = await fetchText(url, { timeoutMs: 20000, headers: { apikey: c.apiKey } });
      const rows = JSON.parse(text) as DublinBayReading[];
      const local = parseDublinBayReadings(rows, c.label);
      return { sea: { ...ctx.current().sea, local } };
    },
  };
}
