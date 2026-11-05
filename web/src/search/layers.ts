import type maplibregl from 'maplibre-gl';
import type { Fix, SearchSnapshot, Target, Team } from '../../../shared/types';

/** Source ids added to any map that shows the search picture. */
export const SEARCH_SOURCES = ['targets', 'tracks', 'coverage', 'teams'] as const;
export const SEARCH_LAYER_IDS = ['coverage-line', 'tracks-line', 'targets-fill', 'targets-line', 'targets-point', 'teams-halo', 'teams-dot', 'teams-heading'] as const;

/**
 * Width in CSS px at zoom 0 that corresponds to `metres` on the ground at
 * latitude φ (Web Mercator): px = m / (156543.03392 · cos φ) at z0, doubling per zoom.
 */
export function metresToZoom0Px(metres: number, latDeg: number): number {
  return metres / (156543.03392 * Math.cos((latDeg * Math.PI) / 180));
}

export function emptyFC(): GeoJSON.FeatureCollection {
  return { type: 'FeatureCollection', features: [] };
}

export function addSearchLayers(map: maplibregl.Map, beforeId?: string): void {
  for (const id of SEARCH_SOURCES) if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: emptyFC() });
  const add = (layer: maplibregl.LayerSpecification) => {
    if (!map.getLayer(layer.id)) map.addLayer(layer, beforeId);
  };
  // covered swath: metre-wide translucent line per team (width property = px at z0)
  add({
    id: 'coverage-line',
    type: 'line',
    source: 'coverage',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['get', 'colour'],
      'line-opacity': 0.3,
      'line-width': ['interpolate', ['exponential', 2], ['zoom'], 0, ['get', 'wpx0'], 22, ['*', ['get', 'wpx0'], 4194304]],
    },
  });
  add({ id: 'tracks-line', type: 'line', source: 'tracks', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['get', 'colour'], 'line-width': 2.5, 'line-opacity': 0.9 } });
  add({ id: 'targets-fill', type: 'fill', source: 'targets', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': ['get', 'colour'], 'fill-opacity': ['case', ['==', ['get', 'status'], 'done'], 0.06, 0.18] } });
  add({
    id: 'targets-line',
    type: 'line',
    source: 'targets',
    filter: ['!=', ['geometry-type'], 'Point'],
    paint: { 'line-color': ['get', 'colour'], 'line-width': 3, 'line-dasharray': [2, 1.5], 'line-opacity': ['case', ['==', ['get', 'status'], 'done'], 0.4, 1] },
  });
  add({
    id: 'targets-point',
    type: 'circle',
    source: 'targets',
    filter: ['==', ['geometry-type'], 'Point'],
    paint: { 'circle-radius': 10, 'circle-color': ['get', 'colour'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 2, 'circle-opacity': ['case', ['==', ['get', 'status'], 'done'], 0.4, 1] },
  });
  add({ id: 'teams-halo', type: 'circle', source: 'teams', paint: { 'circle-radius': 16, 'circle-color': ['get', 'colour'], 'circle-opacity': ['case', ['get', 'stale'], 0.08, 0.25] } });
  add({
    id: 'teams-dot',
    type: 'circle',
    source: 'teams',
    paint: { 'circle-radius': 8, 'circle-color': ['case', ['get', 'stale'], '#6b7280', ['get', 'colour']], 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 },
  });
}

export const UNASSIGNED_COLOUR = '#9fb3c8';

export function teamColour(teams: Team[], teamId?: number): string {
  return teams.find((t) => t.id === teamId)?.colour ?? UNASSIGNED_COLOUR;
}

export function targetsFC(targets: Target[], teams: Team[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: targets
      .filter((t) => t.status !== 'cancelled')
      .map((t) => ({ type: 'Feature', id: t.id, properties: { id: t.id, name: t.name, status: t.status, teamId: t.teamId ?? null, colour: teamColour(teams, t.teamId), priority: t.priority }, geometry: t.geometry })),
  };
}

export function teamsFC(latest: Record<number, Fix>, teams: Team[], staleSec: number, nowSec = Date.now() / 1000): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: Object.values(latest).map((f) => ({
      type: 'Feature',
      id: f.userId,
      properties: { userId: f.userId, name: f.name, callsign: f.callsign ?? '', teamId: f.teamId ?? null, colour: teamColour(teams, f.teamId), stale: nowSec - f.tst > staleSec, cog: f.cogDeg ?? null, tst: f.tst },
      geometry: { type: 'Point', coordinates: [f.lon, f.lat] },
    })),
  };
}

/** Build tracks + coverage collections from per-user fix lists. */
export function tracksFC(byUser: Map<number, Fix[]>, teams: Team[], stationLat: number, gapSec: number): { tracks: GeoJSON.FeatureCollection; coverage: GeoJSON.FeatureCollection } {
  const tracks: GeoJSON.Feature[] = [];
  const coverage: GeoJSON.Feature[] = [];
  for (const [userId, fixes] of byUser) {
    const sorted = [...fixes].sort((a, b) => a.tst - b.tst);
    let seg: [number, number][] = [];
    let last = 0;
    let teamId = sorted[0]?.teamId;
    const flush = () => {
      if (seg.length < 2) seg = [];
      if (!seg.length) return;
      const team = teams.find((t) => t.id === teamId);
      const colour = team?.colour ?? UNASSIGNED_COLOUR;
      const width = team?.searchWidthM ?? 20;
      tracks.push({ type: 'Feature', properties: { userId, teamId: teamId ?? null, colour }, geometry: { type: 'LineString', coordinates: seg } });
      coverage.push({ type: 'Feature', properties: { userId, teamId: teamId ?? null, colour, wpx0: metresToZoom0Px(width * 2, stationLat) }, geometry: { type: 'LineString', coordinates: seg } });
      seg = [];
    };
    for (const f of sorted) {
      if (seg.length && (f.tst - last > gapSec || f.teamId !== teamId)) flush();
      teamId = f.teamId;
      seg.push([f.lon, f.lat]);
      last = f.tst;
    }
    flush();
  }
  return { tracks: { type: 'FeatureCollection', features: tracks }, coverage: { type: 'FeatureCollection', features: coverage } };
}

export function setSearchData(map: maplibregl.Map, search: SearchSnapshot | undefined, staleSec: number): void {
  const teams = search?.teams ?? [];
  (map.getSource('targets') as maplibregl.GeoJSONSource | undefined)?.setData(search ? targetsFC(search.targets, teams) : emptyFC());
  (map.getSource('teams') as maplibregl.GeoJSONSource | undefined)?.setData(search ? teamsFC(search.latest, teams, staleSec) : emptyFC());
}
