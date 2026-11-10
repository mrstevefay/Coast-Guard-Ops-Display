import { OpsMap } from '../../map';
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
  // Tools sit inside the map, top left, clear of the zoom buttons and the attribution.
  root.innerHTML = `<div class="map-wrap"><div class="map-tools">
      <button class="btn small" data-action="me">◎ Me</button>
      <button class="btn small" data-action="fit">⤢ Fit</button>
      <button class="btn small on" data-action="coverage">Coverage</button>
    </div></div>`;
  root.querySelector('.map-wrap')!.prepend(mapEl);
  if (!map) {
    map = new OpsMap({ interactive: true, search: true, autoFit: false, staleSec: 120 });
    map.mount(mapEl, s);
  }
  map.resize();
  map.update(s, store.s.search);
  map.setTracks(store.s.tracks, store.s.search);
  unsub?.();
  unsub = store.subscribe(() => {
    if (!store.s.state) return;
    map!.update(store.s.state, store.s.search);
    map!.setTracks(store.s.tracks, store.s.search);
  });
  let coverageOn = true;
  wireActions(root, {
    fit: () => map!.fitAll(store.s.state!, store.s.search),
    coverage: (el) => {
      coverageOn = !coverageOn;
      map!.setLayerVisible('coverage-line', coverageOn);
      el.classList.toggle('on', coverageOn);
    },
    me: () => locateMe(),
  });
}

export function leaveMapPage(): void {
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
