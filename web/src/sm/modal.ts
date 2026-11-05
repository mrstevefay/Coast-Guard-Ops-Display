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
