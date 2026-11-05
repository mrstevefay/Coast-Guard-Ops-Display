/** Small JSON fetch wrapper shared by the crew app and the console. */
export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

let onUnauthorised: (() => void) | undefined;
export function setUnauthorisedHandler(fn: () => void): void {
  onUnauthorised = fn;
}

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
    cache: 'no-store',
  });
  if (res.status === 401) onUnauthorised?.();
  const text = await res.text();
  let data: any = undefined;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = text;
  }
  if (!res.ok) throw new ApiError(res.status, (data && data.error) || `${res.status} ${res.statusText}`);
  return data as T;
}

export const get = <T = unknown>(path: string) => api<T>('GET', path);
export const post = <T = unknown>(path: string, body?: unknown) => api<T>('POST', path, body ?? {});
export const put = <T = unknown>(path: string, body?: unknown) => api<T>('PUT', path, body ?? {});
export const patch = <T = unknown>(path: string, body?: unknown) => api<T>('PATCH', path, body ?? {});
export const del = <T = unknown>(path: string) => api<T>('DELETE', path);
