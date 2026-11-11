import maplibregl, { type GeoJSONSource, type ImageSource } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { POINT_KIND_SHORT, type DashboardState, type Fix, type PlanningPointRow, type SearchAreaResult, type SearchSnapshot } from '../../shared/types';
import { declutter, groupOverlapping, type Dot, type LabelIn } from '../../shared/declutter';
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
  private behaviourMarkers: maplibregl.Marker[] = [];
  private behaviourFeatures: GeoJSON.Feature<GeoJSON.Polygon>[] = [];
  private behaviourOn = true;
  private segmentMarkers: maplibregl.Marker[] = [];
  private terrainOn = true;
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
      behaviour: { type: 'geojson', data: emptyFC() },
      'search-area': { type: 'geojson', data: emptyFC() },
      segments: { type: 'geojson', data: emptyFC() },
      corridors: { type: 'geojson', data: emptyFC() },
      highlight: { type: 'geojson', data: emptyFC() },
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
      // Terrain-shaped search areas (console only): nested regions, so the inner ones read darker.
      { id: 'area-fill', type: 'fill', source: 'search-area', paint: { 'fill-color': '#f59e0b', 'fill-opacity': 0.09 } },
      { id: 'area-line', type: 'line', source: 'search-area', paint: { 'line-color': '#fbbf24', 'line-width': ['match', ['get', 'pct'], 50, 2.5, 2], 'line-opacity': 0.95 } },
      // invisible fill so a click anywhere inside a segment hits it
      { id: 'segment-fill', type: 'fill', source: 'segments', paint: { 'fill-color': '#ffffff', 'fill-opacity': 0 } },
      { id: 'segment-line', type: 'line', source: 'segments', paint: { 'line-color': '#ffffff', 'line-width': 1.5, 'line-dasharray': [2, 2], 'line-opacity': 0.85 } },
      { id: 'highlight-line', type: 'line', source: 'highlight', layout: { 'line-join': 'round' }, paint: { 'line-color': '#22d3ee', 'line-width': 4, 'line-opacity': 0.95 } },
      { id: 'highlight-point', type: 'circle', source: 'highlight', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 12, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': '#22d3ee', 'circle-stroke-width': 3 } },
      { id: 'corridor-line', type: 'line', source: 'corridors', layout: { 'line-cap': 'round' }, paint: { 'line-color': '#f472b6', 'line-width': 3, 'line-dasharray': [1, 1.5], 'line-opacity': 0.95 } },
      // Lost person behaviour rings (console only): % of subjects found within this distance of the IPP.
      { id: 'behaviour-fill', type: 'fill', source: 'behaviour', paint: { 'fill-color': '#f59e0b', 'fill-opacity': 0.05 } },
      { id: 'behaviour-line', type: 'line', source: 'behaviour', paint: { 'line-color': '#f59e0b', 'line-width': 2, 'line-dasharray': [4, 2], 'line-opacity': 0.9 } },
      // Search planning point (IPP): yellow diamond-ish marker every team can see.
      // Planning points: LKP yellow (the point the search is drawn from), PLS orange, significant places pink, home/vehicle grey-blue.
      { id: 'ipp-halo', type: 'circle', source: 'ipp', paint: { 'circle-radius': ['match', ['get', 'kind'], 'lkp', 26, 'pls', 20, 'find', 22, 0], 'circle-color': ['match', ['get', 'kind'], 'pls', '#fb923c', 'find', '#ef4444', '#facc15'], 'circle-opacity': 0.25 } },
      {
        id: 'ipp-dot',
        type: 'circle',
        source: 'ipp',
        paint: {
          'circle-radius': ['match', ['get', 'kind'], 'lkp', 12, 'pls', 10, 8],
          'circle-color': ['match', ['get', 'kind'], 'lkp', '#facc15', 'pls', '#fb923c', 'significant', '#f472b6', 'home', '#94a3b8', 'vehicle', '#60a5fa', 'find', '#ef4444', '#cbd5e1'],
          'circle-stroke-color': '#111111',
          'circle-stroke-width': ['match', ['get', 'kind'], 'lkp', 3, 2],
        },
      },
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
    for (const ev of ['zoom', 'rotate', 'pitch', 'resize'] as const) this.map.on(ev, () => this.scheduleDeclutter());
    this.map.on('load', () => {
      if (this.opts.search) addSearchLayers(this.map!, 'station-halo');
      this.ready = true;
      if (this.pending) this.update(this.pending.s, this.pending.search, true);
      if (this.pendingArea) this.setSearchArea(this.pendingArea.area);
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
    const points = pointsOf(search);
    (m.getSource('ipp') as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: points.map((p) => ({ type: 'Feature', properties: { kind: p.kind, label: p.label ?? '' }, geometry: { type: 'Point', coordinates: [p.lon, p.lat] } })),
    });

    // HTML labels (no glyph server needed on the kiosk)
    for (const mk of this.markers) mk.remove();
    this.markers = [];
    const label = (lon: number, lat: number, text: string, cls: string, offsetY: number, prio: number, dotR = 0, keep = false) => {
      const el = document.createElement('div');
      el.className = `map-label ${cls}`;
      el.textContent = text;
      tagLabel(el, prio, 'top', [0, offsetY], dotR, keep);
      this.markers.push(new maplibregl.Marker({ element: el, anchor: 'top', offset: [0, offsetY] }).setLngLat([lon, lat]).addTo(m));
    };
    label(st.lon, st.lat, st.shortName, 'map-label-station', 16, 3, 14, true);
    if (inc?.lat !== undefined && inc?.lon !== undefined) label(inc.lon, inc.lat, 'INCIDENT', 'map-label-incident', 22, 0, 19, true);
    for (const p of points) {
      const short = POINT_KIND_SHORT[p.kind];
      const text = p.kind === 'lkp' || p.kind === 'pls' ? (p.label ? `${short} · ${p.label}` : short) : p.kind === 'significant' ? `★ ${p.label ?? 'Significant place'}` : p.label ?? short;
      label(p.lon, p.lat, text, p.kind === 'lkp' ? 'map-label-ipp' : `map-label-pt k-${p.kind}`, p.kind === 'lkp' ? 18 : 14, POINT_PRIO[p.kind] ?? 4, p.kind === 'lkp' ? 15 : p.kind === 'pls' ? 12 : 10, p.kind === 'lkp');
    }
    void ipp;
    if (this.opts.rings !== false) {
      for (const km of s.map.ringsKm) {
        const north = ring(st.lat, st.lon, km, 4).geometry.coordinates[0][0];
        label(north[0], north[1], `${km} km`, 'map-label-ring', -14, 9);
      }
    }

    if (this.opts.search) this.updateSearch(search);
    this.scheduleDeclutter();

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
            for (const p of pointsOf(search)) pts.push([p.lon, p.lat]);
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
    const mark = (lon: number, lat: number, text: string, cls: string, colour: string, offsetY: number, prio: number, dotR: number) => {
      const el = document.createElement('div');
      el.className = `map-label ${cls}`;
      el.textContent = text;
      el.style.setProperty('--team', colour);
      tagLabel(el, prio, 'top', [0, offsetY], dotR);
      el.dataset.text = text;
      this.searchMarkers.push(new maplibregl.Marker({ element: el, anchor: 'top', offset: [0, offsetY] }).setLngLat([lon, lat]).addTo(m));
      return el;
    };
    for (const f of Object.values(search.latest)) {
      const team = search.teams.find((t) => t.id === f.teamId);
      const el = mark(f.lon, f.lat, f.callsign ?? f.name.split(' ')[0], 'map-label-team', team?.colour ?? '#9fb3c8', 12, 2, 10);
      if (team) {
        el.dataset.team = String(team.id); // crew of one team close together share one label
        el.dataset.teamName = team.name;
      }
    }
    for (const t of search.targets) {
      if (t.status === 'cancelled') continue;
      const [lon, lat] = anchorOf(t.geometry);
      const team = search.teams.find((x) => x.id === t.teamId);
      mark(lon, lat, team ? `${t.name} · ${team.name}` : t.name, `map-label-target ${t.status === 'done' ? 'done' : ''}`, team?.colour ?? '#9fb3c8', t.geometry.type === 'Point' ? 14 : 6, t.status === 'done' ? 6 : 5, t.geometry.type === 'Point' ? 12 : 0);
    }
  }

  /**
   * Draw the lost-person-behaviour distance rings around the planning point: each ring
   * is the distance within which `pct` % of that category's subjects were found. Pass no
   * point or no rings to clear. Labels sit on the east edge.
   */
  setBehaviourRings(ipp: { lat: number; lon: number } | undefined, rings: { pct: number; km: number }[]): void {
    if (!this.map || !this.ready) return;
    const m = this.map;
    for (const mk of this.behaviourMarkers) mk.remove();
    this.behaviourMarkers = [];
    const features = ipp ? rings.map((r) => ({ ...ring(ipp.lat, ipp.lon, r.km), properties: { pct: r.pct, km: r.km } })) : [];
    this.behaviourFeatures = features;
    (m.getSource('behaviour') as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features });
    this.scheduleDeclutter();
    if (!ipp) return;
    for (const r of rings) {
      // east edge, just outside the ring: clear of the station to the north and of the point itself
      const east = ring(ipp.lat, ipp.lon, r.km, 4).geometry.coordinates[0][1];
      const el = document.createElement('div');
      el.className = 'map-label map-label-behaviour';
      el.textContent = `${r.pct} % · ${r.km < 1 ? `${Math.round(r.km * 1000)} m` : `${r.km} km`}`;
      el.style.display = this.behaviourOn ? '' : 'none';
      tagLabel(el, 7, 'left', [6, 0]);
      this.behaviourMarkers.push(new maplibregl.Marker({ element: el, anchor: 'left', offset: [6, 0] }).setLngLat([east[0], east[1]]).addTo(m));
    }
  }

  private lastHeatUrl = '';
  /** Terrain-shaped regions, probability heat, ranked segments and corridors. Pass undefined to clear. */
  setSearchArea(area: Pick<SearchAreaResult, 'regions' | 'heat' | 'segments' | 'corridors'> | undefined): void {
    this.pendingArea = { area };
    const m = this.map;
    if (!m || !this.ready) return; // applied from the load handler
    this.pendingArea = undefined;
    this.shownArea = area;
    (m.getSource('search-area') as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: (area?.regions ?? []).slice().sort((a, b) => b.km - a.km).map((r) => ({ type: 'Feature', properties: { pct: r.pct, km: r.km }, geometry: r.geometry })) });
    (m.getSource('segments') as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: (area?.segments ?? []).map((s) => ({ type: 'Feature', properties: { id: s.id, poa: s.poaPct }, geometry: s.geometry })) });
    (m.getSource('corridors') as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: (area?.corridors ?? []).map((c) => ({ type: 'Feature', properties: { label: c.label }, geometry: c.geometry })) });
    // heat: an image source, added on first use under the region outlines
    const heat = area?.heat;
    if (!heat) {
      if (m.getLayer('heat')) m.removeLayer('heat');
      if (m.getSource('heat')) m.removeSource('heat');
      this.lastHeatUrl = '';
    } else if (heat.url !== this.lastHeatUrl) {
      const src = m.getSource('heat') as ImageSource | undefined;
      if (src) src.updateImage({ url: heat.url, coordinates: heat.coordinates });
      else {
        m.addSource('heat', { type: 'image', url: heat.url, coordinates: heat.coordinates });
        m.addLayer({ id: 'heat', type: 'raster', source: 'heat', paint: { 'raster-opacity': 0.8, 'raster-fade-duration': 0 }, layout: { visibility: this.heatOn ? 'visible' : 'none' } }, 'area-fill');
      }
      this.lastHeatUrl = heat.url;
    }
    for (const mk of this.segmentMarkers) mk.remove();
    this.segmentMarkers = [];
    for (const s of area?.segments ?? []) {
      const ring = s.targetRing.length ? s.targetRing : s.geometry.coordinates[0]?.[0] ?? [];
      if (!ring.length) continue;
      const lon = ring.reduce((a, p) => a + p[0], 0) / ring.length, lat = ring.reduce((a, p) => a + p[1], 0) / ring.length;
      const el = document.createElement('div');
      el.className = 'map-label map-label-seg';
      el.textContent = s.id; // the probability is in the console list; the map only names the square
      el.title = `${s.id}: ${s.poaPct} %`;
      // width of the square in metres, so the label only shows once the square is big enough on screen
      const lons = ring.map((p) => p[0]);
      tagLabel(el, 8, 'center', [0, 0]);
      el.dataset.widthM = String((Math.max(...lons) - Math.min(...lons)) * 111_320 * Math.cos((lat * Math.PI) / 180));
      this.segmentMarkers.push(new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([lon, lat]).addTo(m));
    }
    this.refreshSegmentLabels();
    if (!this.segZoomHooked) {
      this.segZoomHooked = true;
      m.on('zoomend', () => this.refreshSegmentLabels());
    }
  }
  private segZoomHooked = false;
  /** A segment label shows when its square is at least about 40 px wide at the current zoom. */
  private refreshSegmentLabels(): void {
    const m = this.map;
    if (!m) return;
    const mPerPx = (78_271.52 * Math.cos((m.getCenter().lat * Math.PI) / 180)) / 2 ** m.getZoom(); // MapLibre: 512 px tiles
    for (const mk of this.segmentMarkers) {
      const el = mk.getElement();
      el.style.display = this.terrainOn && Number(el.dataset.widthM ?? 0) / mPerPx >= 40 ? '' : 'none';
    }
    this.scheduleDeclutter();
  }

  // ---------------------------------------------------------------- label placement
  private declutterQueued = false;
  /** Re-place labels on the next frame (after a redraw, a zoom or a layer toggle). */
  private scheduleDeclutter(): void {
    if (this.declutterQueued) return;
    this.declutterQueued = true;
    requestAnimationFrame(() => {
      this.declutterQueued = false;
      this.declutterNow();
    });
  }
  private declutterNow(): void {
    const m = this.map;
    if (!m) return;
    const { width, height } = m.getContainer().getBoundingClientRect();
    type Item = LabelIn & { mk: maplibregl.Marker; group?: string; shift?: [number, number] };
    const all: Item[] = [], dots: Dot[] = [];
    for (const mk of [...this.markers, ...this.searchMarkers, ...this.behaviourMarkers, ...this.segmentMarkers]) {
      const el = mk.getElement();
      if (!el.dataset.prio || el.style.display === 'none') continue;
      if (el.dataset.text !== undefined && el.textContent !== el.dataset.text) el.textContent = el.dataset.text; // undo a merge
      const p = m.project(mk.getLngLat());
      const base: [number, number] = [Number(el.dataset.ox), Number(el.dataset.oy)];
      if (p.x < -300 || p.y < -300 || p.x > width + 300 || p.y > height + 300) {
        el.style.visibility = '';
        mk.setOffset(base);
        continue;
      }
      const dotR = Number(el.dataset.dot ?? 0);
      if (dotR) dots.push({ x: p.x, y: p.y, r: dotR, owner: all.length });
      all.push({ mk, x: p.x, y: p.y, w: el.offsetWidth, h: el.offsetHeight, anchor: el.dataset.anchor as LabelIn['anchor'], offset: base, prio: Number(el.dataset.prio), keep: el.dataset.keep === '1', group: el.dataset.team });
    }
    // crew of one team whose labels would overlap: one label, "Alpha ×3", centred on them
    const merged = new Set<number>();
    for (const c of groupOverlapping(all)) {
      const lead = all[c[0]], el = lead.mk.getElement();
      const cx = c.reduce((t, i) => t + all[i].x, 0) / c.length, cy = c.reduce((t, i) => t + all[i].y, 0) / c.length;
      el.textContent = `${el.dataset.teamName ?? 'Team'} ×${c.length}`;
      Object.assign(lead, { x: cx, y: cy, w: el.offsetWidth, h: el.offsetHeight, shift: [cx - lead.x, cy - lead.y] });
      for (const i of c.slice(1)) merged.add(i);
      for (const d of dots) if (d.owner !== undefined && c.includes(d.owner)) d.owner = c[0]; // may sit over its own crew
    }
    const idx: number[] = [];
    all.forEach((it, i) => (merged.has(i) ? (it.mk.getElement().style.visibility = 'hidden') : idx.push(i)));
    const remap = new Map(idx.map((i, k) => [i, k]));
    const ds = dots.map((d) => ({ ...d, owner: d.owner === undefined ? undefined : remap.get(d.owner) ?? -1 }));
    declutter(idx.map((i) => all[i]), ds, { w: width, h: height }).forEach((r, k) => {
      const it = all[idx[k]], el = it.mk.getElement();
      el.style.visibility = r ? '' : 'hidden';
      if (r) it.mk.setOffset([r.offset[0] + (it.shift?.[0] ?? 0), r.offset[1] + (it.shift?.[1] ?? 0)]);
    });
  }
  private heatOn = true;
  private shownArea?: Pick<SearchAreaResult, 'regions' | 'heat' | 'segments' | 'corridors'>;
  private pendingArea?: { area: Pick<SearchAreaResult, 'regions' | 'heat' | 'segments' | 'corridors'> | undefined };

  /** Zoom to the behaviour rings (no-op when none are drawn). */
  fitBehaviourRings(): void {
    // prefer the terrain area (the circle is often mostly sea); else the rings
    const area = this.shownArea?.regions ?? [];
    const outer = area.length ? area.reduce((a, b) => (b.km > a.km ? b : a)) : undefined;
    const pts = outer ? outer.geometry.coordinates.flatMap((poly) => poly[0] as [number, number][]) : this.behaviourFeatures.flatMap((f) => flat(f.geometry));
    if (!pts.length || !this.map) return;
    const b = new maplibregl.LngLatBounds(pts[0], pts[0]);
    for (const p of pts) b.extend(p);
    this.map.fitBounds(b, { padding: { top: 70, left: 40, right: 40, bottom: 40 }, duration: 400 });
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

  setLayerVisible(id: SearchLayerId | 'ais-dot' | 'rings-line' | 'labels' | 'topo' | 'behaviour-fill' | 'behaviour-line' | 'area-fill' | 'area-line' | 'segment-line' | 'corridor-line' | 'heat', on: boolean): void {
    if (id === 'heat') this.heatOn = on;
    if (id === 'segment-line') {
      this.terrainOn = on;
      if (this.map?.getLayer('segment-fill')) this.map.setLayoutProperty('segment-fill', 'visibility', on ? 'visible' : 'none');
      this.refreshSegmentLabels();
    }
    if (id === 'behaviour-line') {
      this.behaviourOn = on;
      for (const mk of this.behaviourMarkers) mk.getElement().style.display = on ? '' : 'none';
      this.scheduleDeclutter();
    }
    if (id === 'labels') {
      this.labelsOn = on;
      for (const mk of this.searchMarkers) mk.getElement().style.display = on ? '' : 'none';
      this.scheduleDeclutter();
      return;
    }
    if (this.map?.getLayer(id)) this.map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  }

  /** The caller sets the first view itself (the crew map opens on the member's target): skip the automatic fit. */
  skipFirstFit(): void {
    this.fitted = true;
  }

  /** Outline one shape in cyan (a list row being hovered); undefined clears it. */
  highlight(geometry: GeoJSON.Geometry | undefined): void {
    (this.map?.getSource('highlight') as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: geometry ? [{ type: 'Feature', properties: {}, geometry }] : [] });
  }

  /** What a click landed on: a target (preferred, it is on top) or a terrain segment. */
  shapeAt(point: maplibregl.PointLike): { kind: 'target'; id: number } | { kind: 'segment'; id: string } | undefined {
    const m = this.map;
    if (!m) return undefined;
    const layers = ['targets-point', 'targets-line', 'targets-fill', 'segment-fill'].filter((l) => m.getLayer(l) && m.getLayoutProperty(l, 'visibility') !== 'none');
    const hits = m.queryRenderedFeatures(point, { layers });
    const t = hits.find((f) => f.layer.id.startsWith('targets-'));
    if (t) return { kind: 'target', id: Number(t.properties?.id) };
    const sg = hits.find((f) => f.layer.id === 'segment-fill');
    return sg ? { kind: 'segment', id: String(sg.properties?.id) } : undefined;
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

/** All planning points; falls back to the single IPP for an older server (Pi mirror talking to a not-yet-upgraded host). */
/** Placement order for point labels (lower first): the LKP, then PLS and finds, then the rest. */
const POINT_PRIO: Partial<Record<string, number>> = { lkp: 0, pls: 1, find: 1 };

/** Mark an HTML label for placement: its priority, how it is pinned, its usual offset and its point's dot. */
function tagLabel(el: HTMLElement, prio: number, anchor: LabelIn['anchor'], offset: [number, number], dotR = 0, keep = false): void {
  el.dataset.prio = String(prio);
  el.dataset.anchor = anchor;
  el.dataset.ox = String(offset[0]);
  el.dataset.oy = String(offset[1]);
  if (dotR) el.dataset.dot = String(dotR);
  if (keep) el.dataset.keep = '1';
}

function pointsOf(search?: SearchSnapshot): PlanningPointRow[] {
  const inc = search?.incident;
  if (!inc) return [];
  if (inc.points) return inc.points;
  return inc.ipp ? [{ id: 0, incidentId: inc.id, kind: 'lkp', label: inc.ipp.label, lat: inc.ipp.lat, lon: inc.ipp.lon, setAt: inc.ipp.setAt }] : [];
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
