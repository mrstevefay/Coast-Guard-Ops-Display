import type { DashboardData, SeaStateReading } from '../../../shared/types.js';
import type { AppConfig } from '../config.js';
import { erddapTime, fetchErddap, griddapUrl, num, type ErddapRow } from '../util/erddap.js';
import { round } from '../util/units.js';
import type { Provider, ProviderContext } from './types.js';

/**
 * Marine Institute Irish Shelf SWAN wave model, sampled at one grid point off
 * Howth. A *model*, not an observation: there is no public Dublin Bay wave
 * buoy feed on ERDDAP (see README). Picks the row closest to now.
 */
export function parseWaveModel(rows: ErddapRow[], now: Date, label: string): SeaStateReading {
  const pts = rows
    .map((r) => ({ t: Date.parse(String(r.time)), r }))
    .filter((p) => !Number.isNaN(p.t) && num(p.r.significant_wave_height) !== undefined)
    .sort((a, b) => Math.abs(a.t - now.getTime()) - Math.abs(b.t - now.getTime()));
  if (!pts.length) throw new Error('waveModel: no rows');
  const { r } = pts[0];
  return {
    source: label,
    isModel: true,
    time: new Date(pts[0].t).toISOString(),
    lat: num(r.latitude) ?? 0,
    lon: num(r.longitude) ?? 0,
    hsM: round(num(r.significant_wave_height)!, 1),
    periodS: num(r.peak_wave_period) !== undefined ? round(num(r.peak_wave_period)!, 0) : undefined,
    dirDeg: num(r.mean_wave_direction_from) !== undefined ? Math.round(num(r.mean_wave_direction_from)!) : undefined,
  };
}

export function waveModelProvider(cfg: AppConfig): Provider {
  const c = cfg.providers.waveModel;
  return {
    name: 'waveModel',
    pollIntervalMs: c.pollIntervalMs,
    enabled: c.enabled,
    kind: 'poll',
    staleAfterMs: 4 * 3600_000,
    async fetch(ctx: ProviderContext): Promise<Partial<DashboardData>> {
      const now = new Date();
      const t0 = erddapTime(new Date(Math.floor(now.getTime() / 3600_000) * 3600_000 - 3600_000));
      const t1 = erddapTime(new Date(Math.floor(now.getTime() / 3600_000) * 3600_000 + 3 * 3600_000));
      const sel = `[(${t0}):1:(${t1})][(${c.lat})][(${c.lon})]`;
      const url = griddapUrl(c.erddap, c.dataset, `significant_wave_height${sel},peak_wave_period${sel},mean_wave_direction_from${sel}`);
      const model = parseWaveModel(await fetchErddap(url), now, c.label);
      return { sea: { ...ctx.current().sea, model } };
    },
  };
}
