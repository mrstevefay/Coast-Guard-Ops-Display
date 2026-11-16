import { execFile } from 'node:child_process';
import os from 'node:os';

/**
 * Wi-Fi on the station Pi, through NetworkManager's `nmcli` (the dashboard user is
 * allowed to by the polkit rule in image/rootfs/etc/polkit-1/rules.d). Used by the
 * device page at /device/.
 *
 * Changing network is the dangerous part: if the new one fails, the Pi drops off the
 * LAN and nobody can reach this page to fix it. So a connect runs as a background
 * attempt: it starts a moment after the request returns (so the reply gets out on the
 * old network), and on failure it deletes the profile it made and brings the previous
 * Wi-Fi connection back up. The network chosen last gets the highest autoconnect
 * priority, so it is the one the Pi picks after a reboot.
 */

export type Run = (args: string[], timeoutMs?: number) => Promise<string>;

export class WifiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface SavedWifi {
  uuid: string;
  name: string;
  ssid: string;
  active: boolean;
  autoconnect: boolean;
  priority: number;
}

export interface NearbyWifi {
  ssid: string;
  signal: number;
  /** As nmcli reports it, e.g. "WPA2", "WPA1 WPA2", "WPA3", "" for open. */
  security: string;
  inUse: boolean;
  saved: boolean;
}

export interface WifiAttempt {
  id: number;
  ssid: string;
  state: 'connecting' | 'connected' | 'failed';
  startedAt: string;
  finishedAt?: string;
  error?: string;
  /** On failure: the network the Pi went back to, if any. */
  restored?: string;
}

export interface WifiStatus {
  available: boolean;
  reason?: string;
  hostname: string;
  iface?: string;
  radio?: boolean;
  /** NetworkManager device state: connected, disconnected, connecting, unavailable … */
  state?: string;
  ssid?: string;
  signal?: number;
  ip4?: string;
  ethernet?: { iface: string; connected: boolean; ip4?: string };
  saved: SavedWifi[];
  attempt?: WifiAttempt;
}

export interface ConnectRequest {
  ssid: string;
  password?: string;
  hidden?: boolean;
}

/** Split one line of `nmcli -t` output on unescaped colons, unescaping `\:` and `\\`. */
export function splitTerse(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\' && i + 1 < line.length) {
      cur += line[++i];
    } else if (c === ':') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

const lines = (s: string) => s.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.length > 0);

export const nmcliRun: Run = (args, timeoutMs = 20_000) =>
  new Promise((resolve, reject) => {
    execFile('nmcli', args, { timeout: timeoutMs, env: { ...process.env, LC_ALL: 'C' }, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      if (err) {
        const text = String(stderr || err.message).trim().replace(/^Error:\s*/i, '');
        reject(new Error(text || 'nmcli failed'));
      } else resolve(String(stdout));
    });
  });

/** SSID: 1–32 bytes, no control characters. */
export function validSsid(ssid: unknown): string {
  if (typeof ssid !== 'string') throw new WifiError(400, 'Network name is required');
  const s = ssid;
  if (!s.trim()) throw new WifiError(400, 'Network name is required');
  if (Buffer.byteLength(s, 'utf8') > 32) throw new WifiError(400, 'Network name is longer than 32 bytes');
  if (/[\x00-\x1f\x7f]/.test(s)) throw new WifiError(400, 'Network name has control characters');
  return s;
}

/** WPA passphrase: 8–63 printable ASCII, or 64 hex digits. */
export function validPassword(pw: unknown): string | undefined {
  if (pw === undefined || pw === null || pw === '') return undefined;
  if (typeof pw !== 'string') throw new WifiError(400, 'Password must be text');
  if (/^[0-9a-fA-F]{64}$/.test(pw)) return pw;
  if (pw.length < 8 || pw.length > 63) throw new WifiError(400, 'Wi-Fi passwords are 8 to 63 characters');
  if (!/^[\x20-\x7e]+$/.test(pw)) throw new WifiError(400, 'Wi-Fi passwords use plain keyboard characters only');
  return pw;
}

export interface WifiOptions {
  run?: Run;
  /** Delay before a connect starts, so the HTTP reply leaves on the old network. */
  startDelayMs?: number;
  /** Seconds NetworkManager waits for a connection to come up. */
  upWaitSec?: number;
  log?: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void };
}

