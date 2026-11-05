import type { DashboardData, SeaAreaForecast, SeaAreaSection, VisibilityBand } from '../../../shared/types.js';
import type { AppConfig } from '../config.js';
import { fetchText } from '../util/http.js';
import { marineWarningCovers } from '../util/seaAreas.js';
import { stripHtml } from '../util/xml.js';
import { dublinOffsetMs } from './metObservations.js';
import type { Provider } from './types.js';

/**
 * Met Éireann Sea Area Forecast — scraped from the met.ie page (no API exists
 * since the Open_Data XML was withdrawn). The page is server-rendered with
 * stable class names: sea-area-small-craft-warnings, sea-area-small-gale-warnings,
 * sea-area-short-coastal (one per coastal stretch), sea-area-outlook.
 */
const SEA_KEYWORDS = ['all Irish coastal waters', 'all coasts', 'Irish Sea'];

function blocks(html: string, cls: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<div class="[^"]*\\b${cls}\\b[^"]*"[^>]*>`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    // walk to the matching close tag
    let depth = 1, i = re.lastIndex;
    const tag = /<\/?div\b[^>]*>/g;
    tag.lastIndex = i;
    let t: RegExpExecArray | null;
    while ((t = tag.exec(html))) {
      depth += t[0].startsWith('</') ? -1 : 1;
      if (depth === 0) {
        out.push(html.slice(i, t.index));
        break;
      }
    }
  }
  return out;
}

const text = (s: string | undefined) => stripHtml(s ?? '').replace(/\s+/g, ' ').trim();
const h2 = (b: string) => text(/<h2>([\s\S]*?)<\/h2>/.exec(b)?.[1]);
const paras = (b: string) => [...b.matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m) => text(m[1])).filter(Boolean);
function labelled(b: string, label: string): string | undefined {
  const m = new RegExp(`<p><strong>\\s*${label}\\s*:?\\s*</strong>\\s*:?\\s*([\\s\\S]*?)</p>`, 'i').exec(b);
  return m ? text(m[1]) : undefined;
}

/** "11:30, Thursday 05 November 2026" (Irish local) → ISO UTC */
export function parseIrishDateTime(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const m = /(\d{1,2}):(\d{2}),?\s*(?:\w+\s+)?(\d{1,2})\s+(\w+)\s+(\d{4})/.exec(s);
  if (!m) return undefined;
  const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  const mon = months.indexOf(m[4].toLowerCase());
  if (mon < 0) return undefined;
  const guess = new Date(Date.UTC(Number(m[5]), mon, Number(m[3]), Number(m[1]), Number(m[2])));
  return new Date(guess.getTime() - dublinOffsetMs(guess)).toISOString();
}

/** "Northeast to east force 4 to 6. Soon decreasing ..." → { min:4, max:6 } from the first force phrase. */
export function parseForce(wind: string): { min: number; max: number } | undefined {
  // "force 4 to 6", "force 7 to gale force 8", "force 2 or 3"
  const m = /force\s+(\d{1,2})(?:\s*(?:to|or)\s*(?:(?:strong|severe|violent)?\s*(?:gale|storm|hurricane)\s*)?(?:force\s*)?(\d{1,2}))?/i.exec(wind);
  if (!m) return undefined;
  const a = Number(m[1]), b = m[2] ? Number(m[2]) : Number(m[1]);
  return { min: Math.min(a, b), max: Math.max(a, b) };
}

const DIR_WORDS: Record<string, string> = {
  north: 'N', northeast: 'NE', east: 'E', southeast: 'SE', south: 'S', southwest: 'SW', west: 'W', northwest: 'NW',
  northerly: 'N', northeasterly: 'NE', easterly: 'E', southeasterly: 'SE', southerly: 'S', southwesterly: 'SW', westerly: 'W', northwesterly: 'NW',
  variable: 'VAR', cyclonic: 'CYC',
};

/** Leading direction words before the first "force": "Northeast to east force 4" → "NE–E" */
export function parseDirection(wind: string): string | undefined {
  const head = wind.split(/force/i)[0].toLowerCase();
  const words = head.match(/[a-z]+/g) ?? [];
  const dirs = words.map((w) => DIR_WORDS[w]).filter(Boolean);
  if (!dirs.length) return undefined;
  return [...new Set(dirs)].slice(0, 2).join('–');
}

/**
 * Worst visibility band stated. "fog" only counts as the band itself when it is
 * the condition ("Fog", "poor in fog patches" is still poor), not when it is
 * merely the cause of "moderate or poor".
 */
export function visibilityBand(vis: string): VisibilityBand {
  const v = vis.toLowerCase().trim();
  const hasGrade = /\b(good|moderate|poor)\b/.test(v);
  if (/^fog\b/.test(v) || (/\bfog\b/.test(v) && !hasGrade && !/isolated|patches|possible|at times/.test(v))) return 'fog';
  if (/very poor/.test(v)) return 'very-poor';
  if (/\bpoor\b/.test(v)) return 'poor';
  if (/moderate/.test(v)) return 'moderate';
  return 'good';
}

export function parseSeaAreaPage(html: string, stationHeadland: string): SeaAreaForecast {
  const validP = /Forecast valid from:\s*([^<]+)/i.exec(html)?.[1] ?? '';
  const [validFromTxt, validToTxt] = validP.split(/\s+until\s+/i);
  const issuedTxt = /Forecast issued at:\s*([^<]+)/i.exec(html)?.[1];
  const sc = blocks(html, 'sea-area-small-craft-warnings')[0];
  const gale = blocks(html, 'sea-area-small-gale-warnings')[0];
  const nilish = (s?: string) => (!s || /^(nil|none|no warning)/i.test(s) ? undefined : s);
  const smallCraft = nilish(sc ? paras(sc)[0] : undefined);
  const galeWarning = nilish(gale ? paras(gale)[0] : undefined);
  const situation = (() => {
    const m = /<h2>Meteorological Situation[^<]*<\/h2>\s*<p>([\s\S]*?)<\/p>/i.exec(html);
    return m ? text(m[1]) : undefined;
  })();
  const sections: SeaAreaSection[] = blocks(html, 'sea-area-short-coastal').map((b) => {
    const title = h2(b);
    const wind = labelled(b, 'Wind') ?? '';
    const weather = labelled(b, 'Weather') ?? '';
    const visibility = labelled(b, 'Visibility') ?? '';
    const seaState = labelled(b, 'Sea State') ?? labelled(b, 'State of sea');
    const force = parseForce(wind);
    return { title, wind, weather, visibility, seaState, forceMin: force?.min, forceMax: force?.max, direction: parseDirection(wind), visibilityBand: visibilityBand(visibility) };
  });
  if (!sections.length) throw new Error('metSeaArea: no forecast sections found (page layout changed?)');
  const local = sections.find((s) => marineWarningCovers(s.title, stationHeadland, SEA_KEYWORDS)) ?? sections[0];
  const outlookBlock = blocks(html, 'sea-area-outlook')[0];
  const outlook = outlookBlock ? paras(outlookBlock).find((p) => !/^Forecast issued/i.test(p)) : undefined;
  return {
    issuedAt: parseIrishDateTime(issuedTxt) ?? new Date().toISOString(),
    validFrom: parseIrishDateTime(validFromTxt),
    validTo: parseIrishDateTime(validToTxt),
    smallCraft,
    galeWarning,
    situation,
    area: local,
    sections,
    outlook,
  };
}

export function metSeaAreaProvider(cfg: AppConfig): Provider {
  const c = cfg.providers.metSeaArea;
  return {
    name: 'metSeaArea',
    pollIntervalMs: c.pollIntervalMs,
    enabled: c.enabled,
    kind: 'poll',
    staleAfterMs: 8 * 3600_000,
    async fetch(): Promise<Partial<DashboardData>> {
      const html = await fetchText(c.url, { timeoutMs: 25000, headers: { accept: 'text/html' } });
      return { seaArea: parseSeaAreaPage(html, c.headland) };
    },
  };
}
