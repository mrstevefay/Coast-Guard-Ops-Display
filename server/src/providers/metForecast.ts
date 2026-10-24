import type { DashboardData, HourForecast, VisibilityEstimate, WeatherState } from '../../../shared/types.js';
import type { AppConfig } from '../config.js';
import { fetchText } from '../util/http.js';
import { MPS_TO_KT, round, wind } from '../util/units.js';
import { asArray, parseXml } from '../util/xml.js';
import type { Provider, ProviderContext } from './types.js';

/**
 * Met Éireann location forecast (metno-wdb2ts XML, Harmonie model).
 * Instantaneous elements (temp, wind...) come in <time from==to>; precipitation
 * and symbol come in 1-hour spans ending at that instant.
 */
export function parseForecastXml(xml: string, now: Date, hoursAhead: number): WeatherState {
  const doc = parseXml(xml);
  const times = asArray(doc?.weatherdata?.product?.time);
  if (!times.length) throw new Error('metForecast: no <time> elements');

  const inst = new Map<string, any>();
  const spans = new Map<string, any>(); // keyed by "to" (end of hour)
  for (const t of times) {
    const loc = t.location;
    if (!loc) continue;
    if (t['@_from'] === t['@_to']) inst.set(t['@_to'], loc);
    else if (Date.parse(t['@_to']) - Date.parse(t['@_from']) === 3600_000) spans.set(t['@_to'], loc);
  }

  const hours: HourForecast[] = [];
  for (const [iso, loc] of [...inst.entries()].sort((a, b) => Date.parse(a[0]) - Date.parse(b[0]))) {
    const ws = loc.windSpeed, wd = loc.windDirection, wg = loc.windGust, tt = loc.temperature;
    if (!ws || !wd || !tt) continue;
    // Precip for the hour *starting* at `iso` lives in the span ending one hour later.
    const span = spans.get(new Date(Date.parse(iso) + 3600_000).toISOString().replace('.000Z', 'Z')) ?? spans.get(iso);
    const humidity = loc.humidity ? Number(loc.humidity['@_value']) : undefined;
    const symbol = span?.symbol?.['@_id'] ?? 'Unknown';
    hours.push({
      time: iso,
      wind: wind(Number(ws['@_mps']) * MPS_TO_KT, Number(wd['@_deg']), wg ? Number(wg['@_mps']) * MPS_TO_KT : undefined),
      tempC: round(Number(tt['@_value']), 0),
      precipMm: span?.precipitation ? round(Number(span.precipitation['@_value']), 1) : 0,
      precipProbPct: span?.precipitation?.['@_probability'] !== undefined ? Math.round(Number(span.precipitation['@_probability'])) : undefined,
      symbol,
      pressureHpa: loc.pressure ? round(Number(loc.pressure['@_value']), 0) : undefined,
      humidityPct: humidity !== undefined ? Math.round(humidity) : undefined,
      visibility: estimateVisibility(symbol, humidity, loc.dewpointTemperature ? Number(tt['@_value']) - Number(loc.dewpointTemperature['@_value']) : undefined),
    });
  }
  if (!hours.length) throw new Error('metForecast: no usable hours');

  // "now" = the hour containing now (or the first hour if forecast starts later)
  const nowMs = now.getTime();
  let idx = hours.findIndex((h) => Date.parse(h.time) + 3600_000 > nowMs);
  if (idx < 0) idx = hours.length - 1;
  const nowH = hours[idx];
  const hourly = hours.slice(idx + 1, idx + 1 + hoursAhead);
  const model = asArray(doc?.weatherdata?.meta?.model)[0];
  return { now: nowH, hourly, modelRun: model?.['@_termin'] };
}

/**
 * metno-wdb2ts carries no visibility element, so we estimate a band from the
 * weather symbol and humidity / dew-point spread. Always marked `estimated`.
 */
export function estimateVisibility(symbol: string, humidityPct?: number, dewSpreadC?: number): VisibilityEstimate {
  const s = symbol.toLowerCase();
  let band: VisibilityEstimate['band'] = 'good';
  if (s.includes('fog')) band = 'fog';
  else if (s.includes('heavy') && (s.includes('rain') || s.includes('sleet') || s.includes('snow'))) band = 'poor';
  else if (s.includes('snow') || s.includes('sleet')) band = 'poor';
  else if (s.includes('rain') || s.includes('drizzle') || s.includes('showers')) band = 'moderate';
  if (band === 'good' && humidityPct !== undefined && humidityPct >= 97 && (dewSpreadC === undefined || dewSpreadC <= 1)) band = 'poor';
  else if (band === 'moderate' && humidityPct !== undefined && humidityPct >= 96) band = 'poor';
  const label = { good: '>5 NM', moderate: '2–5 NM', poor: '1–2 NM', 'very-poor': '0.5–1 NM', fog: '<0.5 NM' }[band];
  return { band, label, estimated: true };
}

export function metForecastProvider(cfg: AppConfig): Provider {
  const c = cfg.providers.metForecast;
  const urls = [c.url, c.fallbackUrl].filter(Boolean) as string[];
  return {
    name: 'metForecast',
    pollIntervalMs: c.pollIntervalMs,
    enabled: c.enabled,
    kind: 'poll',
    staleAfterMs: 3 * 3600_000,
    async fetch(ctx: ProviderContext): Promise<Partial<DashboardData>> {
      let lastErr: unknown;
      for (const base of urls) {
        try {
          const url = `${base}?lat=${cfg.station.lat};long=${cfg.station.lon}`;
          const xml = await fetchText(url, { timeoutMs: 25000 });
          return { weather: parseForecastXml(xml, new Date(), c.hoursAhead) };
        } catch (e) {
          lastErr = e;
          ctx.log.debug({ base, err: String(e) }, 'metForecast url failed, trying next');
        }
      }
      throw lastErr ?? new Error('metForecast: no URL configured');
    },
  };
}
