import type { DashboardData, SpringNeap, TideCurvePoint, TideEvent, TideState } from '../../../shared/types.js';
import type { AppConfig } from '../config.js';
import { erddapTime, fetchErddap, num, tabledapUrl, type ErddapRow } from '../util/erddap.js';
import { round } from '../util/units.js';
import type { Provider, ProviderContext } from './types.js';

/**
 * Marine Institute tide predictions:
 *  - IMI_TidePrediction_HighLow: HW/LW times, heights relative to OD Malin
 *  - imiTidePrediction: 5-min curve with both LAT and OD Malin heights
 * We display Chart Datum (LAT) like the tide tables, so we learn the
 * OD Malin→LAT offset from the curve and apply it to the HW/LW list.
 */
export interface PredictionInputs {
  highLow: ErddapRow[];
  curve: ErddapRow[];
  now: Date;
  stationId: string;
  springRangeM: number;
  neapRangeM: number;
}

export function buildTidePrediction(i: PredictionInputs): Omit<TideState, 'observedM' | 'observedAt' | 'surgeM'> {
  const curveRows = i.curve
    .map((r) => ({ time: String(r.time), lat: num(r.Water_Level), odm: num(r.Water_Level_ODM) }))
    .filter((r) => r.lat !== undefined)
    .sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  if (!curveRows.length) throw new Error('tidePrediction: empty curve');
  const withBoth = curveRows.find((r) => r.odm !== undefined);
  const offset = withBoth ? round(withBoth.lat! - withBoth.odm!, 3) : 0;

  // 15-min curve ±6 h for the mini chart
  const nowMs = i.now.getTime();
  const curve: TideCurvePoint[] = curveRows
    .filter((r) => {
      const t = Date.parse(r.time);
      return t >= nowMs - 6.25 * 3600_000 && t <= nowMs + 6.25 * 3600_000 && new Date(t).getUTCMinutes() % 15 === 0;
    })
    .map((r) => ({ time: r.time, heightM: round(r.lat!, 2) }));

  const events: TideEvent[] = i.highLow
    .map((r) => ({
      kind: (String(r.tide_time_category).toUpperCase().startsWith('H') ? 'HW' : 'LW') as TideEvent['kind'],
      time: String(r.time),
      heightM: round((num(r.Water_Level_ODMalin) ?? 0) + offset, 2),
    }))
    .sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  if (!events.length) throw new Error('tidePrediction: no HW/LW events');

  const nextIdx = events.findIndex((e) => Date.parse(e.time) > nowMs);
  const next = nextIdx >= 0 ? events[nextIdx] : undefined;
  const following = nextIdx >= 0 ? events[nextIdx + 1] : undefined;
  const previous = nextIdx > 0 ? events[nextIdx - 1] : undefined;
  const rising = next ? next.kind === 'HW' : undefined;
  const rangeM = next && previous ? round(Math.abs(next.heightM - previous.heightM), 2) : undefined;
  // Spring/neap: use the max range over the surrounding events (a tidal day) so
  // the diurnal inequality between successive tides doesn't flip the indicator.
  const ranges: number[] = [];
  for (let k = Math.max(1, nextIdx - 2); k < Math.min(events.length, nextIdx + 3); k++) ranges.push(Math.abs(events[k].heightM - events[k - 1].heightM));
  const maxRange = ranges.length ? Math.max(...ranges) : rangeM;
  let springNeap: SpringNeap | undefined;
  if (maxRange !== undefined) springNeap = maxRange >= i.springRangeM ? 'springs' : maxRange <= i.neapRangeM ? 'neaps' : 'mid';

  return { stationId: i.stationId, rising, next, following, previous, events, curve, rangeM, springNeap, odMalinToLatM: offset };
}

export function tidePredictionProvider(cfg: AppConfig): Provider {
  const c = cfg.providers.tidePrediction;
  return {
    name: 'tidePrediction',
    pollIntervalMs: c.pollIntervalMs,
    enabled: c.enabled,
    kind: 'poll',
    staleAfterMs: 6 * 3600_000,
    async fetch(ctx: ProviderContext): Promise<Partial<DashboardData>> {
      const now = new Date();
      const hlUrl = tabledapUrl(c.erddap, c.highLowDataset, ['time', 'stationID', 'tide_time_category', 'Water_Level_ODMalin'], [
        `stationID="${c.stationId}"`,
        `time>=${erddapTime(new Date(now.getTime() - 24 * 3600_000))}`,
        `time<=${erddapTime(new Date(now.getTime() + 48 * 3600_000))}`,
      ]);
      const curveUrl = tabledapUrl(c.erddap, c.curveDataset, ['time', 'stationID', 'Water_Level', 'Water_Level_ODM'], [
        `stationID="${c.stationId}"`,
        `time>=${erddapTime(new Date(now.getTime() - 7 * 3600_000))}`,
        `time<=${erddapTime(new Date(now.getTime() + 7 * 3600_000))}`,
      ]);
      const [highLow, curve] = await Promise.all([fetchErddap(hlUrl), fetchErddap(curveUrl)]);
      const pred = buildTidePrediction({ highLow, curve, now, stationId: c.stationId, springRangeM: c.springRangeM, neapRangeM: c.neapRangeM });
      const prev = ctx.current().tide;
      const tide: TideState = { ...pred, observedM: prev?.observedM, observedAt: prev?.observedAt };
      return { tide };
    },
  };
}
