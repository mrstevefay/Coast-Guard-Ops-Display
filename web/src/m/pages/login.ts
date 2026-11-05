import type { UserPublic } from '../../../../shared/types';
import { post } from '../../api';
import { btn, err, field, formData, toast } from '../ui';

export function renderLogin(root: HTMLElement, onLoggedIn: (u: UserPublic) => void, error?: string): void {
  root.innerHTML = `
    <div class="login">
      <div class="login-brand"><div class="login-title">Howth Coast Guard</div><div class="login-sub">Crew app</div></div>
      <form class="login-form" autocomplete="on">
        ${field('Email', 'email', 'email', '', 'autocomplete="username" inputmode="email" required')}
        ${field('Password', 'password', 'password', '', 'autocomplete="current-password" required')}
        ${error ? err(error) : ''}
        ${btn('Sign in', 'login', 'primary big', 'type="submit"')}
      </form>
      <p class="note muted">No account? Ask the station admin. Your login is personal; do not share it.</p>
    </div>`;
  const form = root.querySelector('form')!;
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const { email, password } = formData(form);
    const b = form.querySelector<HTMLButtonElement>('button[type=submit]')!;
    b.disabled = true;
    try {
      const r = await post<{ user: UserPublic }>('/api/auth/login', { email, password });
      onLoggedIn(r.user);
    } catch (e) {
      renderLogin(root, onLoggedIn, e instanceof Error ? e.message : 'Sign in failed');
      toast('Sign in failed', true);
    }
  });
}
