/**
 * DashboardState — the single typed document the server owns and the
 * frontend renders. Everything the TV shows is derived from this.
 *
 * All times are ISO-8601 strings in UTC. The frontend formats them for
 * Europe/Dublin. All speeds are knots, heights/distances metres, temps °C.
 */

export type DisplayMode = 'standby' | 'callout';

export interface StationInfo {
  name: string;
  shortName: string;
  lat: number;
  lon: number;
}

export interface Incident {
  id: string;
  /** Pager / callout text, verbatim. */
  text: string;
  receivedAt: string;
  lat?: number;
  lon?: number;
  /** Who/what triggered it: 'api' | 'whatsapp' | 'manual' | ... (Phase 2). */
  source: string;
  /** When auto stand-down will fire, if enabled. */
  autoStanddownAt?: string;
}

export interface ModeState {
  mode: DisplayMode;
  incident?: Incident;
  /** Last incident, kept after stand-down for the muster/debrief. */
  lastIncident?: Incident;
  changedAt: string;
}

// ---------------------------------------------------------------- weather

export interface WindReading {
  speedKt: number;
  gustKt?: number;
  dirDeg: number;
  dirName: string; // N, NNE, ...
  beaufort: number;
}

export interface HourForecast {
  /** Start of the hour (UTC ISO). */
  time: string;
  wind: WindReading;
  tempC: number;
  precipMm: number;
  precipProbPct?: number;
  symbol: string; // Met Éireann / met.no symbol id, e.g. "LightRain"
  pressureHpa?: number;
  humidityPct?: number;
  /** Estimated visibility band derived from symbol + humidity; see README. */
  visibility: VisibilityEstimate;
}

export type VisibilityBand = 'good' | 'moderate' | 'poor' | 'very-poor' | 'fog';

export interface VisibilityEstimate {
  band: VisibilityBand;
  /** Approximate lower/upper bound in nautical miles, for display. */
  label: string; // e.g. ">5 NM", "2–5 NM", "<1 NM"
  estimated: true;
}

export interface ObservedWeather {
  stationName: string; // e.g. "Dublin Airport"
  time: string;
  wind: WindReading;
  tempC?: number;
  pressureHpa?: number;
  humidityPct?: number;
  rainfallMm?: number;
  description?: string;
}

export interface WeatherState {
  /** Forecast valid for the current hour. */
  now: HourForecast;
  /** Next hours after `now`, hourly. */
  hourly: HourForecast[];
  modelRun?: string;
}

// --------------------------------------------------------------- warnings

export type WarningLevel = 'yellow' | 'orange' | 'red' | 'advisory';

export interface WeatherWarning {
  id: string;
  level: WarningLevel;
  /** "Gale", "Small Craft", "Wind", "Rain", ... */
  type: string;
  headline: string;
  description: string;
  marine: boolean;
  onset: string;
  expires: string;
  issued: string;
  areas: string[];
  regionCodes: string[];
  /** True if the warning covers the configured station regions. */
  local: boolean;
}

export interface WarningsState {
  active: WeatherWarning[];
  fetchedAt: string;
}

// ------------------------------------------------------------------- tide

export type TideEventKind = 'HW' | 'LW';

export interface TideEvent {
  kind: TideEventKind;
  time: string;
  /** Height above Chart Datum (LAT), metres. */
  heightM: number;
}

export interface TideCurvePoint {
  time: string;
  heightM: number;
}

export type SpringNeap = 'springs' | 'neaps' | 'mid';

export interface TideState {
  stationId: string;
  /** Predicted height now (LAT), metres. */
  predictedNowM?: number;
  /** Observed water level from the tide gauge (LAT), metres. */
  observedM?: number;
  observedAt?: string;
  /** observed − predicted at the same instant, metres (positive = surge). */
  surgeM?: number;
  rising?: boolean;
  next?: TideEvent;
  following?: TideEvent;
  previous?: TideEvent;
  events: TideEvent[];
  /** ±6 h around now, ~15-min spacing, LAT. */
  curve: TideCurvePoint[];
  rangeM?: number;
  springNeap?: SpringNeap;
  /** Offset to add to OD Malin values to get LAT at this station. */
  odMalinToLatM?: number;
}

