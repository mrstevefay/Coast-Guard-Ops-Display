import type { DashboardData, WebcamState } from '../../../shared/types.js';
import type { AppConfig } from '../config.js';
import type { Provider } from './types.js';

/**
 * Webcam is a pass-through: the frontend loads the still image directly and
 * refreshes it. No stable public Howth Harbour still URL was found (README),
 * so this is a stub until `providers.webcam.imageUrl` / WEBCAM_IMAGE_URL is set.
 */
export function webcamProvider(cfg: AppConfig): Provider {
  const c = cfg.providers.webcam;
  const configured = Boolean(c.imageUrl);
  return {
    name: 'webcam',
    pollIntervalMs: c.pollIntervalMs,
    enabled: c.enabled,
    kind: configured ? 'poll' : 'stub',
    note: configured ? undefined : 'no webcam URL configured — placeholder',
    async fetch(): Promise<Partial<DashboardData>> {
      if (configured) {
        // HEAD the image so health reflects whether the camera is reachable.
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 10000);
        try {
          const res = await fetch(c.imageUrl, { method: 'HEAD', signal: ctl.signal });
          if (!res.ok) throw new Error(`webcam HTTP ${res.status}`);
        } finally {
          clearTimeout(t);
        }
      }
      const webcam: WebcamState = { configured, label: c.label, imageUrl: configured ? c.imageUrl : undefined, refreshSec: c.refreshSec };
      return { webcam };
    },
  };
}
