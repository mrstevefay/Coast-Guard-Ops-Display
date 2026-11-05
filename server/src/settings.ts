import type { AppConfig } from './config.js';
import type { Db } from './db/index.js';

/**
 * Runtime settings edited from the console (Settings → Data feeds). Stored in the
 * `settings` table and layered on top of config.yaml + env at startup; a change
 * takes effect immediately by rebuilding the affected provider.
 *
 * Precedence: UI value > env var > config.yaml. Clearing a UI value falls back.
 */
export interface SettingField {
  key: string;
  label: string;
  help: string;
  /** Provider to rebuild when this changes (name in providers/index.ts). */
  provider: string;
  env?: string;
  secret?: boolean;
  kind?: 'text' | 'url';
}

export const SETTING_FIELDS: SettingField[] = [
  { key: 'providers.ais.apiKey', label: 'AIS — aisstream.io API key', help: 'Free key from aisstream.io. Vessels appear on the map within a minute.', provider: 'ais', env: 'AISSTREAM_API_KEY', secret: true },
  { key: 'providers.dublinBayBuoy.apiKey', label: 'Dublin Bay buoy — API key', help: 'Publishable key from dublinbaybuoy.com (Irish Lights MetOcean). Without it the sea state falls back to the SWAN model point.', provider: 'dublinBayBuoy', env: 'DUBLINBAY_API_KEY', secret: true },
  { key: 'providers.webcam.imageUrl', label: 'Webcam — still image URL', help: 'Any JPEG/PNG still (http or https). The TV reloads it every refresh interval.', provider: 'webcam', env: 'WEBCAM_IMAGE_URL', kind: 'url' },
  { key: 'providers.webcam.label', label: 'Webcam — label', help: 'Caption on the webcam panel.', provider: 'webcam' },
];

export interface SettingView {
  key: string;
  label: string;
  help: string;
  provider: string;
  env?: string;
  secret: boolean;
  kind: 'text' | 'url';
  /** Where the effective value comes from. */
  source: 'ui' | 'env' | 'config' | 'none';
  /** Effective value; secrets are masked to their last 4 characters. */
  value: string;
  isSet: boolean;
}

function getPath(obj: any, dotted: string): unknown {
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function setPath(obj: any, dotted: string, value: unknown): void {
  const parts = dotted.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    cur[parts[i]] ??= {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

export const mask = (v: string): string => (v.length <= 4 ? '••••' : `••••${v.slice(-4)}`);

export class Settings {
  /** Effective config as loaded from yaml + env, before UI overrides. */
  private readonly base: Record<string, string>;

  constructor(private readonly db: Db, private readonly cfg: AppConfig) {
    this.base = Object.fromEntries(SETTING_FIELDS.map((f) => [f.key, String(getPath(cfg, f.key) ?? '')]));
    this.applyAll();
  }

  /** Raw UI overrides from the table. */
  overrides(): Record<string, string> {
    const rows = this.db.all<{ key: string; value: string | null }>('SELECT key, value FROM settings');
    return Object.fromEntries(rows.filter((r) => r.value !== null).map((r) => [r.key, r.value as string]));
  }

  /** Layer stored values onto the live config object (mutates cfg in place). */
  applyAll(): void {
    const ov = this.overrides();
    for (const f of SETTING_FIELDS) setPath(this.cfg, f.key, ov[f.key] ?? this.base[f.key]);
  }

  field(key: string): SettingField | undefined {
    return SETTING_FIELDS.find((f) => f.key === key);
  }

  /** Validate and store one value; '' or null clears the override. Returns the provider to rebuild. */
  set(key: string, value: string | null): string {
    const f = this.field(key);
    if (!f) throw new Error(`unknown setting ${key}`);
    const v = (value ?? '').trim();
    if (v.length > 2000) throw new Error('value too long');
    if (/[\r\n]/.test(v)) throw new Error('value must be a single line');
    if (v && f.kind === 'url' && !/^https?:\/\/\S+$/i.test(v)) throw new Error('must be an http(s) URL');
    if (v) this.db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, v);
    else this.db.run('DELETE FROM settings WHERE key = ?', key);
    setPath(this.cfg, key, v || this.base[key]);
    return f.provider;
  }

  list(): SettingView[] {
    const ov = this.overrides();
    return SETTING_FIELDS.map((f) => {
      const ui = ov[f.key];
      const effective = ui ?? this.base[f.key];
      const source: SettingView['source'] = ui ? 'ui' : !effective ? 'none' : f.env && process.env[f.env] ? 'env' : 'config';
      return {
        key: f.key,
        label: f.label,
        help: f.help,
        provider: f.provider,
        env: f.env,
        secret: Boolean(f.secret),
        kind: f.kind ?? 'text',
        source,
        value: effective ? (f.secret ? mask(effective) : effective) : '',
        isSet: Boolean(effective),
      };
    });
  }
}
