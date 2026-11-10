import { anchorOf, OpsMap } from '../../map';
import { bearingDeg, distanceM, esc, fmtDistance } from '../../format';
import { store } from '../store';
import { toast, wireActions } from '../ui';

let map: OpsMap | undefined;
let mapEl: HTMLElement | undefined;
let unsub: (() => void) | undefined;
let watchId: number | undefined;
let meMarker: HTMLElement | undefined;

/** Interactive map with the search picture. The map element persists across visits. */
export function renderMapPage(root: HTMLElement): void {
  const s = store.s.state;
  if (!s) {
    root.innerHTML = '<p class="note muted">Connecting…</p>';
    return;
  }
  if (!mapEl) {
    mapEl = document.createElement('div');
    mapEl.className = 'map-m';
  }
  // Full-screen map. Tools sit top left, clear of the zoom buttons; the strip at the bottom names
  // the crew member's target with a Navigate button.
  root.innerHTML = `<div class="map-wrap full"><div class="map-tools">
      <button class="btn small" data-action="mine">My target</button>
      <button class="btn small" data-action="me">◎ Me</button>
      <button class="btn small" data-action="fit">⤢ All</button>
      <button class="btn small on" data-action="coverage">Coverage</button>
    </div><div class="map-sheet" id="map-sheet"></div></div>`;
  root.querySelector('.map-wrap')!.prepend(mapEl);
  document.body.classList.add('map-full');
  const t = myTarget();
  if (!map) {
    map = new OpsMap({ interactive: true, search: true, autoFit: false, staleSec: 120 });
    map.mount(mapEl, s);
    // in a team: the view is the team's target, set below, not the automatic fit to everything
    if (t || store.mine.team) map.skipFirstFit();
  }
  sizeMap(root);
  map.resize();
  map.update(s, store.s.search);
  map.setTracks(store.s.tracks, store.s.search);
  renderSheet(root);
  openOnTarget();
  unsub?.();
  unsub = store.subscribe(() => {
    if (!store.s.state) return;
    map!.update(store.s.state, store.s.search);
    map!.setTracks(store.s.tracks, store.s.search);
    renderSheet(root);
    openOnTarget();
  });
  let coverageOn = true;
  wireActions(root, {
    mine: () => { const x = myTarget(); if (x) fitTarget(x.geometry); else toast('No target assigned yet', true); },
    fit: () => map!.fitAll(store.s.state!, store.s.search),
    coverage: (el) => {
      coverageOn = !coverageOn;
      map!.setLayerVisible('coverage-line', coverageOn);
      el.classList.toggle('on', coverageOn);
    },
    me: () => locateMe(),
  });
}

let openedOn: number | undefined;

/**
 * Move to the crew member's target the first time it is known: on opening the map, or when the
 * manager assigns one while the map is open. MapLibre's loaded() stays false while tiles download
 * even after 'load' has fired, so fit now, on load if that is still to come, and once more shortly.
 */
function openOnTarget(): void {
  const t = myTarget();
  if (!t || openedOn === t.id || !map) return;
  openedOn = t.id;
  const go = () => fitTarget(t.geometry);
  go();
  map.getMap()?.once('load', () => setTimeout(go, 250));
  setTimeout(go, 900);
}

/** The map fills the space between the header and the tab bar exactly (phones differ in both). */
function sizeMap(root: HTMLElement): void {
  const wrap = root.querySelector<HTMLElement>('.map-wrap.full');
  const head = document.querySelector<HTMLElement>('.m-head');
  const tabs = document.querySelector<HTMLElement>('.tabs');
  if (!wrap || !head || !tabs) return;
  wrap.style.height = `${Math.max(280, window.innerHeight - head.getBoundingClientRect().bottom - tabs.getBoundingClientRect().height)}px`;
}
window.addEventListener('resize', () => { const root = document.getElementById('page'); if (root && document.body.classList.contains('map-full')) { sizeMap(root); map?.resize(); } });

/** The crew member's current target: the one being searched, else the next one assigned. */
function myTarget() {
  const team = store.mine.team;
  if (!team) return undefined;
  const live = (store.s.search?.targets ?? []).filter((t) => t.teamId === team.id && t.status !== 'done' && t.status !== 'cancelled');
  return live.find((t) => t.status === 'in-progress') ?? live[0];
}

function fitTarget(g: { type: string; coordinates: unknown }): void {
  const m = map?.getMap();
  if (!m) return;
  const pts: [number, number][] = g.type === 'Point' ? [g.coordinates as [number, number]] : g.type === 'LineString' ? (g.coordinates as [number, number][]) : ((g.coordinates as [number, number][][])[0] ?? []);
  if (!pts.length) return;
  if (pts.length === 1) return map!.flyTo(pts[0][0], pts[0][1], 16);
  const lons = pts.map((p) => p[0]), lats = pts.map((p) => p[1]);
  m.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: { top: 70, bottom: 110, left: 40, right: 40 }, maxZoom: 17, duration: 500 });
}

function renderSheet(root: HTMLElement): void {
  const el = root.querySelector<HTMLElement>('#map-sheet');
  if (!el) return;
  const t = myTarget();
  if (!t) { el.hidden = true; return; }
  el.hidden = false;
  const [lon, lat] = anchorOf(t.geometry);
  const me = store.s.me ? store.s.search?.latest[store.s.me.id] : undefined;
  const far = me ? `${fmtDistance(distanceM(me.lat, me.lon, lat, lon))} · ${Math.round(bearingDeg(me.lat, me.lon, lat, lon)).toString().padStart(3, '0')}°` : '';
  const key = `${t.id}:${t.status}:${far}`;
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  el.innerHTML = `<div class="grow"><b>${esc(t.name)}</b><div class="muted small">${t.status === 'in-progress' ? 'Searching' : 'Assigned'}${far ? ` · ${far}` : ''}</div></div>
    <a class="btn small" href="https://www.google.com/maps/dir/?api=1&destination=${lat.toFixed(6)},${lon.toFixed(6)}" target="_blank" rel="noopener">Navigate</a>`;
}

export function leaveMapPage(): void {
  document.body.classList.remove('map-full');
  unsub?.();
  unsub = undefined;
  if (watchId !== undefined) {
    navigator.geolocation.clearWatch(watchId);
    watchId = undefined;
  }
}

/** Blue dot from the browser only; never uploaded (OwnTracks does the tracking). */
function locateMe(): void {
  if (!navigator.geolocation) return toast('No location on this device', true);
  const m = map?.getMap();
  if (!m) return;
  const show = (pos: GeolocationPosition) => {
    const { latitude, longitude } = pos.coords;
    if (!meMarker) {
      meMarker = document.createElement('div');
      meMarker.className = 'me-dot';
    }
    // reuse a single marker via maplibre import on the map instance
    const mk = (m as any).__meMarker as import('maplibre-gl').Marker | undefined;
    if (mk) mk.setLngLat([longitude, latitude]);
    else {
      import('maplibre-gl').then((ml) => {
        (m as any).__meMarker = new ml.Marker({ element: meMarker! }).setLngLat([longitude, latitude]).addTo(m);
      });
    }
  };
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      show(pos);
      map!.flyTo(pos.coords.longitude, pos.coords.latitude, 15);
      if (watchId === undefined) watchId = navigator.geolocation.watchPosition(show, () => {}, { enableHighAccuracy: true, maximumAge: 10000 });
    },
    () => toast('Location permission denied', true),
    { enableHighAccuracy: true, timeout: 10000 },
  );
}
