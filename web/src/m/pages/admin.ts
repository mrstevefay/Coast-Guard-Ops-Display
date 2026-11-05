import type { Role, UserPublic } from '../../../../shared/types';
import { del, get, patch, post } from '../../api';
import { esc, fmtTime } from '../../format';
import { store } from '../store';
import { btn, card, field, formData, note, select, toast, wireActions } from '../ui';

interface DisplayKey {
  id: string;
  label: string;
  createdAt: string;
  lastSeenAt: string;
}

export async function renderAdmin(root: HTMLElement): Promise<void> {
  if (!store.isAdmin) return void (root.innerHTML = note('Admins only.'));
  root.innerHTML = `${card('Add user', `<form id="user-form" class="grid2">
      ${field('Name', 'name', 'text', '', 'required')}
      ${field('Email', 'email', 'email', '', 'required')}
      ${field('Callsign (optional)', 'callsign')}
      ${select('Role', 'role', [['member', 'Member'], ['manager', 'Search manager'], ['admin', 'Admin']], 'member')}
      ${btn('Create', 'create', 'primary wide', 'type="submit"')}
    </form><div id="user-result"></div>`)}
    <section class="card" id="users"><h2>Users</h2>${note('Loading…')}</section>
    <section class="card" id="keys"><h2>Display keys (TV / Pi)</h2>${note('Loading…')}</section>`;
  const form = root.querySelector<HTMLFormElement>('#user-form')!;
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      const r = await post<{ user: UserPublic; tempPassword?: string }>('/api/users', formData(form));
      root.querySelector('#user-result')!.innerHTML = `<div class="note warn">Created ${esc(r.user.name)}. Temporary password (shown once): <b class="mono">${esc(r.tempPassword ?? '')}</b></div>`;
      form.reset();
      await loadUsers();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'failed', true);
    }
  });
  wireActions(root, {
    reset: async (el) => {
      if (!confirm('Reset this user’s password?')) return;
      const r = await post<{ tempPassword: string }>(`/api/users/${el.dataset.id}/reset-password`);
      root.querySelector('#user-result')!.innerHTML = `<div class="note warn">New temporary password for ${esc(el.dataset.name ?? '')}: <b class="mono">${esc(r.tempPassword)}</b></div>`;
    },
    toggle: async (el) => {
      await patch(`/api/users/${el.dataset.id}`, { active: el.dataset.active !== 'true' });
      await loadUsers();
    },
    role: async (el) => {
      const role = prompt('Role: member, manager or admin', el.dataset.role) as Role | null;
      if (!role) return;
      await patch(`/api/users/${el.dataset.id}`, { role });
      await loadUsers();
    },
    remove: async (el) => {
      if (!confirm(`Remove ${el.dataset.name}? The account is anonymised; this cannot be undone.`)) return;
      await del(`/api/users/${el.dataset.id}`);
      await loadUsers();
    },
    'new-key': async () => {
      const label = prompt('Label for this display key (e.g. Station TV)', 'Station TV');
      if (!label) return;
      const r = await post<{ key: string }>('/api/admin/display-keys', { label });
      root.querySelector('#keys')!.insertAdjacentHTML('afterbegin', `<div class="note warn">Key (shown once): <b class="mono">${esc(r.key)}</b><br/>Put it in howth-cg.env on the Pi as UPSTREAM_KEY, or open the TV page as /?key=…</div>`);
      await loadKeys();
    },
    'del-key': async (el) => {
      if (!confirm('Delete this display key? The TV using it will lose access.')) return;
      await del(`/api/admin/display-keys/${el.dataset.id}`);
      await loadKeys();
    },
  });

  async function loadUsers() {
    const { users } = await get<{ users: UserPublic[] }>('/api/users');
    root.querySelector('#users')!.innerHTML = `<h2>Users · ${users.length}</h2>${users
      .map(
        (u) => `<div class="user-row ${u.active ? '' : 'inactive'}">
        <div><b>${esc(u.name)}</b> <span class="muted">${esc(u.email)}</span><br/><span class="muted small">${esc(u.role)}${u.callsign ? ` · ${esc(u.callsign)}` : ''} · ${u.deviceCount ?? 0} phone(s) · ${u.lastLoginAt ? `login ${fmtTime(u.lastLoginAt)}` : 'never logged in'}${u.mustChangePassword ? ' · temp password' : ''}</span></div>
        <div class="btn-row small-btns">${btn('Role', 'role', 'small ghost', `data-id="${u.id}" data-role="${esc(u.role)}"`)}${btn('Reset pw', 'reset', 'small ghost', `data-id="${u.id}" data-name="${esc(u.name)}"`)}${btn(u.active ? 'Deactivate' : 'Activate', 'toggle', 'small ghost', `data-id="${u.id}" data-active="${u.active}"`)}${btn('Remove', 'remove', 'small danger', `data-id="${u.id}" data-name="${esc(u.name)}"`)}</div>
      </div>`,
      )
      .join('')}`;
  }
  async function loadKeys() {
    const { keys } = await get<{ keys: DisplayKey[] }>('/api/admin/display-keys');
    const el = root.querySelector('#keys')!;
    const notes = [...el.querySelectorAll('.note.warn')].map((n) => n.outerHTML).join('');
    el.innerHTML = `<h2>Display keys (TV / Pi)</h2>${notes}${keys.map((k) => `<div class="member-row"><b>${esc(k.label)}</b><span class="muted right">seen ${fmtTime(k.lastSeenAt)}</span> ${btn('Delete', 'del-key', 'small ghost', `data-id="${k.id}"`)}</div>`).join('') || note('None yet')}${btn('+ New display key', 'new-key', 'primary wide')}`;
  }
  await Promise.all([loadUsers(), loadKeys()]);
}
