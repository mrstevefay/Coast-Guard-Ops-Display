/**
 * Place-name index for "search a place" in the console: named places, peaks, beaches, piers,
 * car parks, pubs, roads and paths from the OpenStreetMap data the terrain build already reads.
 * Written next to the terrain grid as places.json, so a search never needs the internet.
 */
import fs from 'node:fs';
import path from 'node:path';

/** [name, kind, lat, lon]: compact on disk and over the wire. */
export type Place = [string, string, number, number];

const AMENITY = new Set(['parking', 'pub', 'bar', 'cafe', 'restaurant', 'school', 'place_of_worship', 'hospital', 'clinic', 'fuel', 'community_centre', 'library', 'police', 'fire_station', 'shelter', 'toilets']);
const NATURAL = new Set(['peak', 'hill', 'beach', 'bay', 'cape', 'cliff', 'rock', 'island', 'islet', 'spring', 'wood', 'heath', 'water']);
const MAN_MADE = new Set(['lighthouse', 'pier', 'breakwater', 'tower', 'water_tower', 'mast']);
const LEISURE = new Set(['park', 'golf_course', 'nature_reserve', 'garden', 'marina', 'slipway', 'playground', 'pitch', 'sports_centre', 'common']);
const HIGHWAY = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'service', 'pedestrian', 'track', 'path', 'footway', 'bridleway', 'cycleway', 'steps']);

/** What kind of place a tagged OSM element is, in words a search manager reads; undefined to skip it. */
export function placeKind(tags: Record<string, string>): string | undefined {
  if (!tags.name) return undefined;
  if (tags.place) return tags.place === 'isolated_dwelling' ? 'house' : tags.place;
  if (tags.natural && NATURAL.has(tags.natural)) return tags.natural;
  if (tags.man_made && MAN_MADE.has(tags.man_made)) return tags.man_made.replace('_', ' ');
  if (tags.leisure === 'slipway' || tags.leisure === 'marina' || (tags.leisure && LEISURE.has(tags.leisure))) return tags.leisure.replace('_', ' ');
  if (tags.amenity && AMENITY.has(tags.amenity)) return tags.amenity === 'place_of_worship' ? 'church' : tags.amenity === 'parking' ? 'car park' : tags.amenity.replace('_', ' ');
  if (tags.tourism) return tags.tourism.replace('_', ' ');
  if (tags.historic) return tags.historic.replace('_', ' ');
  if (tags.railway === 'station' || tags.railway === 'halt' || tags.public_transport === 'station') return 'station';
  if (tags.highway && HIGHWAY.has(tags.highway)) return ['track', 'path', 'footway', 'bridleway', 'cycleway', 'steps'].includes(tags.highway) ? 'path' : 'road';
  return undefined;
}

/** Collects places during a build, one entry per name and kind within about 400 m. */
export class PlaceCollector {
  private seen = new Set<string>();
  readonly places: Place[] = [];
  add(tags: Record<string, string>, lat: number, lon: number): void {
    const kind = placeKind(tags);
    if (!kind || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
    const name = tags.name.trim().slice(0, 80);
    const key = `${name.toLowerCase()}|${kind}|${Math.round(lat * 270)}|${Math.round(lon * 160)}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.places.push([name, kind, Math.round(lat * 1e5) / 1e5, Math.round(lon * 1e5) / 1e5]);
  }
  /** A way or ring: the vertex nearest its middle, so a long road is named where it runs. */
  addLine(tags: Record<string, string>, pts: { lat: number; lon: number }[]): void {
    if (!pts.length || !tags.name) return;
    const closed = pts.length > 3 && pts[0].lat === pts[pts.length - 1].lat && pts[0].lon === pts[pts.length - 1].lon;
    if (closed) this.add(tags, pts.reduce((s, p) => s + p.lat, 0) / pts.length, pts.reduce((s, p) => s + p.lon, 0) / pts.length);
    else this.add(tags, pts[Math.floor(pts.length / 2)].lat, pts[Math.floor(pts.length / 2)].lon);
  }
}

const FILE = 'places.json';

export function writePlaces(dir: string, places: Place[]): void {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `${FILE}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(places));
  fs.renameSync(tmp, path.join(dir, FILE));
}

export function readPlaces(dir: string): Place[] | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8')) as Place[];
  } catch {
    return undefined;
  }
}

/** Lower case, no accents or punctuation: "Baile Átha Cliath" and "baile atha cliath" match. */
export function normalise(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/['’.]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Places people describe a search by come before roads and paths of the same name. */
const KIND_RANK = (k: string) => (['road', 'path'].includes(k) ? 2 : ['house', 'toilets', 'shelter', 'mast'].includes(k) ? 1 : 0);

/**
 * Best matches for `q`: whole name, then name start, then word start, then anywhere; ties go
 * to proper places over roads, then to whatever is nearest `near` (the search or the station).
 */
export function searchPlaces(places: Place[], q: string, near: { lat: number; lon: number }, limit = 8): Place[] {
  const nq = normalise(q);
  if (nq.length < 2) return [];
  const scored: { p: Place; s: number; d: number }[] = [];
  for (const p of places) {
    const n = normalise(p[0]);
    let s: number;
    if (n === nq) s = 0;
    else if (n.startsWith(nq)) s = 1;
    else if (n.includes(` ${nq}`)) s = 2;
    else if (n.includes(nq)) s = 3;
    else continue;
    const d = Math.hypot(p[2] - near.lat, (p[3] - near.lon) * 0.6);
    scored.push({ p, s: s * 10 + KIND_RANK(p[1]), d });
  }
  return scored.sort((a, b) => a.s - b.s || a.d - b.d).slice(0, limit).map((x) => x.p);
}
