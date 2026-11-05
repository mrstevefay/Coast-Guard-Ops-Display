import type { DashboardState, Fix, Principal, SearchSnapshot, UserPublic, WsMessage } from '../../../shared/types';

export interface AppState {
  state?: DashboardState;
  search?: SearchSnapshot;
  me?: UserPublic;
  principal?: Principal;
  connected: boolean;
  /** Track history per user for the map (fixes received this session). */
  tracks: Map<number, Fix[]>;
}

type Listener = () => void;

/** Tiny observable store for the crew app. */
class Store {
  readonly s: AppState = { connected: false, tracks: new Map() };
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

  setState(state: DashboardState): void {
    this.s.state = state;
    this.notify();
  }

  setSearch(search: SearchSnapshot): void {
    this.s.search = search;
    for (const f of Object.values(search.latest)) this.pushFix(f);
    this.notify();
  }

  onMessage(m: WsMessage): void {
    if (m.type === 'search') this.setSearch(m.search);
    else if (m.type === 'pos') {
      if (this.s.search) for (const f of m.fixes) this.s.search.latest[f.userId] = { ...this.s.search.latest[f.userId], ...f };
      for (const f of m.fixes) this.pushFix(f);
      this.notify();
    } else if (m.type === 'auth' && m.ok && m.principal) {
      this.s.principal = m.principal;
    }
  }

  private pushFix(f: Fix): void {
    const arr = this.s.tracks.get(f.userId) ?? [];
    if (!arr.length || arr[arr.length - 1].tst < f.tst) {
      arr.push(f);
      if (arr.length > 2000) arr.splice(0, arr.length - 2000);
    }
    this.s.tracks.set(f.userId, arr);
  }

  setMe(me: UserPublic | undefined, principal?: Principal): void {
    this.s.me = me;
    this.s.principal = principal;
    this.notify();
  }

  setConnected(c: boolean): void {
    this.s.connected = c;
    this.notify();
  }

  get isManager(): boolean {
    return this.s.me?.role === 'manager' || this.s.me?.role === 'admin';
  }

  get isAdmin(): boolean {
    return this.s.me?.role === 'admin';
  }

  /** My response row and team for the open incident. */
  get mine() {
    const me = this.s.me;
    const search = this.s.search;
    if (!me || !search?.incident) return { response: undefined, team: undefined, member: undefined };
    const response = search.responders.find((r) => r.userId === me.id);
    const team = search.teams.find((t) => t.members.some((m) => m.userId === me.id));
    const member = team?.members.find((m) => m.userId === me.id);
    return { response, team, member };
  }
}

export const store = new Store();
