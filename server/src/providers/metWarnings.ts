import type { DashboardData, WarningLevel, WarningsState, WeatherWarning } from '../../../shared/types.js';
import type { AppConfig } from '../config.js';
import { fetchText } from '../util/http.js';
import { marineWarningCovers } from '../util/seaAreas.js';
import { asArray, parseXml, stripHtml } from '../util/xml.js';
import type { Provider, ProviderContext } from './types.js';

/**
 * Met Éireann warnings: RSS index at met.ie/warningsxml/rss.xml, each item
 * linking to a CAP 1.2 XML on cap.met.ie. The RSS includes marine warnings
 * (Gale, Small Craft) that the JSON county feed omits, so we use it.
 */
export function parseWarningsRss(xml: string): string[] {
  const doc = parseXml(xml);
  const items = asArray(doc?.rss?.channel?.item);
  return items.map((i: any) => String(i.link ?? i.guid ?? '').trim()).filter((u) => u.startsWith('http'));
}

export interface WarningLocality {
  localRegionCodes: string[];
  localMarineCodes: string[];
  /** Headland the station sits at, e.g. "Howth Head" (see util/seaAreas.ts). */
  marineHeadland?: string;
}

export function parseCap(xml: string, loc: WarningLocality): WeatherWarning | undefined {
  const doc = parseXml(xml);
  const alert = doc?.alert;
  if (!alert) return undefined;
  if (alert.status && alert.status !== 'Actual') return undefined;
  if (alert.msgType === 'Cancel') return undefined;
  const info = asArray(alert.info).find((i: any) => !i.language || String(i.language).startsWith('en')) ?? asArray(alert.info)[0];
  if (!info) return undefined;
  const areas = asArray(info.area);
  const areaDesc = areas.map((a: any) => String(a.areaDesc ?? '')).filter(Boolean);
  const codes = areas.flatMap((a: any) => asArray(a.geocode).map((g: any) => String(g.value ?? ''))).filter(Boolean);
  const event = String(info.event ?? '');
  const headline = String(info.headline ?? event);
  const marine = codes.some((c) => /^EI8\d\d$/.test(c)) || /marine|small craft|gale|coast/i.test(headline);
  const level = levelFrom(event, info.severity);
  const type = event.replace(/^(Yellow|Orange|Red)\s+/i, '').trim() || 'Warning';
  const local = marine
    ? loc.localMarineCodes.length > 0
      ? codes.some((c) => loc.localMarineCodes.includes(c))
      : loc.marineHeadland
        ? marineWarningCovers(`${headline} ${areaDesc.join(' ')}`, loc.marineHeadland)
        : true
    : codes.some((c) => loc.localRegionCodes.includes(c));
  return {
    id: String(alert.identifier ?? headline),
    level,
    type,
    headline,
    description: stripHtml(String(info.description ?? '')),
    marine,
    onset: toIso(info.onset ?? info.effective ?? alert.sent),
    expires: toIso(info.expires),
    issued: toIso(alert.sent),
    areas: areaDesc,
    regionCodes: codes,
    local,
  };
}

function toIso(v: unknown): string {
  const t = Date.parse(String(v ?? ''));
  return Number.isNaN(t) ? '' : new Date(t).toISOString();
}

function levelFrom(event: string, severity?: string): WarningLevel {
  const e = event.toLowerCase();
  // Small Craft warnings carry CAP severity "Moderate" but are not colour-coded.
  if (e.includes('small craft')) return 'advisory';
  if (e.startsWith('red')) return 'red';
  if (e.startsWith('orange')) return 'orange';
  if (e.startsWith('yellow')) return 'yellow';
  switch ((severity ?? '').toLowerCase()) {
    case 'extreme':
      return 'red';
    case 'severe':
      return 'orange';
    case 'moderate':
      return 'yellow';
    default:
      return 'advisory'; // e.g. Small Craft warning
  }
}

/** Keep warnings that are in force now or start within the next 24 h; drop expired. */
export function filterActive(ws: WeatherWarning[], now: Date): WeatherWarning[] {
  const n = now.getTime();
  const horizon = n + 24 * 3600_000;
  const order: Record<WarningLevel, number> = { red: 0, orange: 1, yellow: 2, advisory: 3 };
  return ws
    .filter((w) => (!w.expires || Date.parse(w.expires) > n) && (!w.onset || Date.parse(w.onset) < horizon))
    .sort((a, b) => order[a.level] - order[b.level] || Number(b.marine) - Number(a.marine) || Number(b.local) - Number(a.local));
}

export function metWarningsProvider(cfg: AppConfig): Provider {
  const c = cfg.providers.metWarnings;
  const capCache = new Map<string, WeatherWarning | null>();
  return {
    name: 'metWarnings',
    pollIntervalMs: c.pollIntervalMs,
    enabled: c.enabled,
    kind: 'poll',
    staleAfterMs: 3600_000,
    async fetch(ctx: ProviderContext): Promise<Partial<DashboardData>> {
      const rss = await fetchText(c.rssUrl);
      const links = parseWarningsRss(rss);
      const warnings: WeatherWarning[] = [];
      for (const link of links) {
        let w = capCache.get(link);
        if (w === undefined) {
          try {
            w = parseCap(await fetchText(link), { localRegionCodes: c.localRegionCodes, localMarineCodes: c.localMarineCodes, marineHeadland: c.marineHeadland }) ?? null;
          } catch (e) {
            ctx.log.warn({ link, err: String(e) }, 'CAP fetch failed');
            continue; // transient: don't cache, try next poll
          }
          capCache.set(link, w);
        }
        if (w) warnings.push(w);
      }
      // Forget CAP files no longer in the feed.
      for (const k of [...capCache.keys()]) if (!links.includes(k)) capCache.delete(k);
      const state: WarningsState = { active: filterActive(warnings, new Date()), fetchedAt: new Date().toISOString() };
      return { warnings: state };
    },
  };
}
