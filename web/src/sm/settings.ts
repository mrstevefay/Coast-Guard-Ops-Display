/**
 * Settings & administration for the desktop console (/sm/#settings/<section>).
 * Everything the crew app offers under More → Admin, plus the admin-only API
 * (backups, retention, audit log) that had no UI, laid out for a laptop.
 */
import { CONTACT_ROLES, CONTACT_ROLE_LABEL, PRIVATE_CONTACT_ROLES, type DevicePublic, type ProviderHealth, type Role, type StationContact, type TerrainStatus, type UserPublic } from '../../../shared/types';
import { ApiError, del, get, patch, post, put } from '../api';
import { esc } from '../format';
import { toast } from '../m/ui';
import { closeModal, modal } from './modal';
import { cs } from './state';

export type SettingsSection = 'users' | 'contacts' | 'displays' | 'feeds' | 'backups' | 'terrain' | 'audit' | 'system' | 'account';

interface FeedSetting { key: string; label: string; help: string; provider: string; env?: string; secret: boolean; kind: 'text' | 'url'; source: 'ui' | 'env' | 'config' | 'none'; value: string; isSet: boolean }

interface DisplayKey { id: string; label: string; createdAt: string; lastSeenAt?: string }
interface BackupInfo { file: string; bytes: number; at: string }
interface AuditEntry { id: number; at: string; actorUserId?: number; actorIp?: string; action: string; targetType?: string; targetId?: string; detail?: unknown }
interface NewDevice { device: DevicePublic; secret: string; otrc: Record<string, unknown>; configLink: string }
interface Health { status: string; mode: string; uptimeSec: number; db: string; wsClients: number; fixesLastMin: number; upstream?: string; providers?: Record<string, ProviderHealth> }

const SECTIONS: { id: SettingsSection; label: string; adminOnly: boolean }[] = [
  { id: 'users', label: 'Users', adminOnly: false },
  { id: 'contacts', label: 'Station contacts', adminOnly: false },
  { id: 'displays', label: 'Display keys', adminOnly: true },
  { id: 'feeds', label: 'Data feeds', adminOnly: true },
  { id: 'backups', label: 'Backups & retention', adminOnly: true },
  { id: 'terrain', label: 'Terrain', adminOnly: true },
  { id: 'audit', label: 'Audit log', adminOnly: true },
  { id: 'system', label: 'System status', adminOnly: false },
  { id: 'account', label: 'My account', adminOnly: false },
];
const ROLES: [Role, string][] = [['member', 'Member'], ['manager', 'Search manager'], ['admin', 'Admin']];

export function isSettingsSection(s: string | undefined): s is SettingsSection {
  return SECTIONS.some((x) => x.id === s);
}