export class WifiManager {
  private readonly run: Run;
  private readonly startDelayMs: number;
  private readonly upWaitSec: number;
  private attempt?: WifiAttempt;
  private seq = 0;
  private running?: Promise<void>;
  /** Security per SSID from the last scan, to pick WPA2 vs WPA3 for a new profile. */
  private lastScan = new Map<string, string>();

  constructor(private readonly opts: WifiOptions = {}) {
    this.run = opts.run ?? nmcliRun;
    this.startDelayMs = opts.startDelayMs ?? 1500;
    this.upWaitSec = opts.upWaitSec ?? 40;
  }

  /** Resolves when the current attempt (if any) has finished. For tests and shutdown. */
  async settled(): Promise<void> {
    await this.running;
  }

  private async devices(): Promise<{ wifi?: { iface: string; state: string; conn: string }; eth?: { iface: string; state: string } }> {
    const out = await this.run(['-t', '-f', 'DEVICE,TYPE,STATE,CONNECTION', 'device', 'status']);
    let wifi: { iface: string; state: string; conn: string } | undefined;
    let eth: { iface: string; state: string } | undefined;
    for (const l of lines(out)) {
      const [iface, type, state, conn] = splitTerse(l);
      if (type === 'wifi' && !wifi) wifi = { iface, state, conn: conn ?? '' };
      if (type === 'ethernet' && !eth) eth = { iface, state };
    }
    return { wifi, eth };
  }

  private async ip4(iface: string): Promise<string | undefined> {
    try {
      const out = await this.run(['-t', '-f', 'IP4.ADDRESS', 'device', 'show', iface]);
      for (const l of lines(out)) {
        const [k, v] = splitTerse(l);
        if (k.startsWith('IP4.ADDRESS') && v) return v.split('/')[0];
      }
    } catch {
      /* not fatal */
    }
    return undefined;
  }

  async saved(): Promise<SavedWifi[]> {
    const out = await this.run(['-t', '-f', 'NAME,UUID,TYPE,AUTOCONNECT,AUTOCONNECT-PRIORITY,ACTIVE', 'connection', 'show']);
    const rows = lines(out).map(splitTerse).filter((r) => r[2] === '802-11-wireless' || r[2] === 'wifi');
    const result: SavedWifi[] = [];
    for (const [name, uuid, , auto, prio, active] of rows) {
      let ssid = name;
      try {
        const s = lines(await this.run(['-t', '-g', '802-11-wireless.ssid', 'connection', 'show', 'uuid', uuid]))[0];
        if (s) ssid = splitTerse(s).join(':');
      } catch {
        /* keep the profile name */
      }
      result.push({ uuid, name, ssid, active: active === 'yes', autoconnect: auto === 'yes', priority: Number(prio) || 0 });
    }
    return result.sort((a, b) => Number(b.active) - Number(a.active) || b.priority - a.priority || a.ssid.localeCompare(b.ssid));
  }

  async status(): Promise<WifiStatus> {
    const hostname = os.hostname();
    let devs: Awaited<ReturnType<WifiManager['devices']>>;
    try {
      devs = await this.devices();
    } catch (e) {
      return { available: false, reason: `NetworkManager is not answering: ${e instanceof Error ? e.message : String(e)}`, hostname, saved: [], attempt: this.attempt };
    }
    const ethernet = devs.eth ? { iface: devs.eth.iface, connected: devs.eth.state === 'connected', ip4: devs.eth.state === 'connected' ? await this.ip4(devs.eth.iface) : undefined } : undefined;
    if (!devs.wifi) return { available: false, reason: 'No Wi-Fi adapter found', hostname, ethernet, saved: [], attempt: this.attempt };
    const { iface, state } = devs.wifi;
    let radio = true;
    try {
      radio = (await this.run(['-t', 'radio', 'wifi'])).trim() === 'enabled';
    } catch {
      /* assume on */
    }
    let ssid: string | undefined;
    let signal: number | undefined;
    if (state === 'connected') {
      try {
        const out = await this.run(['-t', '-f', 'IN-USE,SSID,SIGNAL', 'device', 'wifi', 'list', 'ifname', iface, '--rescan', 'no']);
        const row = lines(out).map(splitTerse).find((r) => r[0] === '*');
        if (row) {
          ssid = row[1];
          signal = Number(row[2]);
        }
      } catch {
        /* leave blank */
      }
    }
    const saved = await this.saved().catch(() => [] as SavedWifi[]);
    if (!ssid && state === 'connected') ssid = saved.find((s) => s.active)?.ssid;
    return {
      available: true,
      hostname,
      iface,
      radio,
      state,
      ssid,
      signal,
      ip4: state === 'connected' ? await this.ip4(iface) : undefined,
      ethernet,
      saved,
      attempt: this.attempt,
    };
  }

