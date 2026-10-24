import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Incident, ModeState } from '../../shared/types.js';
import type { AppConfig } from './config.js';
import type { StateStore } from './state.js';

export interface CalloutRequest {
  text: string;
  lat?: number;
  lon?: number;
  receivedAt?: string;
  source?: string;
}

/**
 * Display mode state machine: standby <-> callout, with auto stand-down and
 * on-disk persistence so a container restart mid-incident does not lose it.
 *
 * Phase 2 (WhatsApp) and Phase 3 (D4H) call `callout()` / `standdown()`,
 * either in-process or via the token-protected HTTP endpoints.
 */
export class CalloutManager {
  private timer?: NodeJS.Timeout;
  private readonly file: string;

  constructor(private readonly config: AppConfig, private readonly store: StateStore, private readonly log: { info: Function; warn: Function }) {
    this.file = path.join(config.server.dataDir, 'mode.json');
    this.restore();
  }

  callout(req: CalloutRequest): ModeState {
    const text = (req.text ?? '').toString().trim();
    if (!text) throw new Error('text is required');
    const receivedAt = req.receivedAt ? new Date(req.receivedAt) : new Date();
    if (Number.isNaN(receivedAt.getTime())) throw new Error('receivedAt is not a valid date');
    const mins = this.config.callout.autoStanddownMinutes;
    const incident: Incident = {
      id: randomUUID(),
      text: text.slice(0, 2000),
      receivedAt: receivedAt.toISOString(),
      lat: isFiniteNum(req.lat) ? req.lat : undefined,
      lon: isFiniteNum(req.lon) ? req.lon : undefined,
      source: (req.source ?? 'api').toString().slice(0, 40),
      autoStanddownAt: mins > 0 ? new Date(receivedAt.getTime() + mins * 60_000).toISOString() : undefined,
    };
    const mode: ModeState = { mode: 'callout', incident, changedAt: new Date().toISOString() };
    this.apply(mode);
    this.log.info({ incident: incident.id, source: incident.source }, 'CALLOUT');
    return mode;
  }

  standdown(reason = 'manual'): ModeState {
    const cur = this.store.getMode();
    const mode: ModeState = { mode: 'standby', lastIncident: cur.incident ?? cur.lastIncident, changedAt: new Date().toISOString() };
    this.apply(mode);
    this.log.info({ reason }, 'STAND DOWN');
    return mode;
  }

  private apply(mode: ModeState): void {
    this.store.setMode(mode);
    this.schedule(mode);
    this.persist(mode);
  }

  private schedule(mode: ModeState): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const at = mode.incident?.autoStanddownAt;
    if (mode.mode === 'callout' && at) {
      const ms = Math.max(0, Date.parse(at) - Date.now());
      this.timer = setTimeout(() => this.standdown('auto-timeout'), Math.min(ms, 2 ** 31 - 1));
      this.timer.unref?.();
    }
  }

  private persist(mode: ModeState): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(mode, null, 2));
    } catch (e) {
      this.log.warn({ err: String(e) }, 'could not persist mode');
    }
  }

  private restore(): void {
    try {
      if (!fs.existsSync(this.file)) return;
      const mode = JSON.parse(fs.readFileSync(this.file, 'utf8')) as ModeState;
      if (mode.mode === 'callout' && mode.incident?.autoStanddownAt && Date.parse(mode.incident.autoStanddownAt) < Date.now()) {
        this.apply({ mode: 'standby', lastIncident: mode.incident, changedAt: new Date().toISOString() });
        return;
      }
      this.store.setMode(mode);
      this.schedule(mode);
      this.log.info({ mode: mode.mode }, 'restored display mode');
    } catch (e) {
      this.log.warn({ err: String(e) }, 'could not restore mode');
    }
  }
}

function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}
