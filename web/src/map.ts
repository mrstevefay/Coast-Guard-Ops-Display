import maplibregl, { type GeoJSONSource } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { DashboardState } from '../../shared/types';

/** Great-circle ring polygon around a point, radius in km. */
function ring(lat: number, lon: number, km: number, steps = 96): GeoJSON.Feature<GeoJSON.Polygon> {
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

export class OpsMap {
  private map?: maplibregl.Map;
  private ready = false;
  private lastMode = '';
  private lastIncidentId = '';
  private pending?: DashboardState;
  private markers: maplibregl.Marker[] = [];

  mount(container: HTMLElement, s: DashboardState): void {
    const sources: Record<string, maplibregl.SourceSpecification> = {
      base: { type: 'raster', tiles: [s.map.tileUrl], tileSize: 256, attribution: s.map.attribution, maxzoom: 19 },
      rings: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
      station: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
      incident: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
      ais: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
    };
    const layers: maplibregl.LayerSpecification[] = [
      { id: 'base', type: 'raster', source: 'base', paint: { 'raster-brightness-max': s.map.baseBrightness ?? 1, 'raster-saturation': -0.35, 'raster-contrast': 0.05 } },
    ];
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
    );

    this.map = new maplibregl.Map({
      container,
      style: { version: 8, sources, layers },
      center: [s.station.lon, s.station.lat],
      zoom: s.map.standbyZoom,
      interactive: false,
      attributionControl: false,
      fadeDuration: 0,
    });
    this.map.addControl(new maplibregl.AttributionControl({ compact: false }), 'bottom-right');
    this.map.on('load', () => {
      this.ready = true;
      if (this.pending) this.update(this.pending, true);
    });
    this.pending = s;
  }

  update(s: DashboardState, force = false): void {
    if (!this.map || !this.ready) {
      this.pending = s;
      return;
    }
    const m = this.map;
    const st = s.station;
    (m.getSource('rings') as GeoJSONSource).setData({ type: 'FeatureCollection', features: s.map.ringsKm.map((km) => ring(st.lat, st.lon, km)) });
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
      features: (s.ais?.vessels ?? []).map((v) => ({ type: 'Feature', properties: { name: v.name ?? '' }, geometry: { type: 'Point', coordinates: [v.lon, v.lat] } })),
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
    for (const km of s.map.ringsKm) {
      const north = ring(st.lat, st.lon, km, 4).geometry.coordinates[0][0];
      label(north[0], north[1], `${km} km`, 'map-label-ring', -14);
    }

    const modeKey = `${s.mode.mode}:${inc?.id ?? ''}`;
    if (force || modeKey !== `${this.lastMode}:${this.lastIncidentId}`) {
      this.lastMode = s.mode.mode;
      this.lastIncidentId = inc?.id ?? '';
      requestAnimationFrame(() => {
        m.resize();
        if (inc?.lat !== undefined && inc?.lon !== undefined) {
          const b = new maplibregl.LngLatBounds([st.lon, st.lat], [st.lon, st.lat]).extend([inc.lon, inc.lat]);
          m.fitBounds(b, { padding: 140, maxZoom: 13.5, duration: 0 });
        } else {
          m.jumpTo({ center: [st.lon, st.lat], zoom: s.mode.mode === 'callout' ? s.map.calloutZoom : s.map.standbyZoom });
        }
      });
    }
  }

  resize(): void {
    this.map?.resize();
  }
}