// -------------------------------------------------------------------- sea

export interface SeaStateReading {
  source: string; // "SWAN model (Howth approaches)" | "M2 buoy"
  isModel: boolean;
  time: string;
  lat: number;
  lon: number;
  hsM?: number;
  periodS?: number;
  dirDeg?: number;
  seaTempC?: number;
  hmaxM?: number;
  wind?: WindReading;
  pressureHpa?: number;
  airTempC?: number;
  /** Source reports gale conditions (Dublin Bay buoy flag). */
  gale?: boolean;
}

export interface SeaState {
  /** Local observation: Dublin Bay buoy (Irish Lights MetOcean). */
  local?: SeaStateReading;
  /** Local model fallback: SWAN wave model point off Howth. */
  model?: SeaStateReading;
  /** Offshore observation (M2 weather buoy). */
  offshore?: SeaStateReading;
}

// -------------------------------------------------------- sea area forecast

export interface SeaAreaSection {
  /** e.g. "Forecast for all Irish coastal waters and for the Irish Sea" or "... from Carlingford Lough to Howth Head to Wicklow Head" */
  title: string;
  wind: string;
  weather: string;
  visibility: string;
  seaState?: string;
  forceMin?: number;
  forceMax?: number;
  /** Compass summary of the leading direction words, e.g. "NE–E". */
  direction?: string;
  visibilityBand: VisibilityBand;
}

export interface SeaAreaForecast {
  issuedAt: string;
  validFrom?: string;
  validTo?: string;
  smallCraft?: string;
  galeWarning?: string;
  situation?: string;
  /** The section covering the station's stretch of coast. */
  area: SeaAreaSection;
  sections: SeaAreaSection[];
  outlook?: string;
}

// -------------------------------------------------------------------- sun

export interface SunMoonState {
  date: string;
  sunrise: string;
  sunset: string;
  civilDawn: string;
  civilDusk: string;
  nauticalDusk: string;
  isDaylight: boolean;
  /** Minutes of usable daylight remaining (to civil dusk), 0 if dark. */
  daylightRemainingMin: number;
  /** Minutes until sunrise if currently dark. */
  untilSunriseMin?: number;
  nextSunrise: string;
  moonPhase: number; // 0..1
  moonPhaseName: string;
  moonIlluminationPct: number;
}

// -------------------------------------------------------------------- AIS

export interface AisVessel {
  mmsi: number;
  name?: string;
  lat: number;
  lon: number;
  sogKt?: number;
  cogDeg?: number;
  headingDeg?: number;
  shipType?: number;
  lastSeen: string;
}

export interface AisState {
  vessels: AisVessel[];
  count: number;
  connected: boolean;
  bbox: { south: number; west: number; north: number; east: number };
  updatedAt?: string;
}

// ----------------------------------------------------------------- webcam

export interface WebcamState {
  configured: boolean;
  label?: string;
  /** Still-image URL; frontend appends a cache-buster. */
  imageUrl?: string;
  refreshSec: number;
}

// ----------------------------------------------------------------- muster
// Phase 2/3 fill these. Phase 1 renders the placeholder.

export type ResponderStatus = 'responding' | 'available' | 'unavailable' | 'on-scene' | 'unknown';

export interface Responder {
  id: string;
  name: string;
  status: ResponderStatus;
  etaMin?: number;
  roles: string[];
  updatedAt: string;
  source: string; // 'whatsapp' | 'd4h' | ...
}