const dt = new Intl.DateTimeFormat('en-IE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Europe/Dublin' });
const fmtDT = (iso?: string) => (iso ? dt.format(new Date(iso)) : '—');
const fmtBytes = (b: number) => (b >= 1 << 20 ? `${(b / (1 << 20)).toFixed(1)} MB` : b >= 1024 ? `${Math.round(b / 1024)} kB` : `${b} B`);
const fmtUptime = (s: number) => (s >= 86400 ? `${Math.floor(s / 86400)} d ${Math.floor((s % 86400) / 3600)} h` : s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min` : `${Math.floor(s / 60)} min`);
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const roleSelect = (name: string, value: Role, attrs = '') => `<select name="${name}" ${attrs}>${ROLES.map(([v, l]) => `<option value="${v}" ${v === value ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
const badge = (s: string, cls: string) => `<span class="badge-s ${cls}">${esc(s)}</span>`;

/** One-off secrets (temp passwords, display keys) shown until the section is left. */
const reveals = new Map<SettingsSection, string>();
function reveal(section: SettingsSection, html: string): void {
  reveals.set(section, html);
  const el = document.querySelector<HTMLElement>('#set-reveal');
  if (el) el.innerHTML = html;
}

/** Render (or re-render when the section changed). Safe to call on every store tick. */
export function renderSettings(root: HTMLElement, force = false): void {
  const section = cs.s.section;
  if (!force && root.dataset.section === section) return;
  if (root.dataset.section !== section) reveals.delete(root.dataset.section as SettingsSection);
  root.dataset.section = section;
  const allowed = SECTIONS.filter((s) => !s.adminOnly || cs.isAdmin);
  root.innerHTML = `<nav class="set-nav">${allowed.map((s) => `<button class="${s.id === section ? 'active' : ''}" data-section="${s.id}">${s.label}</button>`).join('')}
      <a class="set-nav-link" href="/m/" target="_blank">Crew app ↗</a><a class="set-nav-link" href="/" target="_blank">TV display ↗</a></nav>
    <div class="set-body" id="set-body"><div id="set-reveal">${reveals.get(section) ?? ''}</div><div id="set-main"><p class="muted">Loading…</p></div></div>`;
  root.querySelectorAll<HTMLButtonElement>('[data-section]').forEach((b) => b.addEventListener('click', () => (location.hash = `#settings/${b.dataset.section}`)));
  const main = root.querySelector<HTMLElement>('#set-main')!;
  const render = { users: usersSection, contacts: contactsSection, displays: displaysSection, feeds: feedsSection, backups: backupsSection, terrain: terrainSection, audit: auditSection, system: systemSection, account: accountSection }[section];
  if (!allowed.some((s) => s.id === section)) main.innerHTML = '<p class="muted">Admins only.</p>';
  else render(main).catch((e) => (main.innerHTML = `<p class="note error">${esc(msg(e))}</p>`));
}

// ------------------------------------------------------------------ users
async function usersSection(el: HTMLElement): Promise<void> {
  const admin = cs.isAdmin;
  const myId = cs.s.me?.id;
  const load = async () => {
    const { users } = await get<{ users: UserPublic[] }>('/api/users');
    el.innerHTML = `<div class="set-head"><h2>Users <span class="muted">· ${users.length}</span></h2>${admin ? '<button class="btn-sm primary" data-act="add">+ Add user</button>' : '<span class="muted small">Read-only: admins manage accounts.</span>'}</div>
      <table class="set-table"><thead><tr><th>Name</th><th>Email</th><th>Callsign</th><th>Role</th><th>Phones</th><th>Last login</th><th>State</th>${admin ? '<th></th>' : ''}</tr></thead><tbody>
      ${users.map((u) => `<tr class="${u.active ? '' : 'inactive'}" data-id="${u.id}">
        <td><b>${esc(u.name)}</b>${u.id === myId ? ' <span class="muted small">(you)</span>' : ''}</td>
        <td>${esc(u.email)}</td>
        <td>${esc(u.callsign ?? '')}</td>
        <td>${admin ? roleSelect('role', u.role, `data-role="${u.id}" ${u.id === myId ? 'disabled title="You cannot change your own role"' : ''}`) : esc(u.role)}</td>
        <td>${u.deviceCount ?? 0}</td>
        <td>${u.lastLoginAt ? fmtDT(u.lastLoginAt) : '<span class="muted">never</span>'}</td>
        <td>${u.active ? badge('active', 'green') : badge('inactive', 'grey')}${u.mustChangePassword ? ' ' + badge('temp pw', 'amber') : ''}${!u.privacyAcceptedAt && u.active ? ' ' + badge('privacy pending', 'grey') : ''}</td>
        ${admin ? `<td class="acts"><button class="mini" data-act="edit" data-id="${u.id}">Edit</button><button class="mini" data-act="reset" data-id="${u.id}">Reset pw</button>${u.id === myId ? '' : `<button class="mini" data-act="toggle" data-id="${u.id}" data-active="${u.active}">${u.active ? 'Deactivate' : 'Activate'}</button><button class="mini danger" data-act="remove" data-id="${u.id}">Remove</button>`}</td>` : ''}
      </tr>`).join('')}</tbody></table>
      <p class="muted small">Roles: <b>member</b> responds and is tracked · <b>search manager</b> runs incidents in this console · <b>admin</b> manages users, displays and backups. Removing a user anonymises the account; their track points lose the name.</p>`;
    if (!admin) return;
    const byId = (id: string) => users.find((u) => u.id === Number(id))!;
    el.querySelectorAll<HTMLSelectElement>('[data-role]').forEach((s) => s.addEventListener('change', () => run(async () => { await patch(`/api/users/${s.dataset.role}`, { role: s.value }); toast('Role updated'); }, load)));
    wire(el, {
      add: () => userModal(undefined, load),
      edit: (b) => userModal(byId(b.dataset.id!), load),
      reset: (b) => {
        const u = byId(b.dataset.id!);
        confirmModal(`Reset ${esc(u.name)}’s password?`, 'They are signed out everywhere and must set a new password at next login.', 'Reset', async () => {
          const r = await post<{ tempPassword: string }>(`/api/users/${u.id}/reset-password`);
          reveal('users', `<div class="note warn">Temporary password for <b>${esc(u.name)}</b> (shown once): <b class="mono">${esc(r.tempPassword)}</b></div>`);
          await load();
        });
      },
      toggle: (b) => run(async () => { await patch(`/api/users/${b.dataset.id}`, { active: b.dataset.active !== 'true' }); }, load),
      remove: (b) => {
        const u = byId(b.dataset.id!);
        confirmModal(`Remove ${esc(u.name)}?`, 'The account is anonymised and cannot be restored. Their phones are revoked.', 'Remove', async () => { await del(`/api/users/${u.id}`); await load(); }, true);
      },
    });
  };
  await load();
}

function userModal(u: UserPublic | undefined, reload: () => Promise<void>): void {
  const root = modal(`<h3>${u ? 'Edit user' : 'Add user'}</h3>
    <form id="uf">
      <label>Name <input name="name" value="${esc(u?.name ?? '')}" required autofocus /></label>
      <label>Email <input name="email" type="email" value="${esc(u?.email ?? '')}" required /></label>
      <label>Callsign (optional) <input name="callsign" value="${esc(u?.callsign ?? '')}" maxlength="12" /></label>
      ${u && u.id === cs.s.me?.id ? '' : `<label>Role ${roleSelect('role', u?.role ?? 'member')}</label>`}
      ${u ? '' : '<p class="muted small">A temporary password is generated and shown once. The user must change it at first login.</p>'}
      <div class="modal-actions"><button type="button" class="btn-sm" id="cancel">Cancel</button><button type="submit" class="btn-sm primary">${u ? 'Save' : 'Create'}</button></div>
    </form>`);
  root.querySelector('#cancel')!.addEventListener('click', closeModal);
  root.querySelector<HTMLFormElement>('#uf')!.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const f = Object.fromEntries(new FormData(ev.target as HTMLFormElement)) as Record<string, string>;
    run(async () => {
      if (u) {
        await patch(`/api/users/${u.id}`, { name: f.name, email: f.email, callsign: f.callsign || null, ...(f.role ? { role: f.role } : {}) });
        toast('Saved');
      } else {
        const r = await post<{ user: UserPublic; tempPassword?: string }>('/api/users', f);
        reveal('users', `<div class="note warn">Created <b>${esc(r.user.name)}</b>. Temporary password (shown once): <b class="mono">${esc(r.tempPassword ?? '')}</b></div>`);
      }
      closeModal();
    }, reload);
  });
}

