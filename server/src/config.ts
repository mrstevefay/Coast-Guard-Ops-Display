import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import type { MapConfig, PanelToggles } from '../../shared/types.js';

export interface ProviderBase {
  enabled: boolean;
  pollIntervalMs: number;
}

export interface AppConfig {
  station: { name: string; shortName: string; lat: number; lon: number };
  server: { port: number; host: string; dataDir: string };
  callout: { token: string; autoStanddownMinutes: number };
  /** Phase 2: accounts. `open: true` = no auth at all (Pi LAN fallback mode). */
  auth: {
    open: boolean;
    sessionDays: number;
    /** Public origin, e.g. https://ops.example.ie — used for OwnTracks config and cookies. */
    publicUrl: string;
    /** First-run bootstrap only: creates the admin if no users exist. */
    adminEmail: string;
    adminPassword: string;
    adminName: string;
  };
  search: {
    enabled: boolean;
    maxAccuracyM: number;
    trackGapSec: number;
    defaultSearchWidthM: number;
    teamNames: string[];
    teamColours: string[];
    owntracksFriends: boolean;
    /** Seconds without a fix before a responder is shown as stale. */
    staleFixSec: number;
  };
  retention: {
    /** Days to keep positions after an incident closes; 0 = forever. */
    trackDays: number;
    lastFixHours: number;
    auditYears: number;
    backupKeep: number;
  };
  upstream: {
    /** wss://ops.example.ie — when set, this server mirrors the hosted one for the kiosk. */
    url: string;
    key: string;
    staleAfterSec: number;
  };
  panels: PanelToggles;
  map: MapConfig;
  providers: {
    metForecast: ProviderBase & { url: string; fallbackUrl?: string; hoursAhead: number };
    metObservations: ProviderBase & { url: string; stationName: string };
    metSeaArea: ProviderBase & { url: string; headland: string };
    metWarnings: ProviderBase & { rssUrl: string; localRegionCodes: string[]; localMarineCodes: string[]; marineHeadland?: string };
    tideGauge: ProviderBase & { erddap: string; dataset: string; stationId: string };
    tidePrediction: ProviderBase & {
      erddap: string; highLowDataset: string; curveDataset: string; stationId: string;
      springRangeM: number; neapRangeM: number;
    };
    waveModel: ProviderBase & { erddap: string; dataset: string; lat: number; lon: number; label: string };
    dublinBayBuoy: ProviderBase & { url: string; apiKey: string; label: string };
    weatherBuoy: ProviderBase & { erddap: string; dataset: string; stationId: string };
    sunMoon: ProviderBase;
    ais: ProviderBase & {
      apiKey: string; url: string;
      bbox: { south: number; west: number; north: number; east: number };
      vesselTtlMin: number;
    };
    webcam: ProviderBase & { imageUrl: string; label: string; refreshSec: number };
    muster: ProviderBase & { minimumCrew: number; requiredRoles: string[] };
  };
}

/**
 * Env overrides. Two forms:
 *  - Named shortcuts for the common ones (CALLOUT_TOKEN, AISSTREAM_API_KEY, ...).
 *  - Generic: CFG__providers__ais__pollIntervalMs=5000 (double underscore = path).
 */
const NAMED_ENV: Record<string, string> = {
  PORT: 'server.port',
  HOST: 'server.host',
  DATA_DIR: 'server.dataDir',
  CALLOUT_TOKEN: 'callout.token',
  CALLOUT_AUTO_STANDDOWN_MINUTES: 'callout.autoStanddownMinutes',
  AISSTREAM_API_KEY: 'providers.ais.apiKey',
  DUBLINBAY_API_KEY: 'providers.dublinBayBuoy.apiKey',
  PUBLIC_URL: 'auth.publicUrl',
  AUTH_OPEN: 'auth.open',
  ADMIN_EMAIL: 'auth.adminEmail',
  ADMIN_PASSWORD: 'auth.adminPassword',
  ADMIN_NAME: 'auth.adminName',
  UPSTREAM_URL: 'upstream.url',
  UPSTREAM_KEY: 'upstream.key',
  WEBCAM_IMAGE_URL: 'providers.webcam.imageUrl',
  STATION_NAME: 'station.name',
  STATION_LAT: 'station.lat',
  STATION_LON: 'station.lon',
  MAP_TILE_URL: 'map.tileUrl',
};

function setPath(obj: any, dotted: string, raw: string) {
  const parts = dotted.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    cur[parts[i]] ??= {};
    cur = cur[parts[i]];
  }
  const key = parts[parts.length - 1];
  const existing = cur[key];
  let v: unknown = raw;
  if (typeof existing === 'number') v = Number(raw);
  else if (typeof existing === 'boolean') v = raw === 'true' || raw === '1';
  else if (Array.isArray(existing)) v = raw.split(',').map((s) => s.trim()).filter(Boolean);
  else if (raw === 'true' || raw === 'false') v = raw === 'true';
  else if (raw !== '' && !Number.isNaN(Number(raw)) && !/^0\d/.test(raw) && existing === undefined) v = Number(raw);
  cur[key] = v;
}

export function loadConfig(file = process.env.CONFIG_FILE ?? 'config.yaml'): AppConfig {
  const abs = path.resolve(file);
  const text = fs.readFileSync(abs, 'utf8');
  const cfg = YAML.parse(text) as AppConfig;
  for (const [env, dotted] of Object.entries(NAMED_ENV)) {
    const v = process.env[env];
    if (v !== undefined && v !== '') setPath(cfg, dotted, v);
  }
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('CFG__') && v !== undefined) setPath(cfg, k.slice(5).split('__').join('.'), v);
  }
  return cfg;
}
