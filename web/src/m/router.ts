export type Route = 'status' | 'conditions' | 'weather' | 'tide' | 'saf' | 'map' | 'team' | 'more' | 'profile' | 'admin' | 'privacy' | 'password' | 'login' | 'device';

export interface RouteMatch {
  route: Route;
  param?: string;
}

const ROUTES: Record<string, Route> = {
  '': 'status',
  status: 'status',
  conditions: 'conditions',
  weather: 'weather',
  tide: 'tide',
  saf: 'saf',
  map: 'map',
  team: 'team',
  more: 'more',
  profile: 'profile',
  admin: 'admin',
  privacy: 'privacy',
  password: 'password',
  login: 'login',
  device: 'device',
};

export function currentRoute(): RouteMatch {
  const hash = location.hash.replace(/^#\/?/, '');
  const [seg, param] = hash.split('/');
  return { route: ROUTES[seg] ?? 'status', param: param ? decodeURIComponent(param) : undefined };
}

export function navigate(route: Route, param?: string): void {
  const target = `#/${route}${param !== undefined ? `/${encodeURIComponent(param)}` : ''}`;
  if (location.hash === target) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else location.hash = target;
}

export function onRoute(fn: (m: RouteMatch) => void): void {
  window.addEventListener('hashchange', () => fn(currentRoute()));
}