// ------------------------------------------------------------------ display keys
async function displaysSection(el: HTMLElement): Promise<void> {
  const load = async () => {
    const { keys } = await get<{ keys: DisplayKey[] }>('/api/admin/display-keys');
    el.innerHTML = `<div class="set-head"><h2>Display keys</h2></div>
      <p class="muted">A display key lets a TV or the station Pi show the live picture without a personal login. Put it in <span class="mono">howth-cg.env</span> on the Pi as <span class="mono">UPSTREAM_KEY</span>, or open the TV page as <span class="mono">/?key=…</span>.</p>
      <form class="set-form" id="kf"><label>Label <input name="label" value="Station TV" required maxlength="40" /></label><button class="btn-sm primary" type="submit">+ New display key</button></form>
      <table class="set-table"><thead><tr><th>Label</th><th>Created</th><th>Last seen</th><th></th></tr></thead><tbody>
      ${keys.map((k) => `<tr><td><b>${esc(k.label)}</b></td><td>${fmtDT(k.createdAt)}</td><td>${k.lastSeenAt ? fmtDT(k.lastSeenAt) : '<span class="muted">never</span>'}</td><td class="acts"><button class="mini danger" data-act="del" data-id="${esc(k.id)}" data-label="${esc(k.label)}">Delete</button></td></tr>`).join('') || '<tr><td colspan="4" class="muted">No display keys yet.</td></tr>'}
      </tbody></table>`;
    el.querySelector<HTMLFormElement>('#kf')!.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const label = String(new FormData(ev.target as HTMLFormElement).get('label') ?? '');
      run(async () => {
        const r = await post<{ key: string }>('/api/admin/display-keys', { label });
        reveal('displays', `<div class="note warn">Key for <b>${esc(label)}</b> (shown once): <b class="mono">${esc(r.key)}</b></div>`);
      }, load);
    });
    wire(el, {
      del: (b) => confirmModal(`Delete key “${esc(b.dataset.label ?? '')}”?`, 'The TV using it loses access immediately.', 'Delete', async () => { await del(`/api/admin/display-keys/${b.dataset.id}`); await load(); }, true),
    });
  };
  await load();
}

// ------------------------------------------------------------------ station contacts
/** Standing contacts (Garda station, MRCC, ambulance, other units) that a manager adds to an incident in one click. */
async function contactsSection(el: HTMLElement): Promise<void> {
  const roles = CONTACT_ROLES.filter((r) => !PRIVATE_CONTACT_ROLES.includes(r));
  const load = async () => {
    const { contacts } = await get<{ contacts: StationContact[] }>('/api/contacts');
    el.innerHTML = `<div class="set-head"><h2>Station contacts</h2></div>
      <p class="muted">Agencies and units you call on most taskings. On an incident, add one in a click from the Contacts panel, then type the name of the person you spoke to and their reference. Next of kin are only ever added to an incident.</p>
      <form class="set-form" id="dir-form">
        <label>Role <select name="role">${roles.map((r) => `<option value="${r}">${esc(CONTACT_ROLE_LABEL[r])}</option>`).join('')}</select></label>
        <label>Name <input name="name" required maxlength="120" placeholder="e.g. Howth Garda Station" /></label>
        <label>Organisation <input name="organisation" maxlength="120" placeholder="e.g. An Garda Síochána" /></label>
        <label>Phone <input name="phone" maxlength="40" inputmode="tel" /></label>
        <button class="btn-sm primary" type="submit">+ Add</button>
      </form>
      <table class="set-table"><thead><tr><th>Role</th><th>Name</th><th>Organisation</th><th>Phone</th><th></th></tr></thead><tbody>
      ${contacts.map((c) => `<tr data-id="${c.id}"><td>${esc(CONTACT_ROLE_LABEL[c.role])}</td><td><input class="inline-edit" data-field="name" value="${esc(c.name)}" maxlength="120" /></td><td><input class="inline-edit" data-field="organisation" value="${esc(c.organisation ?? '')}" maxlength="120" /></td><td><input class="inline-edit" data-field="phone" value="${esc(c.phone ?? '')}" maxlength="40" inputmode="tel" /></td><td class="acts"><button class="mini danger" data-act="del" data-id="${c.id}" data-label="${esc(c.name)}">Remove</button></td></tr>`).join('') || '<tr><td colspan="5" class="muted">No station contacts yet.</td></tr>'}
      </tbody></table>
      <p class="muted small">Edits save when you leave the field.</p>`;
    el.querySelector<HTMLFormElement>('#dir-form')!.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const f = Object.fromEntries(new FormData(ev.target as HTMLFormElement)) as Record<string, string>;
      run(async () => { await post('/api/contacts', f); toast(`${f.name} added`); }, load);
    });
    el.querySelectorAll<HTMLInputElement>('.inline-edit').forEach((i) => i.addEventListener('change', () => {
      const id = i.closest<HTMLElement>('tr')!.dataset.id;
      run(async () => { await patch(`/api/contacts/${id}`, { [i.dataset.field!]: i.value }); toast('Saved'); });
    }));
    wire(el, {
      del: (b) => confirmModal(`Remove “${esc(b.dataset.label ?? '')}”?`, 'Incidents that used it keep their copy.', 'Remove', async () => { await del(`/api/contacts/${b.dataset.id}`); await load(); }, true),
    });
  };
  await load();
}

