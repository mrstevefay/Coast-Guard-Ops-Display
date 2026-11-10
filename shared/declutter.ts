/**
 * Map label placement: labels are placed most important first; each tries a few spots around its
 * point (below, above, right, left) and takes the first that overlaps neither a label already
 * placed nor another point's dot. A label with no free spot is hidden, unless it must always show
 * (the last known position, the station), when it keeps its usual spot.
 *
 * Screen pixels throughout. `anchor` is how the marker is pinned to its point, as in MapLibre:
 * 'top' (label hangs below the point; can move), 'center' or 'left' (fixed spot).
 */

export interface LabelIn {
  x: number; y: number; // the point on screen
  w: number; h: number; // the label's size
  anchor: 'top' | 'center' | 'left';
  offset: [number, number]; // the usual offset from the point
  prio: number; // lower places first
  keep?: boolean; // always show, at the usual spot if nothing is free
}
export interface Dot { x: number; y: number; r: number; owner?: number }
export type Placement = { offset: [number, number] } | null;

type Box = [number, number, number, number]; // x0, y0, x1, y1
const PAD = 2;

function boxOf(l: LabelIn, o: [number, number]): Box {
  const x = l.x + o[0], y = l.y + o[1];
  if (l.anchor === 'center') return [x - l.w / 2, y - l.h / 2, x + l.w / 2, y + l.h / 2];
  if (l.anchor === 'left') return [x, y - l.h / 2, x + l.w, y + l.h / 2];
  return [x - l.w / 2, y, x + l.w / 2, y + l.h];
}
const hits = (a: Box, b: Box) => a[0] < b[2] + PAD && b[0] < a[2] + PAD && a[1] < b[3] + PAD && b[1] < a[3] + PAD;
const hitsDot = (a: Box, d: Dot) => {
  const cx = Math.max(a[0], Math.min(d.x, a[2])), cy = Math.max(a[1], Math.min(d.y, a[3]));
  return (cx - d.x) ** 2 + (cy - d.y) ** 2 < d.r * d.r;
};

/** Spots to try, best first. Only 'top'-anchored labels move. */
function candidates(l: LabelIn): [number, number][] {
  const [ox, oy] = l.offset;
  if (l.anchor !== 'top') return [[ox, oy]];
  const gap = Math.max(6, oy);
  return [[ox, oy], [ox, -gap - l.h], [l.w / 2 + gap, -l.h / 2], [-l.w / 2 - gap, -l.h / 2]];
}

/** `view` is the map's size: a spot that stays on screen is preferred over one cut off at the edge. */
export function declutter(labels: LabelIn[], dots: Dot[] = [], view?: { w: number; h: number }): Placement[] {
  const onScreen = (b: Box) => !view || (b[0] >= 0 && b[1] >= 0 && b[2] <= view.w && b[3] <= view.h);
  const order = labels.map((_, i) => i).sort((a, b) => labels[a].prio - labels[b].prio || a - b);
  const placed: Box[] = [];
  const out: Placement[] = labels.map(() => null);
  for (const i of order) {
    const l = labels[i];
    // each spot, and for a point on screen the same spot slid sideways to stay inside the map
    const slid = (o: [number, number]): [number, number][] => {
      if (!view || l.anchor !== 'top' || l.x < 0 || l.x > view.w || l.y < 0 || l.y > view.h) return [o];
      const b = boxOf(l, o), dx = Math.max(0, -b[0]) - Math.max(0, b[2] - view.w);
      return dx ? [o, [o[0] + dx, o[1]]] : [o];
    };
    const spots = candidates(l).flatMap(slid).filter((o) => {
      const b = boxOf(l, o);
      return !placed.some((p) => hits(b, p)) && !dots.some((d) => d.owner !== i && hitsDot(b, d));
    });
    const free = spots.find((o) => onScreen(boxOf(l, o))) ?? spots[0];
    const o = free ?? (l.keep ? l.offset : undefined);
    if (!o) continue;
    placed.push(boxOf(l, o));
    out[i] = { offset: o };
  }
  return out;
}

/**
 * Labels of one group (a team) whose usual spots would overlap, joined into clusters: a cluster is
 * every label linked to another by an overlap, so three crew walking a line in step form one.
 * Returns the clusters of two or more, as indexes into `labels`.
 */
export function groupOverlapping(labels: (LabelIn & { group?: string })[]): number[][] {
  const parent = labels.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const boxes = labels.map((l) => boxOf(l, l.offset));
  for (let i = 0; i < labels.length; i++) {
    if (labels[i].group === undefined) continue;
    for (let j = i + 1; j < labels.length; j++) {
      if (labels[j].group === labels[i].group && hits(boxes[i], boxes[j])) parent[find(j)] = find(i);
    }
  }
  const byRoot = new Map<number, number[]>();
  labels.forEach((l, i) => { if (l.group !== undefined) byRoot.set(find(i), [...(byRoot.get(find(i)) ?? []), i]); });
  return [...byRoot.values()].filter((c) => c.length > 1);
}