  async scan(): Promise<NearbyWifi[]> {
    const { wifi } = await this.devices();
    if (!wifi) throw new WifiError(409, 'No Wi-Fi adapter found');
    let out: string;
    try {
      out = await this.run(['-t', '-f', 'IN-USE,SSID,SIGNAL,SECURITY', 'device', 'wifi', 'list', 'ifname', wifi.iface, '--rescan', 'yes'], 30_000);
    } catch {
      // "Scanning not allowed immediately following previous scan": use what NM already has.
      out = await this.run(['-t', '-f', 'IN-USE,SSID,SIGNAL,SECURITY', 'device', 'wifi', 'list', 'ifname', wifi.iface, '--rescan', 'no']);
    }
    const saved = new Set((await this.saved().catch(() => [] as SavedWifi[])).map((s) => s.ssid));
    const best = new Map<string, NearbyWifi>();
    for (const r of lines(out).map(splitTerse)) {
      const [inUse, ssid, sig, sec] = r;
      if (!ssid) continue; // hidden networks broadcast no name
      const n: NearbyWifi = { ssid, signal: Number(sig) || 0, security: sec === '--' ? '' : (sec ?? ''), inUse: inUse === '*', saved: saved.has(ssid) };
      const prev = best.get(ssid);
      if (!prev) best.set(ssid, n);
      else best.set(ssid, { ...(n.signal > prev.signal ? n : prev), inUse: prev.inUse || n.inUse });
    }
    this.lastScan = new Map([...best.values()].map((n) => [n.ssid, n.security]));
    return [...best.values()].sort((a, b) => Number(b.inUse) - Number(a.inUse) || b.signal - a.signal);
  }

  private busy(): void {
    if (this.attempt?.state === 'connecting') throw new WifiError(409, `Already connecting to ${this.attempt.ssid}`);
  }

  /** Join a network by name (new or saved). Returns at once; the switch happens in the background. */
  async connect(req: ConnectRequest): Promise<WifiAttempt> {
    this.busy();
    const ssid = validSsid(req.ssid);
    const password = validPassword(req.password);
    const st = await this.status();
    if (!st.available || !st.iface) throw new WifiError(409, st.reason ?? 'Wi-Fi is not available');
    const existing = st.saved.find((s) => s.ssid === ssid);
    const security = this.lastScan.get(ssid);
    if (!existing && !password && security) throw new WifiError(400, `${ssid} needs a password`);
    return this.start(ssid, st, async () => {
      if (existing) {
        if (password) await this.run(['connection', 'modify', 'uuid', existing.uuid, 'wifi-sec.key-mgmt', keyMgmt(security), 'wifi-sec.psk', password]);
        return { uuid: existing.uuid, created: false };
      }
      // The passphrase goes on nmcli's command line, as in apply-wifi.sh; the Pi runs nothing else.
      const args = ['connection', 'add', 'type', 'wifi', 'ifname', st.iface!, 'con-name', profileName(ssid, st.saved), 'ssid', ssid, 'connection.autoconnect', 'yes'];
      if (password) args.push('wifi-sec.key-mgmt', keyMgmt(security), 'wifi-sec.psk', password);
      if (req.hidden) args.push('802-11-wireless.hidden', 'yes');
      const out = await this.run(args);
      const uuid = /\(([0-9a-f-]{36})\)/i.exec(out)?.[1];
      if (!uuid) throw new Error('NetworkManager did not return the new profile');
      return { uuid, created: true };
    });
  }