// ------------------------------------------------------------------ data feeds
async function feedsSection(el: HTMLElement): Promise<void> {
  const sourceBadge = (s: FeedSetting) => (s.source === 'ui' ? badge('set here', 'green') : s.source === 'env' ? badge('from .env', 'blue') : s.source === 'config' ? badge('from config.yaml', 'grey') : badge('not set', 'amber'));
  const load = async () => {
    let list: FeedSetting[];
    try {
      list = (await get<{ settings: FeedSetting[] }>('/api/admin/settings')).settings;
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return void (el.innerHTML = '<div class="set-head"><h2>Data feeds</h2></div><p class="muted">This server was started without runtime settings (older build).</p>');
      throw e;
    }
    el.innerHTML = `<div class="set-head"><h2>Data feeds</h2></div>
      <p class="muted">Keys and URLs for the live feeds. A value saved here takes effect immediately (the feed is restarted) and overrides <span class="mono">.env</span> and <span class="mono">config.yaml</span>. Clear it to fall back to those. Check the result under <a href="#settings/system">System status</a>.</p>
      <div class="set-card">
      ${list.map((s) => `<form class="feed-row" data-key="${esc(s.key)}">
          <div class="feed-head"><b>${esc(s.label)}</b> ${sourceBadge(s)}${s.env ? ` <span class="muted small mono">${esc(s.env)}</span>` : ''}</div>
          <div class="muted small">${esc(s.help)}</div>
          <div class="feed-ctl">
            <input name="value" type="${s.secret ? 'password' : s.kind === 'url' ? 'url' : 'text'}" autocomplete="${s.secret ? 'new-password' : 'off'}" placeholder="${s.isSet ? esc(s.value) : s.secret ? 'paste key…' : s.kind === 'url' ? 'https://…' : '…'}" ${s.kind === 'url' ? 'pattern="https?://.*"' : ''} />
            <button class="btn-sm primary" type="submit">Save</button>
            ${s.source === 'ui' ? `<button class="btn-sm" type="button" data-act="clear" data-key="${esc(s.key)}">Clear</button>` : ''}
            ${s.isSet && !s.secret ? `<span class="muted small">current: <span class="mono">${esc(s.value)}</span></span>` : s.isSet ? `<span class="muted small">current: <span class="mono">${esc(s.value)}</span></span>` : ''}
          </div>
        </form>`).join('')}
      </div>`;
    el.querySelectorAll<HTMLFormElement>('form.feed-row').forEach((form) => form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const value = String(new FormData(form).get('value') ?? '').trim();
      if (!value) return toast('Enter a value, or use Clear', true);
      save({ [form.dataset.key!]: value });
    }));
    wire(el, {
      clear: (b) => confirmModal('Clear this value?', 'The feed falls back to .env / config.yaml, or is disabled if nothing is set there.', 'Clear', async () => { await put('/api/admin/settings', { [b.dataset.key!]: null }); toast('Cleared; feed restarted'); await load(); }),
    });
  };
  const save = (body: Record<string, string>) => run(async () => {
    const r = await put<{ rebuilt: string[] }>('/api/admin/settings', body);
    toast(`Saved; ${r.rebuilt.join(', ')} feed restarted`);
  }, load);
  await load();
}

