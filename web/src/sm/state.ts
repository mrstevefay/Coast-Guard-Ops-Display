import type { DashboardState, Fix, IncidentSubject, PlanningPointKind, Principal, SearchAreaResult, SearchSnapshot, UserPublic, WsMessage } from '../../../shared/types';

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
  tab: 'responders' | 'teams' | 'targets' | 'subject' | 'behaviour';
  layers: { tracks: boolean; coverage: boolean; targets: boolean; terrain: boolean; heat: boolean; behaviour: boolean; ais: boolean; labels: boolean; topo: boolean; follow: boolean };
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
    tab: 'responders',
    layers: { tracks: true, coverage: true, targets: true, terrain: true, heat: true, behaviour: true, ais: false, labels: true, topo: false, follow: false },
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
