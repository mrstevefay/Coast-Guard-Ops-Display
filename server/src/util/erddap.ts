import { fetchJson } from './http.js';

/** ERDDAP .json response shape (tabledap and griddap both use it). */
export interface ErddapTable {
  table: {
    columnNames: string[];
    columnTypes: string[];
    columnUnits: (string | null)[];
    rows: (string | number | null)[][];
  };
}

export type ErddapRow = Record<string, string | number | null>;

/** Turn the column/rows table into an array of objects keyed by column name. */
export function rowsToObjects(t: ErddapTable): ErddapRow[] {
  const names = t.table.columnNames;
  return t.table.rows.map((r) => {
    const o: ErddapRow = {};
    names.forEach((n, i) => (o[n] = r[i]));
    return o;
  });
}

/** ISO without milliseconds — ERDDAP rejects fractional seconds in constraints. */
export function erddapTime(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Build a tabledap query URL. Constraints are passed pre-encoded-safe: we encode
 * `>` `<` `"` and spaces (ERDDAP's Tomcat refuses raw `>`/`<` in the path).
 */
export function tabledapUrl(base: string, dataset: string, vars: string[], constraints: string[]): string {
  const q = [vars.join(','), ...constraints].join('&');
  return `${base.replace(/\/$/, '')}/tabledap/${dataset}.json?${encodeQuery(q)}`;
}

export function griddapUrl(base: string, dataset: string, query: string): string {
  return `${base.replace(/\/$/, '')}/griddap/${dataset}.json?${encodeQuery(query)}`;
}

export function encodeQuery(q: string): string {
  return q
    .replace(/ /g, '%20')
    .replace(/"/g, '%22')
    .replace(/>/g, '%3E')
    .replace(/</g, '%3C')
    .replace(/\+/g, '%2B')
    .replace(/\[/g, '%5B')
    .replace(/\]/g, '%5D');
}

export async function fetchErddap(url: string): Promise<ErddapRow[]> {
  const t = await fetchJson<ErddapTable>(url, { timeoutMs: 30000 });
  if (!t?.table?.rows) throw new Error(`ERDDAP: unexpected response from ${url}`);
  return rowsToObjects(t);
}

export function num(v: string | number | null | undefined): number | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}
