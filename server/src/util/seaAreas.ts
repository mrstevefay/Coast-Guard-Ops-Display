/**
 * Met Éireann marine warnings name coastal stretches as "from A to B [to C]"
 * using a fixed set of headlands. Listed here clockwise from Malin Head.
 * A station "sits" at one headland; a warning is local if that headland lies
 * on the clockwise arc from the first named point to the last.
 */
export const HEADLANDS_CLOCKWISE = [
  'Malin Head',
  'Fair Head',
  'Belfast Lough',
  'Carlingford Lough',
  'Howth Head',
  'Wicklow Head',
  'Carnsore Point',
  'Hook Head',
  'Roches Point',
  'Mizen Head',
  'Valentia',
  'Loop Head',
  'Slyne Head',
  'Erris Head',
  'Rossan Point',
  'Bloody Foreland',
];

const norm = (s: string) => s.toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();

function headlandIndex(name: string): number {
  const n = norm(name);
  return HEADLANDS_CLOCKWISE.findIndex((h) => norm(h) === n || n.includes(norm(h)));
}

/** Extract the ordered headlands mentioned in text, in order of appearance. */
export function headlandsIn(text: string): number[] {
  const t = norm(text);
  const found: { idx: number; pos: number }[] = [];
  HEADLANDS_CLOCKWISE.forEach((h, idx) => {
    const pos = t.indexOf(norm(h));
    if (pos >= 0) found.push({ idx, pos });
  });
  return found.sort((a, b) => a.pos - b.pos).map((f) => f.idx);
}

/**
 * Does a marine warning described by `text` (headline + area descriptions)
 * cover `stationHeadland`? "all coasts", "Irish Sea" and configured keywords
 * count as yes. Otherwise the clockwise arc test above.
 */
export function marineWarningCovers(text: string, stationHeadland: string, keywords: string[] = ['all coasts', 'Irish Sea', 'all Irish coastal waters']): boolean {
  const t = norm(text);
  if (keywords.some((k) => t.includes(norm(k)))) return true;
  const station = headlandIndex(stationHeadland);
  if (station < 0) return true; // unknown station headland: don't hide anything
  const pts = headlandsIn(text);
  if (pts.length < 2) return pts.length === 1 && pts[0] === station;
  const n = HEADLANDS_CLOCKWISE.length;
  const start = pts[0];
  const end = pts[pts.length - 1];
  // Walk clockwise from start to end; local if we pass the station.
  // Also honour the stated direction via intermediate points: if the
  // intermediate points are not on the clockwise arc, it was anticlockwise.
  const onArc = (i: number) => (i - start + n) % n <= (end - start + n) % n;
  const clockwise = pts.slice(1, -1).every(onArc);
  if (clockwise) return onArc(station);
  const onAnti = (i: number) => (start - i + n) % n <= (start - end + n) % n;
  return onAnti(station);
}
