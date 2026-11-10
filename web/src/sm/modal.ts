/** Console modal: one #modal host, click outside or Escape closes. */
export function modal(html: string): HTMLElement {
  const root = document.getElementById('modal')!;
  root.innerHTML = `<div class="modal-bg"><div class="modal">${html}</div></div>`;
  root.querySelector('.modal-bg')!.addEventListener('click', (ev) => {
    if (ev.target === ev.currentTarget) closeModal();
  });
  root.querySelector<HTMLElement>('[autofocus]')?.focus();
  return root;
}

export function closeModal(): void {
  document.getElementById('modal')!.innerHTML = '';
}

export function modalOpen(): boolean {
  return Boolean(document.getElementById('modal')?.firstChild);
}

/**
 * In-page confirmation (the browser's confirm() blocks the page and looks foreign on a tablet).
 * Enter confirms, Escape or a click outside cancels.
 */
export function confirmBox(text: string, ok = 'OK', danger = true): Promise<boolean> {
  return new Promise((resolve) => {
    const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
    const root = modal(`<p class="confirm-text">${esc(text)}</p><div class="modal-actions"><button type="button" class="btn-sm" id="cb-no">Cancel</button><button type="button" class="btn-sm ${danger ? 'danger' : 'primary'}" id="cb-yes">${esc(ok)}</button></div>`);
    let done = false;
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', key, true);
      observer.disconnect();
      closeModal();
      resolve(v);
    };
    const key = (ev: KeyboardEvent) => {
      if (ev.key === 'Enter') { ev.preventDefault(); finish(true); } else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); finish(false); }
    };
    document.addEventListener('keydown', key, true);
    // closed from outside (click on the backdrop): treat as cancel
    const observer = new MutationObserver(() => { if (!root.firstChild) finish(false); });
    observer.observe(root, { childList: true });
    root.querySelector('#cb-no')!.addEventListener('click', () => finish(false));
    const yes = root.querySelector<HTMLButtonElement>('#cb-yes')!;
    yes.addEventListener('click', () => finish(true));
    yes.focus();
  });
}
