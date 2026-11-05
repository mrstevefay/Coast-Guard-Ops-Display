import maplibregl, { type GeoJSONSource } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { DashboardState, Fix, SearchSnapshot } from '../../shared/types';
import { addSearchLayers, emptyFC, setSearchData, tracksFC, type SEARCH_LAYER_IDS } from './search/layers';

/** Great-circle ring polygon around a point, radius in km. */
export function ring(lat: number, lon: number, km: number, steps = 96): GeoJSON.Feature<GeoJSON.Polygon> {
  const R = 6371;
  const coords: [number, number][] = [];
  const lat1 = (lat * Math.PI) / 180, lon1 = (lon * Math.PI) / 180, d = km / R;
  for (let i = 0; i <= steps; i++) {
    const brg = (i / steps) * 2 * Math.PI;
    const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brg));
    const lon2 = lon1 + Math.atan2(Math.sin(brg) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
    coords.push([(lon2 * 180) / Math.PI, (lat2 * 180) / Math.PI]);
  }
  return { type: 'Feature', properties: { km, label: `${km} km` }, geometry: { type: 'Polygon', coordinates: [coords] } };
}

export interface OpsMapOptions {
  /** Pan/zoom/touch enabled (phones, console). The TV is non-interactive. */
  interactive?: boolean;
  /** Add team/target/track layers and labels. */
  search?: boolean;
  /** Seconds after which a responder dot is drawn grey. */
  staleSec?: number;
  /** Auto-fit on mode/incident change (TV). Interactive maps only fit once. */
  autoFit?: boolean;
  /** Show the 5/10 km rings. */
  rings?: boolean;
  /** Track points per user for the tracks/coverage layers. */
  showAis?: boolean;
}

type SearchLayerId = (typeof SEARCH_LAYER_IDS)[number];

export class OpsMap {
  private map?: maplibregl.Map;
  private ready = false;
  private lastMode = '';
  private lastIncidentId = '';
  private pending?: { s: DashboardState; search?: SearchSnapshot };
  private markers: maplibregl.Marker[] = [];
  private searchMarkers: maplibregl.Marker[] = [];
  private fitted = false;
  private byUser = new Map<number, Fix[]>();
  private stationLat = 53.388;
  private gapSec = 300;
  private labelsOn = true;

  constructor(private readonly opts: OpsMapOptions = {}) {}

  mount(container: HTMLElement, s: DashboardState): void {
    this.stationLat = s.station.lat;
    const sources: Record<string, maplibregl.SourceSpecification> = {
      base: { type: 'raster', tiles: [s.map.tileUrl], tileSize: 256, attribution: s.map.attribution, maxzoom: 19 },
      rings: { type: 'geojson', data: emptyFC() },
      station: { type: 'geojson', data: emptyFC() },
      incident: { type: 'geojson', data: emptyFC() },
      ipp: { type: 'geojson', data: emptyFC() },
      ais: { type: 'geojson', data: emptyFC() },
    };
    const layers: maplibregl.LayerSpecification[] = [
      { id: 'base', type: 'raster', source: 'base', paint: { 'raster-brightness-max': s.map.baseBrightness ?? 1, 'raster-saturation': -0.35, 'raster-contrast': 0.05 } },
    ];
    if (s.map.topoTileUrl) {
      // Topographic relief/contours (console toggle, hidden by default).
      sources.topo = { type: 'raster', tiles: [s.map.topoTileUrl], tileSize: 256, maxzoom: 17, attribution: s.map.topoAttribution ?? '' };
      layers.push({ id: 'topo', type: 'raster', source: 'topo', layout: { visibility: 'none' }, paint: { 'raster-opacity': 0.85, 'raster-brightness-max': s.map.baseBrightness ?? 1 } });
    }
    if (s.map.seamarkTileUrl) {
      sources.seamark = { type: 'raster', tiles: [s.map.seamarkTileUrl], tileSize: 256, maxzoom: 18 };
      layers.push({ id: 'seamark', type: 'raster', source: 'seamark', paint: { 'raster-opacity': 0.9 } });
    }
    layers.push(
      { id: 'rings-line', type: 'line', source: 'rings', paint: { 'line-color': '#9fb3c8', 'line-width': 2, 'line-dasharray': [3, 3], 'line-opacity': 0.8 } },
      { id: 'ais-dot', type: 'circle', source: 'ais', paint: { 'circle-radius': 7, 'circle-color': '#4cc9f0', 'circle-stroke-color': '#0b1016', 'circle-stroke-width': 2 } },
      { id: 'station-halo', type: 'circle', source: 'station', paint: { 'circle-radius': 22, 'circle-color': '#2dd4bf', 'circle-opacity': 0.25 } },
      { id: 'station-dot', type: 'circle', source: 'station', paint: { 'circle-radius': 11, 'circle-color': '#2dd4bf', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 3 } },
      { id: 'incident-halo', type: 'circle', source: 'incident', paint: { 'circle-radius': 34, 'circle-color': '#ef4444', 'circle-opacity': 0.3 } },
      { id: 'incident-dot', type: 'circle', source: 'incident', paint: { 'circle-radius': 15, 'circle-color': '#ef4444', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 4 } },
      // Search planning point (IPP): yellow diamond-ish marker every team can see.
      { id: 'ipp-halo', type: 'circle', source: 'ipp', paint: { 'circle-radius': 26, 'circle-color': '#facc15', 'circle-opacity': 0.25 } },
      { id: 'ipp-dot', type: 'circle', source: 'ipp', paint: { 'circle-radius': 12, 'circle-color': '#facc15', 'circle-stroke-color': '#111111', 'circle-stroke-width': 3 } },
    );

    this.map = new maplibregl.Map({
      container,
      style: { version: 8, sources, layers },
      center: [s.station.lon, s.station.lat],
      zoom: s.map.standbyZoom,
      interactive: this.opts.interactive ?? false,
      attributionControl: false,
      fadeDuration: 0,
      maxZoom: 19,
    });
    this.map.addControl(new maplibregl.AttributionControl({ compact: Boolean(this.opts.interactive) }), 'bottom-right');
    if (this.opts.interactive) this.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    this.map.on('load', () => {
      if (this.opts.search) addSearchLayers(this.map!, 'station-halo');
      this.ready = true;
      if (this.pending) this.update(this.pending.s, this.pending.search, true);
    });
    this.pending = { s };
  }

