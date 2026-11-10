import { parseLocation } from '../../../shared/location';
import { get } from '../api';
import { esc } from '../format';

export interface LocationPick {
  lat: number;
  lon: number;
  /** A place name when the pick came from the place index. */
  label?: string;
}

interface PlaceHit { name: string; kind: string; lat: number; lon: number }

const km = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => {
  const d = Math.hypot((a.lat - b.lat) * 111.32, (a.lon - b.lon) * 111.32 * Math.cos((a.lat * Math.PI) / 180));
  return d < 1 ? `${Math.round(d * 1000)} m` : `${d.toFixed(1)} km`;
};

/**
 * Turn an input into "search a place or paste a position": a typed position (decimal, degrees
 * and minutes, ITM, Irish Grid) is read on the spot; anything else searches the station's place
 * index. Arrow keys move, Enter takes the highlighted line, Escape clears. The input's parent
 * must be position: relative (the list hangs under it).
 */
export function attachLocationSearch(input: HTMLInputElement, opts: { near: () => { lat: number; lon: number } | undefined; onPick: (p: LocationPick) => void }): void {
  const list = document.createElement('div');
  list.className = 'loc-list';
  list.hidden = true;
  input.after(list);
  input.setAttribute('autocomplete', 'off');
  let items: (LocationPick & { html: string })[] = [];
  let active = 0;
  let seq = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const draw = () => {
    list.hidden = !items.length && !input.value.trim();
    list.innerHTML = items.length
      ? items.map((it, i) => `<button type="button" class="loc-item ${i === active ? 'on' : ''}" data-i="${i}">${it.html}</button>`).join('')
      : input.value.trim().length >= 2 ? '<div class="loc-none">No match. Try a place name, coordinates, ITM or an Irish Grid reference.</div>' : '';
    if (!list.innerHTML) list.hidden = true;
    list.querySelectorAll<HTMLButtonElement>('[data-i]').forEach((b) => b.addEventListener('mousedown', (ev) => { ev.preventDefault(); pick(Number(b.dataset.i)); }));
  };
  const pick = (i: number) => {
    const it = items[i];
    if (!it) return;
    items = [];
    input.value = '';
    draw();
    opts.onPick({ lat: it.lat, lon: it.lon, label: it.label });
  };
  const update = () => {
    const q = input.value.trim();
    const my = ++seq;
    active = 0;
    const pos = parseLocation(q);
    if (pos) {
      items = [{ lat: pos.lat, lon: pos.lon, html: `<b>Position</b> ${esc(pos.read)}${pos.kind !== 'latlon' ? ` <span class="muted">${pos.lat.toFixed(5)}, ${pos.lon.toFixed(5)}</span>` : ''}` }];
      return draw();
    }
    if (q.length < 2) { items = []; return draw(); }
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const near = opts.near();
      try {
        const r = await get<{ places: PlaceHit[]; indexed: boolean }>(`/api/places?q=${encodeURIComponent(q)}${near ? `&lat=${near.lat}&lon=${near.lon}` : ''}`);
        if (my !== seq) return;
        items = r.places.map((p) => ({ lat: p.lat, lon: p.lon, label: p.name, html: `<b>${esc(p.name)}</b> <span class="muted">${esc(p.kind)}${near ? ` · ${km(near, p)}` : ''}</span>` }));
        if (!r.indexed && !items.length) {
          list.hidden = false;
          list.innerHTML = '<div class="loc-none">Place names come with the terrain data: rebuild it in Settings → Terrain. Coordinates work now.</div>';
          return;
        }
      } catch {
        items = [];
      }
      draw();
    }, 220);
  };
  input.addEventListener('input', update);
  input.addEventListener('focus', () => { if (input.value.trim()) update(); });
  input.addEventListener('blur', () => setTimeout(() => { list.hidden = true; }, 150));
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowDown' && items.length) { ev.preventDefault(); active = (active + 1) % items.length; draw(); }
    else if (ev.key === 'ArrowUp' && items.length) { ev.preventDefault(); active = (active - 1 + items.length) % items.length; draw(); }
    else if (ev.key === 'Enter') { ev.preventDefault(); pick(active); }
    else if (ev.key === 'Escape') { input.value = ''; items = []; draw(); input.blur(); }
  });
}
