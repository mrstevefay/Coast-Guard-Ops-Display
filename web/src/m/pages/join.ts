import type { UserPublic } from '../../../../shared/types';
import { get, post } from '../../api';
import { esc } from '../../format';
import { btn, err, field, formData } from '../ui';

/**
 * Join from an invite link (/m/#/join/<token>): the new member types their own name, callsign,
 * email and password and is signed in, or told the station officer will approve the account.
 * The token is only in the URL fragment, so it never reaches the server's logs.
 */
export async function renderJoin(root: HTMLElement, token: string, onJoined: (u: UserPublic) => void): Promise<void> {
  root.innerHTML = `<div class="login"><div class="login-brand"><div class="login-title">Howth Coast Guard</div><div class="login-sub">Join the crew app</div></div><p class="muted">Checking the invite…</p></div>`;
  let info: { station: string; needsApproval: boolean; expiresAt: string };
  try {
    info = await get(`/api/join/${encodeURIComponent(token)}`);
  } catch (e) {
    root.innerHTML = `<div class="login"><div class="login-brand"><div class="login-title">Howth Coast Guard</div><div class="login-sub">Join the crew app</div></div>
      ${err(e instanceof Error ? e.message : 'This invite link cannot be used.')}
      <a class="btn" href="/m/">Sign in instead</a></div>`;
    return;
  }
  const draw = (error?: string, values: Record<string, string> = {}) => {
    root.innerHTML = `<div class="login">
      <div class="login-brand"><div class="login-title">${esc(info.station)}</div><div class="login-sub">Join the crew app</div></div>
      <form class="login-form join-form" autocomplete="on">
        ${field('Your name', 'name', 'text', values.name ?? '', 'autocomplete="name" required maxlength="60"')}
        ${field('Callsign (optional)', 'callsign', 'text', values.callsign ?? '', 'maxlength="12" autocapitalize="characters" placeholder="e.g. AK"')}
        ${field('Email', 'email', 'email', values.email ?? '', 'autocomplete="email" inputmode="email" required')}
        ${field('Choose a password', 'password', 'password', '', 'autocomplete="new-password" minlength="8" required')}
        ${field('Password again', 'password2', 'password', '', 'autocomplete="new-password" minlength="8" required')}
        <p class="note muted small">At least 8 characters. Your login is personal: do not share it.</p>
        ${error ? err(error) : ''}
        ${btn('Join', 'join', 'primary big', 'type="submit"')}
      </form>
      ${info.needsApproval ? '<p class="note muted">The station officer approves new accounts before you can sign in.</p>' : ''}
    </div>`;
    const form = root.querySelector<HTMLFormElement>('form')!;
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const f = formData(form);
      if (f.password !== f.password2) return draw('The two passwords do not match.', f);
      const b = form.querySelector<HTMLButtonElement>('button[type=submit]')!;
      b.disabled = true;
      try {
        const r = await post<{ user?: UserPublic; pending?: boolean }>(`/api/join/${encodeURIComponent(token)}`, { name: f.name, callsign: f.callsign, email: f.email, password: f.password });
        if (r.user) {
          history.replaceState(null, '', `${location.pathname}#/status`); // the link is used up: drop it from the address bar
          return onJoined(r.user);
        }
        history.replaceState(null, '', location.pathname);
        root.innerHTML = `<div class="login"><div class="login-brand"><div class="login-title">${esc(info.station)}</div><div class="login-sub">Account made</div></div>
          <p class="note">Thanks, ${esc(f.name)}. Once the station officer approves your account, sign in with your email and the password you chose.</p>
          <a class="btn primary big" href="/m/">Sign in</a></div>`;
      } catch (e) {
        draw(e instanceof Error ? e.message : 'Could not create the account', f);
      }
    });
  };
  draw();
}