export interface MusterState {
  responders: Responder[];
  /** role -> responder ids filling it */
  roles: Record<string, string[]>;
  minimumCrew: number;
  /** Role names the station needs covered for a launch. */
  requiredRoles: string[];
  source: 'stub' | 'app' | 'whatsapp' | 'd4h' | 'mixed';
  updatedAt?: string;
}

// ------------------------------------------------------------ accounts (Phase 2)

export type Role = 'admin' | 'manager' | 'member';
/** What a WebSocket / request is allowed to see. */
export type Principal = { kind: 'user'; userId: number; role: Role; name: string } | { kind: 'display'; label: string } | { kind: 'open' };

export interface UserPublic {
  id: number;
  email: string;
  name: string;
  callsign?: string;
  role: Role;
  active: boolean;
  mustChangePassword: boolean;
  privacyAcceptedAt?: string;
  lastLoginAt?: string;
  deviceCount?: number;
}

export interface DevicePublic {
  id: number;
  userId: number;
  name: string;
  username: string;
  tid: string;
  createdAt: string;
  lastSeenAt?: string;
  revokedAt?: string;
}

// ------------------------------------------------------------- tracking (Phase 2)

/** One position fix from a crew phone (OwnTracks). Speeds in knots, altitude metres (GPS). */
export interface Fix {
  userId: number;
  deviceId: number;
  name: string;
  callsign?: string;
  teamId?: number;
  incidentId?: string;
  lat: number;
  lon: number;
  alt?: number;
  acc?: number;
  sogKt?: number;
  cogDeg?: number;
  batt?: number;
  /** Fix time (unix seconds, from the phone). */
  tst: number;
  /** When the server received it (ISO). */
  at: string;
}

// --------------------------------------------------------- search (Phase 2)

export type ResponseStatus = 'responding' | 'on-scene' | 'available' | 'unavailable' | 'stood-down';
export type TeamStatus = 'forming' | 'tasked' | 'searching' | 'returned' | 'stood-down';
export type TargetKind = 'point' | 'area' | 'line';
export type TargetStatus = 'planned' | 'assigned' | 'in-progress' | 'done' | 'cancelled';

/** 'callout' = pager job, display goes to callout mode; 'tasking' = search opened from the console, display stays in standby. */
export type IncidentKind = 'callout' | 'tasking';

/** Search planning point (IPP / LKP): where the search is planned from. */
export interface PlanningPoint {
  lat: number;
  lon: number;
  label?: string;
  setAt: string;
}

/**
 * Typed locations on an incident. `lkp` (last known position) is the planning point the rings
 * and terrain areas are drawn from; `pls` (place last seen) stands in when there is no LKP.
 * `home` and `significant` are personal to the subject and never sent to display keys.
 */
export type PlanningPointKind = 'lkp' | 'pls' | 'home' | 'vehicle' | 'significant' | 'other';
export const PLANNING_POINT_KINDS: PlanningPointKind[] = ['lkp', 'pls', 'significant', 'home', 'vehicle', 'other'];
export const PRIVATE_POINT_KINDS: PlanningPointKind[] = ['home', 'significant'];
export const POINT_KIND_LABEL: Record<PlanningPointKind, string> = { lkp: 'Last known position', pls: 'Place last seen', home: 'Home', vehicle: 'Vehicle', significant: 'Significant place', other: 'Other' };
export const POINT_KIND_SHORT: Record<PlanningPointKind, string> = { lkp: 'LKP', pls: 'PLS', home: 'HOME', vehicle: 'VEH', significant: '★', other: 'PT' };

export interface PlanningPointRow {
  id: number;
  incidentId: string;
  kind: PlanningPointKind;
  label?: string;
  lat: number;
  lon: number;
  note?: string;
  setAt: string;
}

