import WebSocket from 'ws';
import type { AisState, AisVessel, DashboardData, ProviderHealth } from '../../../shared/types.js';
import type { AppConfig } from '../config.js';
import type { Provider, ProviderContext } from './types.js';

/**
 * aisstream.io WebSocket feed, bounded to the configured box. We keep a table
 * of vessels, expire them after `vesselTtlMin`, and `fetch()` just snapshots it.
 * Without an API key the provider reports 'stub' and the panel shows "no key".
 */
export interface AisStreamMessage {
  MessageType: string;
  MetaData: { MMSI: number; ShipName?: string; latitude: number; longitude: number; time_utc: string };
  Message: Record<string, any>;
}

export function applyAisMessage(table: Map<number, AisVessel>, msg: AisStreamMessage, now = new Date()): AisVessel | undefined {
  const meta = msg?.MetaData;
  if (!meta || typeof meta.MMSI !== 'number') return undefined;
  const body = msg.Message?.[msg.MessageType] ?? {};
  if (!Number.isFinite(meta.latitude) || !Number.isFinite(meta.longitude)) return undefined;
  const prev = table.get(meta.MMSI);
  const name = (meta.ShipName ?? body.Name ?? prev?.name ?? '').toString().trim() || undefined;
  const v: AisVessel = {
    mmsi: meta.MMSI,
    name,
    lat: meta.latitude,
    lon: meta.longitude,
    sogKt: typeof body.Sog === 'number' && body.Sog < 102.3 ? Math.round(body.Sog * 10) / 10 : prev?.sogKt,
    cogDeg: typeof body.Cog === 'number' && body.Cog < 360 ? Math.round(body.Cog) : prev?.cogDeg,
    headingDeg: typeof body.TrueHeading === 'number' && body.TrueHeading < 360 ? body.TrueHeading : prev?.headingDeg,
    shipType: typeof body.Type === 'number' ? body.Type : prev?.shipType,
    lastSeen: now.toISOString(),
  };
  table.set(meta.MMSI, v);
  return v;
}

export function expireVessels(table: Map<number, AisVessel>, ttlMs: number, now = new Date()): void {
  for (const [k, v] of table) if (now.getTime() - Date.parse(v.lastSeen) > ttlMs) table.delete(k);
}

export function aisProvider(cfg: AppConfig): Provider {
  const c = cfg.providers.ais;
  const hasKey = Boolean(c.apiKey);
  const table = new Map<number, AisVessel>();
  let ws: WebSocket | undefined;
  let connected = false;
  let stopped = false;
  let reconnectMs = 5000;
  let reconnectTimer: NodeJS.Timeout | undefined;
  let lastMessageAt: string | undefined;
  let ctxRef: ProviderContext | undefined;
  let startedAt = 0;

  function connect() {
    if (stopped || !hasKey || !ctxRef) return;
    const log = ctxRef.log;
    ws = new WebSocket(c.url);
    ws.on('open', () => {
      connected = true;
      reconnectMs = 5000;
      ws!.send(
        JSON.stringify({
          APIKey: c.apiKey,
          BoundingBoxes: [[[c.bbox.south, c.bbox.west], [c.bbox.north, c.bbox.east]]],
          FilterMessageTypes: ['PositionReport', 'StandardClassBPositionReport', 'ExtendedClassBPositionReport', 'ShipStaticData'],
        }),
      );
      log.info({}, 'aisstream connected');
    });
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString()) as AisStreamMessage & { error?: string };
        if (msg.error) {
          log.warn({ err: msg.error }, 'aisstream error');
          return;
        }
        applyAisMessage(table, msg);
        lastMessageAt = new Date().toISOString();
      } catch {
        /* ignore malformed frame */
      }
    });
    const onDown = (why: string) => {
      connected = false;
      ws?.removeAllListeners();
      ws = undefined;
      if (stopped) return;
      log.warn({ why, retryInMs: reconnectMs }, 'aisstream disconnected');
      reconnectTimer = setTimeout(connect, reconnectMs);
      reconnectTimer.unref?.();
      reconnectMs = Math.min(reconnectMs * 2, 5 * 60_000);
    };
    ws.on('close', (code) => onDown(`close ${code}`));
    ws.on('error', (e) => onDown(`error ${e.message}`));
  }

  return {
    name: 'ais',
    pollIntervalMs: c.pollIntervalMs,
    enabled: c.enabled,
    kind: hasKey ? 'stream' : 'stub',
    note: hasKey ? undefined : 'AISSTREAM_API_KEY not set',
    staleAfterMs: 10 * 60_000,
    start(ctx) {
      ctxRef = ctx;
      stopped = false;
      startedAt = Date.now();
      connect();
    },
    stop() {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    },
    async fetch(): Promise<Partial<DashboardData>> {
      expireVessels(table, c.vesselTtlMin * 60_000);
      const vessels = [...table.values()].sort((a, b) => a.mmsi - b.mmsi);
      const ais: AisState = { vessels, count: vessels.length, connected, bbox: c.bbox, updatedAt: lastMessageAt };
      // Give the stream 60 s to come up before the first poll counts as a failure.
      if (hasKey && !connected && table.size === 0 && Date.now() - startedAt > 60_000) throw new Error('aisstream not connected');
      return { ais };
    },
    health(): Partial<ProviderHealth> {
      if (!hasKey) return {};
      if (connected || Date.now() - startedAt < 60_000) return {};
      return { status: lastMessageAt ? 'stale' : 'error', lastError: 'aisstream not connected' };
    },
  };
}