  update(s: DashboardState, search?: SearchSnapshot, force = false): void {
    if (!this.map || !this.ready) {
      this.pending = { s, search };
      return;
    }
    const m = this.map;
    const st = s.station;
    (m.getSource('rings') as GeoJSONSource).setData({ type: 'FeatureCollection', features: this.opts.rings === false ? [] : s.map.ringsKm.map((km) => ring(st.lat, st.lon, km)) });
    (m.getSource('station') as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: { label: st.shortName }, geometry: { type: 'Point', coordinates: [st.lon, st.lat] } }],
    });
    const inc = s.mode.mode === 'callout' ? s.mode.incident : undefined;
    (m.getSource('incident') as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: inc?.lat !== undefined && inc?.lon !== undefined ? [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [inc.lon, inc.lat] } }] : [],
    });
    (m.getSource('ais') as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: this.opts.showAis === false ? [] : (s.ais?.vessels ?? []).map((v) => ({ type: 'Feature', properties: { name: v.name ?? '' }, geometry: { type: 'Point', coordinates: [v.lon, v.lat] } })),
    });
    const ipp = search?.incident?.ipp;
    (m.getSource('ipp') as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: ipp ? [{ type: 'Feature', properties: { label: ipp.label ?? '' }, geometry: { type: 'Point', coordinates: [ipp.lon, ipp.lat] } }] : [],
    });

    // HTML labels (no glyph server needed on the kiosk)
    for (const mk of this.markers) mk.remove();
    this.markers = [];
    const label = (lon: number, lat: number, text: string, cls: string, offsetY: number) => {
      const el = document.createElement('div');
      el.className = `map-label ${cls}`;
      el.textContent = text;
      this.markers.push(new maplibregl.Marker({ element: el, anchor: 'top', offset: [0, offsetY] }).setLngLat([lon, lat]).addTo(m));
    };
    label(st.lon, st.lat, st.shortName, 'map-label-station', 16);
    if (inc?.lat !== undefined && inc?.lon !== undefined) label(inc.lon, inc.lat, 'INCIDENT', 'map-label-incident', 22);
    if (ipp) label(ipp.lon, ipp.lat, ipp.label ? `IPP · ${ipp.label}` : 'IPP', 'map-label-ipp', 18);
    if (this.opts.rings !== false) {
      for (const km of s.map.ringsKm) {
        const north = ring(st.lat, st.lon, km, 4).geometry.coordinates[0][0];
        label(north[0], north[1], `${km} km`, 'map-label-ring', -14);
      }
    }

    if (this.opts.search) this.updateSearch(search);

    const modeKey = `${s.mode.mode}:${inc?.id ?? search?.incident?.id ?? ''}`;
    const modeChanged = modeKey !== `${this.lastMode}:${this.lastIncidentId}`;
    if (force || modeChanged) {
      this.lastMode = s.mode.mode;
      this.lastIncidentId = inc?.id ?? search?.incident?.id ?? '';
      const shouldFit = this.opts.autoFit !== false ? true : !this.fitted;
      if (shouldFit) {
        this.fitted = true;
        requestAnimationFrame(() => {
          m.resize();
          const pts: [number, number][] = [];
          if (inc?.lat !== undefined && inc?.lon !== undefined) pts.push([inc.lon, inc.lat]);
          if (search?.incident) {
            if (search.incident.ipp) pts.push([search.incident.ipp.lon, search.incident.ipp.lat]);
            for (const f of Object.values(search.latest)) pts.push([f.lon, f.lat]);
            for (const t of search.targets) pts.push(...flat(t.geometry));
          }
          if (pts.length) {
            const b = new maplibregl.LngLatBounds([st.lon, st.lat], [st.lon, st.lat]);
            for (const p of pts) b.extend(p);
            m.fitBounds(b, { padding: this.opts.interactive ? 60 : 140, maxZoom: 14.5, duration: 0 });
          } else {
            m.jumpTo({ center: [st.lon, st.lat], zoom: s.mode.mode === 'callout' ? s.map.calloutZoom : s.map.standbyZoom });
          }
        });
      }
    }
  }

  // ---------------------------------------------------------------- search picture
  private updateSearch(search?: SearchSnapshot): void {
    const m = this.map!;
    setSearchData(m, search, this.opts.staleSec ?? 120);
    for (const mk of this.searchMarkers) mk.remove();
    this.searchMarkers = [];
    if (!search || !this.labelsOn) return;
    const mark = (lon: number, lat: number, text: string, cls: string, colour: string, offsetY: number) => {
      const el = document.createElement('div');
      el.className = `map-label ${cls}`;
      el.textContent = text;
      el.style.setProperty('--team', colour);
      this.searchMarkers.push(new maplibregl.Marker({ element: el, anchor: 'top', offset: [0, offsetY] }).setLngLat([lon, lat]).addTo(m));
    };
    for (const f of Object.values(search.latest)) {
      const team = search.teams.find((t) => t.id === f.teamId);
      mark(f.lon, f.lat, f.callsign ?? f.name.split(' ')[0], 'map-label-team', team?.colour ?? '#9fb3c8', 12);
    }
    for (const t of search.targets) {
      if (t.status === 'cancelled') continue;
      const [lon, lat] = anchorOf(t.geometry);
      const team = search.teams.find((x) => x.id === t.teamId);
      mark(lon, lat, team ? `${t.name} · ${team.name}` : t.name, `map-label-target ${t.status === 'done' ? 'done' : ''}`, team?.colour ?? '#9fb3c8', t.geometry.type === 'Point' ? 14 : 0);
    }
  }

  /** Replace the track history used for the tracks/coverage layers. */
  setTracks(byUser: Map<number, Fix[]>, search: SearchSnapshot | undefined, gapSec = 300): void {
    this.byUser = byUser;
    this.gapSec = gapSec;
    this.refreshTracks(search);
  }

  appendFixes(fixes: Fix[], search: SearchSnapshot | undefined): void {
    for (const f of fixes) {
      const arr = this.byUser.get(f.userId) ?? [];
      if (!arr.length || arr[arr.length - 1].tst < f.tst) arr.push(f);
      this.byUser.set(f.userId, arr);
    }
    this.refreshTracks(search);
  }

  private refreshTracks(search: SearchSnapshot | undefined): void {
    if (!this.map || !this.ready || !this.opts.search) return;
    const { tracks, coverage } = tracksFC(this.byUser, search?.teams ?? [], this.stationLat, this.gapSec);
    (this.map.getSource('tracks') as GeoJSONSource | undefined)?.setData(tracks);
    (this.map.getSource('coverage') as GeoJSONSource | undefined)?.setData(coverage);
  }

  setLayerVisible(id: SearchLayerId | 'ais-dot' | 'rings-line' | 'labels' | 'topo', on: boolean): void {
    if (id === 'labels') {
      this.labelsOn = on;
      for (const mk of this.searchMarkers) mk.getElement().style.display = on ? '' : 'none';
      return;
    }
    if (this.map?.getLayer(id)) this.map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  }

  flyTo(lon: number, lat: number, zoom = 15): void {
    this.map?.flyTo({ center: [lon, lat], zoom, duration: 600 });
  }

  fitAll(s: DashboardState, search?: SearchSnapshot): void {
    this.fitted = false;
    this.update(s, search, true);
  }

  getMap(): maplibregl.Map | undefined {
    return this.map;
  }

  resize(): void {
    this.map?.resize();
  }
}

function flat(g: { type: string; coordinates: unknown }): [number, number][] {
  if (g.type === 'Point') return [g.coordinates as [number, number]];
  if (g.type === 'LineString') return g.coordinates as [number, number][];
  return (g.coordinates as [number, number][][])[0];
}

export function anchorOf(g: { type: string; coordinates: unknown }): [number, number] {
  const pts = flat(g);
  const n = pts.length;
  return [pts.reduce((s, c) => s + c[0], 0) / n, pts.reduce((s, c) => s + c[1], 0) / n];
}