  /** Bring up a saved profile. */
  async activate(uuid: string): Promise<WifiAttempt> {
    this.busy();
    const st = await this.status();
    if (!st.available) throw new WifiError(409, st.reason ?? 'Wi-Fi is not available');
    const s = st.saved.find((x) => x.uuid === uuid);
    if (!s) throw new WifiError(404, 'No such saved network');
    return this.start(s.ssid, st, async () => ({ uuid, created: false }));
  }

  /** Delete a saved profile, unless it is the only thing keeping the Pi on the network. */
  async forget(uuid: string): Promise<void> {
    this.busy();
    const st = await this.status();
    const s = st.saved.find((x) => x.uuid === uuid);
    if (!s) throw new WifiError(404, 'No such saved network');
    if (s.active && !st.ethernet?.connected) {
      throw new WifiError(409, `${s.ssid} is the Pi's only connection. Forgetting it would take the Pi off the network. Connect to another network or plug in Ethernet first.`);
    }
    await this.run(['connection', 'delete', 'uuid', uuid]);
  }

  private start(ssid: string, st: WifiStatus, prepare: () => Promise<{ uuid: string; created: boolean }>): WifiAttempt {
    const prev = st.saved.find((s) => s.active);
    const attempt: WifiAttempt = { id: ++this.seq, ssid, state: 'connecting', startedAt: new Date().toISOString() };
    this.attempt = attempt;
    const log = this.opts.log;
    this.running = (async () => {
      if (this.startDelayMs > 0) await new Promise((r) => setTimeout(r, this.startDelayMs));
      let target: { uuid: string; created: boolean } | undefined;
      try {
        target = await prepare();
        await this.run(['--wait', String(this.upWaitSec), 'connection', 'up', 'uuid', target.uuid], (this.upWaitSec + 15) * 1000);
        // Last chosen wins after a reboot.
        const others = st.saved.filter((s) => s.uuid !== target!.uuid).map((s) => s.priority);
        const prio = Math.min(999, Math.max(0, ...others) + 1);
        await this.run(['connection', 'modify', 'uuid', target.uuid, 'connection.autoconnect', 'yes', 'connection.autoconnect-priority', String(prio)]).catch(() => undefined);
        Object.assign(attempt, { state: 'connected', finishedAt: new Date().toISOString() });
        log?.info({ ssid }, 'wifi: connected');
      } catch (e) {
        const error = cleanError(e);
        log?.warn({ ssid, error }, 'wifi: connect failed, restoring previous network');
        if (target?.created) await this.run(['connection', 'delete', 'uuid', target.uuid]).catch(() => undefined);
        let restored: string | undefined;
        if (prev && prev.uuid !== target?.uuid) {
          try {
            await this.run(['--wait', String(this.upWaitSec), 'connection', 'up', 'uuid', prev.uuid], (this.upWaitSec + 15) * 1000);
            restored = prev.ssid;
          } catch (e2) {
            log?.warn({ ssid: prev.ssid, error: cleanError(e2) }, 'wifi: could not restore previous network; NetworkManager autoconnect will retry');
          }
        }
        Object.assign(attempt, { state: 'failed', finishedAt: new Date().toISOString(), error, restored });
      }
    })();
    return { ...attempt };
  }
}

function keyMgmt(security: string | undefined): string {
  // WPA3-only networks need SAE; anything offering WPA2 (or unknown) uses PSK.
  return security && /WPA3/.test(security) && !/WPA[12]/.test(security) ? 'sae' : 'wpa-psk';
}

function profileName(ssid: string, saved: SavedWifi[]): string {
  const base = `howth-cg-${ssid.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 40) || 'wifi'}`;
  const names = new Set(saved.map((s) => s.name));
  let name = base;
  for (let i = 2; names.has(name); i++) name = `${base}-${i}`;
  return name;
}

function cleanError(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (/secrets were required|802-1x supplicant|no secrets/i.test(m)) return 'Wrong password, or the network refused the Pi';
  if (/no network with SSID|not found/i.test(m)) return 'Network not found: out of range or the name is wrong';
  if (/timeout|timed out/i.test(m)) return 'Timed out waiting for the network';
  return m.split('\n')[0].slice(0, 200);
}