export interface SearchIncident {
  id: string;
  kind: IncidentKind;
  text: string;
  receivedAt: string;
  lat?: number;
  lon?: number;
  source?: string;
  startedAt: string;
  endedAt?: string;
  endReason?: string;
  /** The planning point the search is drawn from: the LKP, else the place last seen. */
  ipp?: PlanningPoint;
  /** All typed points. Display keys receive only the non-personal kinds (see PRIVATE_POINT_KINDS). */
  points?: PlanningPointRow[];
  /** Bumps when the subject record changes, so phones refetch it. Details are never in the snapshot. */
  subjectUpdatedAt?: string;
}

/** Who is being searched for. Visible to logged-in crew only; never sent to display keys. */
export interface IncidentSubject {
  incidentId: string;
  name?: string;
  sex?: string;
  age?: number;
  /** Clothing / physical description. */
  clothing?: string;
  description?: string;
  /** Significant locations: home, car, favourite spots, where last seen. */
  locations?: string;
  /** Relevant history: previous incidents, medical, habits. */
  history?: string;
  despondent: boolean;
  mentalHealth: boolean;
  selfHarmHistory: boolean;
  /** Previous means of self-harm, if selfHarmHistory. */
  selfHarmMeans?: string;
  /** Despondent characteristics (UKMPBS 2011): an explicit suicide threat was made. */
  suicideThreatened: boolean;
  /** Depression diagnosed or suspected. */
  depression: boolean;
  /** A place significant to them is known (beauty spot, memories, regular walk): see `locations`. */
  significantPlaceKnown: boolean;
  /** Lost person behaviour category: a MISPER-UK profile slug (e.g. "dementia"), see shared/lpb. */
  category?: string;
  /** Terrain the subject went missing in (MISPER-UK terrain name), narrows the where-found statistics. */
  terrain?: string;
  hasPhoto: boolean;
  photoUpdatedAt?: string;
  updatedAt?: string;
}

export interface ResponderRow {
  userId: number;
  name: string;
  callsign?: string;
  status: ResponseStatus;
  etaMin?: number;
  note?: string;
  updatedAt: string;
  teamId?: number;
  /** Callsign within the team, e.g. "Alpha-1" (set when in a team). */
  teamCallsign?: string;
}

export interface TeamMember {
  userId: number;
  name: string;
  /** Alpha-0 is the leader. */
  callsign: string;
  position: number;
}

export interface Team {
  id: number;
  incidentId: string;
  name: string;
  colour: string;
  searchWidthM: number;
  status: TeamStatus;
  leaderUserId?: number;
  members: TeamMember[];
  createdAt: string;
}

export type TargetGeometry =
  | { type: 'Point'; coordinates: [number, number] }
  | { type: 'LineString'; coordinates: [number, number][] }
  | { type: 'Polygon'; coordinates: [number, number][][] };

export interface Target {
  id: number;
  incidentId: string;
  teamId?: number;
  name: string;
  kind: TargetKind;
  geometry: TargetGeometry;
  notes?: string;
  status: TargetStatus;
  priority: number;
  createdAt: string;
  completedAt?: string;
}

// ----------------------------------------------------------- history / replay / report

/** One row in the console's History list. */
export interface IncidentSummary {
  id: string;
  kind: IncidentKind;
  text: string;
  startedAt: string;
  endedAt?: string;
  endReason?: string;
  responders: number;
  teams: number;
  targets: number;
  fixes: number;
}

/** Weather, sea and tide as they were when an incident opened / closed. */
export interface ConditionsSnapshot {
  phase: 'start' | 'end';
  at: string;
  wind?: { speedKt: number; gustKt?: number; dirName: string; beaufort: number };
  observed?: { stationName: string; time: string; speedKt: number; gustKt?: number; dirName: string; tempC?: number; pressureHpa?: number };
  visibility?: string;
  precipMm?: number;
  tempC?: number;
  pressureHpa?: number;
  symbol?: string;
  sea?: { source: string; hsM?: number; periodS?: number; seaTempC?: number; gale?: boolean };
  tide?: { heightM?: number; rising?: boolean; next?: { kind: string; time: string; heightM: number }; springNeap?: string };
  sun?: { sunrise: string; sunset: string; civilDusk: string; isDaylight: boolean; daylightRemainingMin: number };
  warnings: string[];
}

