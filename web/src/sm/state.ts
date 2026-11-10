import type { DashboardState, Fix, IncidentSubject, PlanningPointKind, Principal, SearchAreaResult, SearchSnapshot, UserPublic, WsMessage } from '../../../shared/types';

export type LayerPreset = 'plan' | 'teams' | 'clean';
type Layers = ConsoleState['layers'];
/** Layer sets for each stage of the search: what the manager needs to see, and nothing else. */
export const LAYER_PRESETS: Record<LayerPreset, Omit<Layers, 'ais' | 'topo' | 'follow'>> = {
  plan: { behaviour: true, terrain: true, areaFill: true, segments: true, heat: true, targets: true, tracks: false, coverage: false, labels: true },
  teams: { behaviour: false, terrain: true, areaFill: false, segments: false, heat: false, targets: true, tracks: true, coverage: true, labels: true },
  clean: { behaviour: false, terrain: false, areaFill: false, segments: false, heat: false, targets: true, tracks: false, coverage: false, labels: true },
};
export const LAYER_LABEL: Record<keyof Layers, string> = { behaviour: 'Rings', terrain: 'Terrain area', areaFill: 'Area shading', segments: 'Segments', heat: 'Heat', targets: 'Targets', tracks: 'Tracks', coverage: 'Coverage', labels: 'Labels', ais: 'AIS', topo: 'Topo', follow: 'Follow' };

export interface ConsoleState {
  state?: DashboardState;
  search?: SearchSnapshot;
  me?: UserPublic;
  principal?: Principal;
  connected: boolean;
  tracks: Map<number, Fix[]>;
  loadedIncidentId?: string;
  fixTimes: number[];
  selected: Set<number>;
  /** The three stages of a search: who and where, the plan, the teams and their targets. */
  tab: 'subject' | 'behaviour' | 'teams';
  layers: { behaviour: boolean; terrain: boolean; areaFill: boolean; segments: boolean; heat: boolean; targets: boolean; tracks: boolean; coverage: boolean; labels: boolean; ais: boolean; topo: boolean; follow: boolean };
  /** Which layer preset is showing; undefined once the manager changes a single layer. */
  preset?: LayerPreset;
  /** Terrain-shaped search area for the current point + subject (fetched when either changes). */
  searchArea?: { key: string; loading: boolean; area?: SearchAreaResult; error?: string; status?: number };
  /** Subject record for the open incident (fetched when `subjectUpdatedAt` changes); null = none recorded. */
  subject?: IncidentSubject | null;
  subjectKey?: string;
  /** Next map click places this kind of point (or moves `pointId`). */
  picking?: { kind: PlanningPointKind; pointId?: number };
  editingTargetId?: number;
  /** 'ops' = map + sidebar; 'settings' = administration pages (#settings/<section>); 'history' = past incidents (#history/<id>). */
  view: 'ops' | 'settings' | 'history';
  historyId?: string;
  section: 'users' | 'displays' | 'feeds' | 'backups' | 'terrain' | 'audit' | 'system' | 'account';
}

type Listener = () => void;

class ConsoleStore {
  readonly s: ConsoleState = {
    connected: false,
    tracks: new Map(),
    fixTimes: [],
    selected: new Set(),
    tab: 'subject',
    layers: { behaviour: true, terrain: true, areaFill: true, segments: true, heat: true, targets: true, tracks: true, coverage: true, labels: true, ais: false, topo: false, follow: false },
    preset: 'plan',
    view: 'ops',
    section: 'users',
  };
  private listeners = new Set<Listener>();
  private scheduled = false;

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  notify(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    requestAnimationFrame(() => {
      this.scheduled = false;
      for (const l of this.listeners) l();
    });
  }
  onMessage(m: WsMessage): void {
    if (m.type === 'state') this.s.state = m.state;
    else if (m.type === 'search') {
      const prevId = this.s.search?.incident?.id;
      this.s.search = m.search;
      if (m.search.incident?.id !== prevId) {
        this.s.tracks = new Map();
        this.s.subject = undefined;
        this.s.subjectKey = undefined;
        this.s.selected.clear();
        this.s.editingTargetId = undefined;
      }
      for (const f of Object.values(m.search.latest)) this.pushFix(f, false);
    } else if (m.type === 'pos') {
      const t = Date.now();
      for (const f of m.fixes) {
        if (this.s.search) this.s.search.latest[f.userId] = { ...this.s.search.latest[f.userId], ...f };
        this.pushFix(f, true);
        this.s.fixTimes.push(t);
      }
      this.s.fixTimes = this.s.fixTimes.filter((x) => t - x < 60_000);
    }
    this.notify();
  }
  pushFix(f: Fix, fromDelta: boolean): void {
    const arr = this.s.tracks.get(f.userId) ?? [];
    if (!arr.length || arr[arr.length - 1].tst < f.tst) {
      // Snapshot "latest" entries may predate the loaded history; only append newer.
      if (fromDelta || !arr.length) arr.push(f);
      else if (arr[arr.length - 1].tst < f.tst) arr.push(f);
    }
    this.s.tracks.set(f.userId, arr);
  }
  get isManager(): boolean {
    return this.s.me?.role === 'manager' || this.s.me?.role === 'admin';
  }
  get isAdmin(): boolean {
    return this.s.me?.role === 'admin';
  }
}

export const cs = new ConsoleStore();