// ------------------------------------------------------------------ backups & retention
async function backupsSection(el: HTMLElement): Promise<void> {
  let lastRetention = '';
  const load = async () => {
    let backups: BackupInfo[] | undefined;
    try {
      backups = (await get<{ backups: BackupInfo[] }>('/api/admin/backups')).backups;
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 404)) throw e;
    }
    el.innerHTML = `<div class="set-head"><h2>Backups & retention</h2></div>
      <div class="set-card"><h3>SQLite backups</h3>
      ${backups === undefined ? '<p class="muted">Backups are not configured on this server (no DATA_DIR).</p>' : `
        <p class="muted">A consistent copy of the database is taken nightly at 03:30 and kept in <span class="mono">data/backups</span>. Restore: see RUNBOOK. Vultr snapshots run on top of these.</p>
        <button class="btn-sm primary" data-act="backup">Back up now</button>
        <table class="set-table"><thead><tr><th>File</th><th>Size</th><th>Taken</th></tr></thead><tbody>
        ${backups.map((b) => `<tr><td class="mono">${esc(b.file)}</td><td>${fmtBytes(b.bytes)}</td><td>${fmtDT(b.at)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">No backups yet.</td></tr>'}
        </tbody></table>`}
      </div>
      <div class="set-card"><h3>Retention</h3>
        <p class="muted">Nightly housekeeping clears stale last-known positions, expired sessions, old track points and audit rows per <span class="mono">config.yaml → retention</span>. Run it now to apply a config change immediately.</p>
        <button class="btn-sm" data-act="retention">Run retention now</button>
        <div id="ret-out">${lastRetention}</div>
      </div>`;
    wire(el, {
      backup: (b) => run(async () => { b.setAttribute('disabled', ''); const r = await post<BackupInfo>('/api/admin/backup'); toast(`Backup written: ${r.file} (${fmtBytes(r.bytes)})`); }, load),
      retention: (b) => run(async () => { b.setAttribute('disabled', ''); const r = await post<Record<string, unknown>>('/api/admin/retention'); lastRetention = `<pre class="set-pre">${esc(JSON.stringify(r, null, 2))}</pre>`; toast('Retention run'); }, load),
    });
  };
  await load();
}

// ------------------------------------------------------------------ terrain
async function terrainSection(el: HTMLElement): Promise<void> {
  let timer: number | undefined;
  const load = async () => {
    if (!el.isConnected) { if (timer) clearInterval(timer); return; }
    const st = await get<TerrainStatus>('/api/admin/terrain');
    const job = st.job;
    const running = Boolean(job?.running);
    const fmtPct = (v?: number) => (v === undefined ? '—' : `${v} %`);
    el.innerHTML = `<div class="set-head"><h2>Terrain</h2></div>
      <div class="set-card"><h3>Terrain data for search areas</h3>
        <p class="muted">The Behaviour tab shapes each distance ring to the ground: sea, cliffs, rivers, railways, steep slopes and rough cover take reach away. It needs a one-off build from open data: Copernicus 30 m heights everywhere, GSI/OPW 2 m LiDAR along the coast where it exists, and OpenStreetMap (coastline, cliffs, roads and paths, land use). The build takes a few minutes and about 60 MB on disk; callouts never wait on it.</p>
        ${st.built ? `<table class="set-table"><tbody>
          <tr><th>Built</th><td>${fmtDT(st.builtAt!)}</td></tr>
          <tr><th>Area</th><td>${st.bbox!.map((v) => v.toFixed(2)).join(', ')} (lon/lat), ${st.size!.cols} × ${st.size!.rows} cells at ${st.cellM} m</td></tr>
          <tr><th>Heights on land</th><td>LiDAR ${fmtPct(st.coverage?.lidarPct)}, satellite ${fmtPct(st.coverage?.copernicusPct)}, none ${fmtPct(st.coverage?.nonePct)}</td></tr>
          <tr><th>Sea</th><td>${fmtPct(st.coverage?.seaPct)} of the grid</td></tr>
          <tr><th>Sources</th><td>${st.sources?.lidarTiles ?? 0} LiDAR tiles, ${esc(st.sources?.copernicusTiles.join(', ') ?? '')}, ${st.sources?.osmTiles ?? 0} OSM tiles${st.sources?.overpass ? ` via ${esc(st.sources.overpass)}` : ''}</td></tr>
        </tbody></table>` : '<p class="note warn">Not built yet: search areas fall back to plain circles until it is.</p>'}
        <div class="btn-row">
          <button class="btn-sm primary" data-act="build" ${running ? 'disabled' : ''}>${st.built ? 'Rebuild' : 'Build terrain data'}</button>
          <label class="small"><input type="checkbox" id="t-osm" ${running ? 'disabled' : ''}/> refetch OpenStreetMap</label>
          <label class="small"><input type="checkbox" id="t-lidar" ${running ? 'disabled' : ''}/> refetch LiDAR</label>
        </div>
        ${job ? `<p class="${job.error ? 'note error' : 'muted'}">${running ? `Building: ${esc(job.message)} (${job.pct} %)` : job.error ? `Last build failed: ${esc(job.error)}` : `Last build finished ${job.finishedAt ? fmtDT(job.finishedAt) : ''}`}</p>${job.log.length ? `<pre class="set-pre">${esc(job.log.slice(-15).join('\n'))}</pre>` : ''}` : ''}
        ${st.attribution?.length ? `<p class="muted small">${st.attribution.map(esc).join('<br/>')}</p>` : ''}
      </div>`;
    wire(el, {
      build: (b) => run(async () => {
        b.setAttribute('disabled', '');
        await post('/api/admin/terrain/build', { refreshOsm: (el.querySelector('#t-osm') as HTMLInputElement).checked, refreshLidar: (el.querySelector('#t-lidar') as HTMLInputElement).checked });
        toast('Terrain build started');
      }, load),
    });
    if (running && !timer) timer = window.setInterval(() => void load().catch(() => undefined), 2000);
    if (!running && timer) { clearInterval(timer); timer = undefined; }
  };
  await load();
}

// ------------------------------------------------------------------ audit log
async function auditSection(el: HTMLElement): Promise<void> {
  const names = new Map<number, string>();
  try {
    for (const u of (await get<{ users: UserPublic[] }>('/api/users')).users) names.set(u.id, u.name);
  } catch { /* names are optional */ }
  el.innerHTML = `<div class="set-head"><h2>Audit log</h2>
      <select id="au-range"><option value="1">Last 24 h</option><option value="7" selected>Last 7 days</option><option value="30">Last 30 days</option><option value="">All (last 1000)</option></select>
      <input id="au-filter" placeholder="Filter (action, name, target…)" />
      <button class="btn-sm" id="au-refresh">Refresh</button></div>
    <div id="au-table"><p class="muted">Loading…</p></div>`;
  const range = el.querySelector<HTMLSelectElement>('#au-range')!;
  const filter = el.querySelector<HTMLInputElement>('#au-filter')!;
  const table = el.querySelector<HTMLElement>('#au-table')!;
  let entries: AuditEntry[] = [];
  const draw = () => {
    const q = filter.value.trim().toLowerCase();
    const rows = entries.filter((e) => !q || [e.action, e.targetType, e.targetId, e.actorIp, names.get(e.actorUserId ?? -1), JSON.stringify(e.detail ?? '')].join(' ').toLowerCase().includes(q));
    table.innerHTML = `<table class="set-table"><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Target</th><th>Detail</th></tr></thead><tbody>
      ${rows.map((e) => `<tr><td class="nowrap">${fmtDT(e.at)}</td><td>${e.actorUserId ? esc(names.get(e.actorUserId) ?? `user ${e.actorUserId}`) : '<span class="muted">system</span>'}${e.actorIp ? `<div class="muted small">${esc(e.actorIp)}</div>` : ''}</td><td class="mono nowrap">${esc(e.action)}</td><td>${e.targetType ? `${esc(e.targetType)} ${esc(e.targetId ?? '')}` : ''}</td><td class="mono small">${e.detail ? esc(JSON.stringify(e.detail)) : ''}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">Nothing in this range.</td></tr>'}
      </tbody></table><p class="muted small">${rows.length} of ${entries.length} entries</p>`;
  };
  const load = async () => {
    const days = range.value ? Number(range.value) : undefined;
    const since = days ? new Date(Date.now() - days * 86400_000).toISOString() : undefined;
    entries = (await get<{ entries: AuditEntry[] }>(`/api/admin/audit?limit=1000${since ? `&since=${encodeURIComponent(since)}` : ''}`)).entries;
    draw();
  };
  range.addEventListener('change', () => load().catch((e) => toast(msg(e), true)));
  filter.addEventListener('input', draw);
  el.querySelector('#au-refresh')!.addEventListener('click', () => load().catch((e) => toast(msg(e), true)));
  await load();
}

// ------------------------------------------------------------------ system status
async function systemSection(el: HTMLElement): Promise<void> {
  const load = async () => {
    const h = await get<Health>('/healthz').catch((e) => (e instanceof ApiError ? ({ status: 'down', providers: undefined } as unknown as Health) : Promise.reject(e)));
    const s = cs.s.state;
    const providers = Object.values(h.providers ?? s?.providers ?? {});
    const cls: Record<string, string> = { ok: 'green', stale: 'amber', error: 'red', starting: 'blue', disabled: 'grey', stub: 'grey' };
    el.innerHTML = `<div class="set-head"><h2>System status</h2><button class="btn-sm" data-act="refresh">Refresh</button></div>
      <div class="set-card"><div class="kv">
        <span>Overall</span><b>${badge(h.status, cls[h.status === 'ok' ? 'ok' : h.status === 'degraded' ? 'stale' : 'error'])}</b>
        <span>Mode</span><b>${esc(h.mode ?? s?.mode.mode ?? '')}</b>
        <span>Version</span><b class="mono">${esc(s?.version ?? '')}</b>
        <span>Uptime</span><b>${h.uptimeSec !== undefined ? fmtUptime(h.uptimeSec) : '—'}</b>
        <span>Database</span><b>${esc(h.db ?? '—')}</b>
        <span>Connected clients</span><b>${h.wsClients ?? '—'}</b>
        <span>Position fixes / min</span><b>${h.fixesLastMin ?? '—'}</b>
        ${h.upstream ? `<span>Upstream</span><b>${esc(h.upstream)}</b>` : ''}
        <span>Station</span><b>${esc(s?.station.name ?? '')} ${s ? `(${s.station.lat.toFixed(3)}, ${s.station.lon.toFixed(3)})` : ''}</b>
      </div></div>
      <div class="set-card"><h3>Data feeds</h3>
      <table class="set-table"><thead><tr><th>Feed</th><th>Status</th><th>Last success</th><th>Failures</th><th>Poll</th><th>Note / last error</th></tr></thead><tbody>
      ${providers.map((p) => `<tr><td><b>${esc(p.name)}</b></td><td>${badge(p.status, cls[p.status] ?? 'grey')}</td><td>${p.lastSuccess ? fmtDT(p.lastSuccess) : '<span class="muted">—</span>'}</td><td>${p.consecutiveFailures || ''}</td><td>${Math.round(p.pollIntervalMs / 60000)} min</td><td class="small">${esc(p.note ?? '')}${p.lastError ? `<div class="amber">${esc(p.lastError)}</div>` : ''}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">No feed detail (sign in as a user to see providers).</td></tr>'}
      </tbody></table>
      <p class="muted small">Feed keys, panels and station settings live in <span class="mono">config.yaml</span> / <span class="mono">.env</span> on the server (see README → Configuration); restart the app container after changing them.</p></div>`;
    wire(el, { refresh: () => load().catch((e) => toast(msg(e), true)) });
  };
  await load();
}

// ------------------------------------------------------------------ my account
async function accountSection(el: HTMLElement): Promise<void> {
  const me = cs.s.me!;
  const load = async () => {
    el.innerHTML = `<div class="set-head"><h2>My account</h2></div>
      ${me.mustChangePassword ? '<div class="note warn">Your password was set by an admin. Choose your own before continuing.</div>' : ''}
      <div class="set-grid2">
      <div class="set-card"><h3>You</h3><div class="kv"><span>Name</span><b>${esc(me.name)}</b><span>Email</span><b>${esc(me.email)}</b><span>Role</span><b>${esc(me.role)}</b><span>Callsign</span><b>${esc(me.callsign ?? '—')}</b><span>Privacy notice</span><b>${me.privacyAcceptedAt ? `accepted ${fmtDT(me.privacyAcceptedAt)}` : '<span class="amber">not accepted</span>'}</b></div>
        ${me.privacyAcceptedAt ? '' : '<button class="btn-sm primary" data-act="privacy">Read & accept the privacy notice</button>'}
        <button class="btn-sm danger" data-act="logout">Sign out</button></div>
      <div class="set-card"><h3>Change password</h3>
        <form id="pf" class="set-col"><label>Current password <input name="current" type="password" autocomplete="current-password" required /></label>
        <label>New password (8+ characters) <input name="new" type="password" autocomplete="new-password" required minlength="8" /></label>
        <label>Repeat new password <input name="new2" type="password" autocomplete="new-password" required minlength="8" /></label>
        <button class="btn-sm primary" type="submit">Save password</button></form></div>
      </div>
      <div class="set-card"><h3>My phones (OwnTracks)</h3><div id="devs"><p class="muted">Loading…</p></div></div>`;
    el.querySelector<HTMLFormElement>('#pf')!.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const form = ev.target as HTMLFormElement;
      const f = Object.fromEntries(new FormData(form)) as Record<string, string>;
      if (f.new !== f.new2) return toast('Passwords do not match', true);
      run(async () => {
        await post('/api/auth/password', { current: f.current, new: f.new });
        me.mustChangePassword = false;
        form.reset();
        toast('Password changed');
      }, load);
    });
    wire(el, {
      logout: () => run(async () => { await post('/api/auth/logout'); location.href = '/sm/'; }),
      privacy: () => privacyModal(load),
      'add-device': () => deviceModal(loadDevices),
      revoke: (b) => confirmModal(`Revoke “${esc(b.dataset.name ?? '')}”?`, 'OwnTracks on that phone stops working until it is added again.', 'Revoke', async () => { await del(`/api/devices/${b.dataset.id}`); await loadDevices(); }, true),
    });
    await loadDevices();
  };
  const loadDevices = async () => {
    const box = el.querySelector<HTMLElement>('#devs')!;
    const { devices } = await get<{ devices: DevicePublic[] }>('/api/devices');
    const live = devices.filter((d) => !d.revokedAt);
    box.innerHTML = `<table class="set-table"><thead><tr><th>Phone</th><th>OwnTracks user</th><th>Tracker ID</th><th>Added</th><th>Last seen</th><th></th></tr></thead><tbody>
      ${live.map((d) => `<tr><td><b>${esc(d.name)}</b></td><td class="mono">${esc(d.username)}</td><td class="mono">${esc(d.tid)}</td><td>${fmtDT(d.createdAt)}</td><td>${d.lastSeenAt ? fmtDT(d.lastSeenAt) : '<span class="muted">never</span>'}</td><td class="acts"><button class="mini danger" data-act="revoke" data-id="${d.id}" data-name="${esc(d.name)}">Revoke</button></td></tr>`).join('') || '<tr><td colspan="6" class="muted">No phone linked. Your position only reaches the team once OwnTracks is installed and linked.</td></tr>'}
      </tbody></table><button class="btn-sm primary" data-act="add-device">+ Add a phone</button>`;
  };
  await load();
}

function deviceModal(reload: () => Promise<void>): void {
  const root = modal(`<h3>Add a phone</h3>
    <ol class="steps"><li>Install <b>OwnTracks</b> on the phone (App Store / Play Store).</li><li>Name it and press Create.</li><li>Scan the QR with OwnTracks, or open the link on the phone.</li><li>Allow location <b>Always</b>; on Android turn off battery optimisation for OwnTracks.</li></ol>
    <form id="df"><label>Phone name <input name="name" value="iPhone" required maxlength="40" autofocus /></label>
    <div class="modal-actions"><button type="button" class="btn-sm" id="cancel">Cancel</button><button type="submit" class="btn-sm primary">Create</button></div></form>`);
  root.querySelector('#cancel')!.addEventListener('click', closeModal);
  root.querySelector<HTMLFormElement>('#df')!.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const name = String(new FormData(ev.target as HTMLFormElement).get('name') ?? '');
    run(async () => {
      const d = await post<NewDevice>('/api/devices', { name });
      const cfg = d.otrc as { url: string; username: string; password: string; deviceId: string; tid: string };
      const r2 = modal(`<h3>${esc(d.device.name)} linked</h3>
        <div class="note warn">Shown once. If you lose it, revoke the phone and add it again.</div>
        <div class="dev-split"><div class="qr-box"><img src="/api/devices/${d.device.id}/qr.svg" alt="OwnTracks setup QR" /></div>
        <div class="kv small"><span>Mode</span><b>HTTP</b><span>URL</span><b class="mono">${esc(cfg.url)}</b><span>User ID</span><b class="mono">${esc(cfg.username)}</b><span>Password</span><b class="mono">${esc(cfg.password)}</b><span>Device ID</span><b class="mono">${esc(cfg.deviceId)}</b><span>Tracker ID</span><b class="mono">${esc(cfg.tid)}</b></div></div>
        <div class="modal-actions"><a class="btn-sm" href="/api/devices/${d.device.id}/config.otrc" download>Download .otrc</a><a class="btn-sm" href="${esc(d.configLink)}">Open in OwnTracks</a><button type="button" class="btn-sm primary" id="done">Done</button></div>`);
      r2.querySelector('#done')!.addEventListener('click', closeModal);
      await reload();
    });
  });
}

function privacyModal(reload: () => Promise<void>): void {
  const root = modal(`<h3>Privacy notice</h3>
    <p>This system is run by Howth Coast Guard for crew coordination during callouts.</p>
    <p><b>What is collected:</b> your name, email, callsign and role; whether you are responding to an incident and your ETA; and, while an incident is open and you are responding or in a search team, your phone's position (latitude, longitude, altitude, accuracy, speed, battery) sent by the OwnTracks app.</p>
    <p><b>Who sees it:</b> other logged-in crew during an incident, the search manager and station officers, and the station wall display.</p>
    <p><b>Retention:</b> incident records, team assignments and track points are kept as an operational record of the search. Your last known position is cleared after 24 hours of inactivity. You can ask the station admin to remove your account; it is anonymised and track points lose your name.</p>
    <p><b>Your choices:</b> tracking only runs when you press “I'm responding” or are placed in a team, and only while OwnTracks is installed and linked. You can revoke a phone at any time.</p>
    <p class="muted small">Controller: Howth Coast Guard Unit. Questions to the Officer in Charge.</p>
    <div class="modal-actions"><button type="button" class="btn-sm" id="cancel">Not now</button><button type="button" class="btn-sm primary" id="accept">I understand</button></div>`);
  root.querySelector('#cancel')!.addEventListener('click', closeModal);
  root.querySelector('#accept')!.addEventListener('click', () => run(async () => {
    await post('/api/auth/privacy-accept');
    if (cs.s.me) cs.s.me.privacyAcceptedAt = new Date().toISOString();
    closeModal();
  }, reload));
}

// ------------------------------------------------------------------ helpers
function confirmModal(title: string, text: string, action: string, fn: () => Promise<void>, danger = false): void {
  const root = modal(`<h3>${title}</h3><p class="muted">${text}</p><div class="modal-actions"><button type="button" class="btn-sm" id="cancel">Cancel</button><button type="button" class="btn-sm ${danger ? 'danger' : 'primary'}" id="ok" autofocus>${action}</button></div>`);
  root.querySelector('#cancel')!.addEventListener('click', closeModal);
  root.querySelector('#ok')!.addEventListener('click', () => run(async () => { await fn(); closeModal(); }));
}

/** Run an action, toast on failure, optionally reload the section afterwards. */
function run(fn: () => Promise<void>, after?: () => Promise<void>): void {
  fn()
    .then(() => after?.())
    .catch((e) => toast(msg(e), true));
}

/** Delegate [data-act] clicks inside root; re-wiring replaces the handler set, so sub-renders keep working. */
const wired = new WeakMap<HTMLElement, Record<string, (el: HTMLElement) => void>>();
function wire(root: HTMLElement, handlers: Record<string, (el: HTMLElement) => void>): void {
  if (!wired.has(root)) {
    root.addEventListener('click', (ev) => {
      const el = (ev.target as HTMLElement).closest<HTMLElement>('[data-act]');
      if (!el || !root.contains(el)) return;
      const h = wired.get(root)?.[el.dataset.act!];
      if (!h) return;
      ev.preventDefault();
      h(el);
    });
  }
  wired.set(root, handlers);
}
