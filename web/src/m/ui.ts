import { esc } from '../format';

/** Small HTML helpers for the crew app pages. */
export const card = (title: string, body: string, cls = '') => `<section class="card ${cls}"><h2>${esc(title)}</h2>${body}</section>`;
export const btn = (label: string, action: string, cls = '', extra = '') => `<button class="btn ${cls}" data-action="${esc(action)}" ${extra}>${esc(label)}</button>`;
export const note = (text: string, cls = 'muted') => `<p class="note ${cls}">${esc(text)}</p>`;
export const err = (text: string) => `<p class="note error">${esc(text)}</p>`;

export function field(label: string, name: string, type = 'text', value = '', attrs = ''): string {
  return `<label class="field"><span>${esc(label)}</span><input name="${esc(name)}" type="${type}" value="${esc(value)}" ${attrs} /></label>`;
}

export function select(label: string, name: string, options: [string, string][], value = ''): string {
  return `<label class="field"><span>${esc(label)}</span><select name="${esc(name)}">${options.map(([v, l]) => `<option value="${esc(v)}" ${v === value ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
}

export function statusBadge(status: string): string {
  const cls = { responding: 'amber', 'on-scene': 'green', available: 'blue', unavailable: 'grey', 'stood-down': 'grey' }[status] ?? 'grey';
  return `<span class="badge-s ${cls}">${esc(status.replace('-', ' '))}</span>`;
}

/** Delegate clicks on [data-action] within root to handlers. */
export function wireActions(root: HTMLElement, handlers: Record<string, (el: HTMLElement, ev: Event) => void | Promise<void>>): void {
  root.addEventListener('click', (ev) => {
    const el = (ev.target as HTMLElement).closest<HTMLElement>('[data-action]');
    if (!el || !root.contains(el)) return;
    const h = handlers[el.dataset.action!];
    if (!h) return;
    ev.preventDefault();
    const p = h(el, ev);
    if (p && typeof (p as Promise<void>).catch === 'function') (p as Promise<void>).catch((e) => toast(e instanceof Error ? e.message : String(e), true));
  });
}

let toastTimer: number | undefined;
export function toast(text: string, isError = false): void {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.className = isError ? 'show error' : 'show';
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el!.className = ''), isError ? 5000 : 2500);
}

export function formData(form: HTMLFormElement): Record<string, string> {
  const out: Record<string, string> = {};
  new FormData(form).forEach((v, k) => (out[k] = String(v)));
  return out;
}
