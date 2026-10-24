/** Small fetch wrapper with timeout and a useful error message. */
export async function fetchText(url: string, opts: { timeoutMs?: number; headers?: Record<string, string> } = {}): Promise<string> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 20000);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      redirect: 'follow',
      headers: { 'user-agent': 'howth-cg-dashboard/0.1 (+https://github.com/mrstevefay/coast-guard-ops-display)', ...opts.headers },
    });
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 200);
      throw new Error(`HTTP ${res.status} from ${url}${body ? `: ${body}` : ''}`);
    }
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

export async function fetchJson<T = unknown>(url: string, opts?: { timeoutMs?: number }): Promise<T> {
  const text = await fetchText(url, opts);
  return JSON.parse(text) as T;
}