export interface ReplayFix { u: number; t: number; lat: number; lon: number; team: number | null }
export interface ReplayEvent { at: string; kind: string; text: string }
export interface TeamMembership { userId: number; name: string; callsign: string; joinedAt: string; leftAt?: string }

/** Everything the console needs to replay a past (or current) incident. */
export interface IncidentReplay {
  incident: SearchIncident;
  teams: (Team & { memberships: TeamMembership[] })[];
  targets: Target[];
  responders: ResponderRow[];
  users: Record<number, { name: string; callsign?: string }>;
  fixes: ReplayFix[];
  events: ReplayEvent[];
  conditions: ConditionsSnapshot[];
}

/** Everything the console / phones / TV need about the current search. */
export interface SearchSnapshot {
  incident?: SearchIncident;
  responders: ResponderRow[];
  teams: Team[];
  targets: Target[];
  /** Latest fix per user id. */
  latest: Record<number, Fix>;
  updatedAt: string;
}

// ----------------------------------------------------------------- health

export type ProviderStatus = 'ok' | 'stale' | 'error' | 'disabled' | 'stub' | 'starting';

export interface ProviderHealth {
  name: string;
  status: ProviderStatus;
  lastAttempt?: string;
  lastSuccess?: string;
  lastError?: string;
  consecutiveFailures: number;
  nextPollAt?: string;
  pollIntervalMs: number;
  /** Human note, e.g. "no API key". */
  note?: string;
}

// ---------------------------------------------------------------- panels

export interface PanelToggles {
  wind: boolean;
  tide: boolean;
  sea: boolean;
  sun: boolean;
  ais: boolean;
  webcam: boolean;
  muster: boolean;
  /** Met Éireann Sea Area Forecast panel (takes the muster slot when muster is off). */
  seaArea: boolean;
  map: boolean;
  warnings: boolean;
}

export interface MapConfig {
  tileUrl: string;
  seamarkTileUrl?: string;
  /** Optional topographic raster layer (console toggle), e.g. OpenTopoMap. */
  topoTileUrl?: string;
  topoAttribution?: string;
  attribution: string;
  /** 0..1 cap on base-map brightness, to keep a light tile set dark-theme friendly. */
  baseBrightness?: number;
  standbyZoom: number;
  calloutZoom: number;
  ringsKm: number[];
}

// ------------------------------------------------------------------ state

/** The data half of the state — what providers may return slices of. */
export interface DashboardData {
  weather?: WeatherState;
  /** Nearest synoptic observation (Dublin Airport), own slice so providers stay independent. */
  observed?: ObservedWeather;
  warnings?: WarningsState;
  tide?: TideState;
  sea?: SeaState;
  seaArea?: SeaAreaForecast;
  sun?: SunMoonState;
  ais?: AisState;
  webcam?: WebcamState;
  muster?: MusterState;
}

export interface DashboardState extends DashboardData {
  generatedAt: string;
  station: StationInfo;
  mode: ModeState;
  providers: Record<string, ProviderHealth>;
  panels: PanelToggles;
  map: MapConfig;
  /** Server build/version, so the kiosk can reload on upgrade. */
  version: string;
  /** Pi mirror: 'live' = showing the hosted server's state, 'fallback' = local data. */
  upstream?: 'live' | 'fallback';
}

// ------------------------------------------------------------ websocket

export type WsMessage =
  | { type: 'state'; state: DashboardState }
  | { type: 'ping'; t: number }
  | { type: 'auth'; ok: boolean; principal?: Principal }
  /** Position deltas, batched ~1 s. Authenticated sockets only. */
  | { type: 'pos'; fixes: Fix[] }
  /** Full search snapshot on connect and on every change (throttled). */
  | { type: 'search'; search: SearchSnapshot };
