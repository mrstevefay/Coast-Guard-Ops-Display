import { CONTACT_ROLES, CONTACT_ROLE_LABEL, PRIVATE_CONTACT_ROLES, type ContactLogEntry, type ContactRole, type IncidentContact, type StationContact } from '../../../shared/types';
import { del, get, patch, post } from '../api';
import { esc, fmtTime } from '../format';
import { toast } from '../m/ui';
import { confirmBox } from './modal';
import { cs } from './state';

/**
 * The incident's contacts panel: agencies and people involved (Gardaí, MRCC, next of kin…), each
 * one click from the station directory, and a call log written while on the phone. Lists redraw
 * when the data changes; the forms never do, so nothing typed is lost.
 */
let el: HTMLElement | undefined;
let open = false;
let data: { incidentId: string; rev?: string; contacts: IncidentContact[]; log: ContactLogEntry[] } | undefined;
let directory: StationContact[] = [];
let adding: { role: ContactRole; editId?: number } | undefined;
let loading = false;

const QUICK: ContactRole[] = ['garda', 'mrcc', 'nok', 'reporter'];
const isPrivate = (r: ContactRole) => PRIVATE_CONTACT_ROLES.includes(r);

export function contactsOpen(): boolean {
  return open;
}

/** Number of contacts for the top-bar button, from the snapshot's revision ("count.maxId:logCount"). */
export function contactsCount(): number {
  const rev = cs.s.search?.incident?.contactsRev;
  return rev ? Number(rev.split('.')[0]) || 0 : 0;
}

export function toggleContacts(): void {
  open = !open;
  if (!el) {
    el = document.createElement('aside');
    el.className = 'contacts-panel';
    el.id = 'contacts-panel';
    document.getElementById('sm-map-wrap')!.appendChild(el);
  }
  el.hidden = !open;
  document.getElementById('sm-map-wrap')!.classList.toggle('contacts-open', open);
  if (open) {
    build();
    void refresh(true);
  }
}

/** Called on every snapshot: refetch when another console changed something. */
export function contactsOnUpdate(): void {
  if (!open) return;
  const inc = cs.s.search?.incident;
  if (!inc) { toggleContacts(); return; }
  if (!data || data.incidentId !== inc.id || data.rev !== inc.contactsRev) void refresh(false);
}

async function refresh(withDirectory: boolean): Promise<void> {
  const inc = cs.s.search?.incident;
  if (!inc || loading) return;
  loading = true;
  try {
    const r = await get<{ contacts: IncidentContact[]; log: ContactLogEntry[] }>(`/api/incidents/${inc.id}/contacts`);
    data = { incidentId: inc.id, rev: cs.s.search?.incident?.contactsRev, contacts: r.contacts, log: r.log };
    if (withDirectory) directory = (await get<{ contacts: StationContact[] }>('/api/contacts')).contacts;
    renderLists();
  } catch (e) {
    toast(e instanceof Error ? e.message : 'could not load contacts', true);
  } finally {
    loading = false;
  }
}

function build(): void {
  if (!el) return;
  el.innerHTML = `<div class="ct-head"><b>Contacts</b><span class="muted small">Managers only. Never on the TV or crew phones.</span><button class="mini" id="ct-close" title="Close">×</button></div>
    <div class="ct-add">
      <div class="ct-adds">${QUICK.map((r) => `<button class="pt-add" data-ct-add="${r}">+ ${esc(CONTACT_ROLE_LABEL[r])}</button>`).join('')}
        <select id="ct-more"><option value="">+ Other…</option>${CONTACT_ROLES.filter((r) => !QUICK.includes(r)).map((r) => `<option value="${r}">${esc(CONTACT_ROLE_LABEL[r])}</option>`).join('')}</select></div>
      <select id="ct-dir"><option value="">Add from station contacts…</option></select>
      <form id="ct-form" class="ct-form" hidden></form>
    </div>
    <div class="ct-list" id="ct-list"><p class="muted small">Loading…</p></div>
    <div class="ct-k">Call log</div>
    <form class="ct-logform" id="ct-logform">
      <div class="ct-dir-btns">${[['out', 'Called them'], ['in', 'They called'], ['note', 'Note']].map(([v, l], i) => `<label class="opt"><input type="radio" name="direction" value="${v}" ${i === 0 ? 'checked' : ''} /><span>${l}</span></label>`).join('')}</div>
      <select name="contactId" id="ct-who"><option value="">No contact</option></select>
      <div class="ct-logrow"><input name="text" id="ct-text" maxlength="1000" placeholder="What was said" autocomplete="off" /><button class="btn-sm primary" type="submit">Log</button></div>
    </form>
    <div class="ct-log" id="ct-log"></div>`;
  el.querySelector('#ct-close')!.addEventListener('click', toggleContacts);
  el.querySelectorAll<HTMLButtonElement>('[data-ct-add]').forEach((b) => b.addEventListener('click', () => showForm({ role: b.dataset.ctAdd as ContactRole })));
  el.querySelector<HTMLSelectElement>('#ct-more')!.addEventListener('change', (ev) => { const s = ev.target as HTMLSelectElement; if (s.value) showForm({ role: s.value as ContactRole }); s.value = ''; });
  el.querySelector<HTMLSelectElement>('#ct-dir')!.addEventListener('change', async (ev) => {
    const s = ev.target as HTMLSelectElement;
    const inc = cs.s.search?.incident;
    if (!s.value || !inc) return;
    try {
      // copy the station contact in, then ask straight away for who answered and their reference
      const r = await post<{ contact: IncidentContact }>(`/api/incidents/${inc.id}/contacts`, { directoryId: Number(s.value) });
      await refresh(false);
      showForm({ role: r.contact.role, editId: r.contact.id });
    } catch (e) {
      toast(e instanceof Error ? e.message : 'failed', true);
    }
    s.value = '';
  });
  el.querySelector<HTMLFormElement>('#ct-logform')!.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const inc = cs.s.search?.incident;
    const form = ev.target as HTMLFormElement;
    const f = new FormData(form);
    if (!inc || !String(f.get('text') ?? '').trim()) return;
    try {
      await post(`/api/incidents/${inc.id}/contact-log`, { direction: f.get('direction'), contactId: f.get('contactId') ? Number(f.get('contactId')) : null, text: f.get('text') });
      (form.querySelector('#ct-text') as HTMLInputElement).value = '';
      await refresh(false);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'failed', true);
    }
  });
}

/** The add / edit form, in place under the add buttons. Enter saves, Escape cancels. */
function showForm(a: { role: ContactRole; editId?: number }): void {
  const form = el?.querySelector<HTMLFormElement>('#ct-form');
  if (!form) return;
  adding = a;
  const cur = a.editId ? data?.contacts.find((c) => c.id === a.editId) : undefined;
  const priv = isPrivate(a.role);
  const v = (k: keyof IncidentContact) => esc((cur?.[k] as string | undefined) ?? '');
  form.hidden = false;
  form.innerHTML = `<div class="ct-k">${cur ? 'Edit' : 'Add'}: ${esc(CONTACT_ROLE_LABEL[a.role])}</div>
    <input name="name" maxlength="120" required placeholder="${priv ? 'Name, and relationship, e.g. Mary Byrne (wife)' : 'Who you spoke to, e.g. Garda Byrne'}" value="${v('name')}" />
    ${priv ? '' : `<input name="organisation" maxlength="120" placeholder="Organisation or station" value="${v('organisation')}" />`}
    <input name="phone" maxlength="40" inputmode="tel" placeholder="Phone" value="${v('phone')}" />
    ${priv ? '' : `<input name="reference" maxlength="80" placeholder="Their reference, e.g. PULSE or incident number" value="${v('reference')}" />`}
    <input name="notes" maxlength="500" placeholder="Notes (optional)" value="${v('notes')}" />
    <div class="ct-form-actions"><button class="btn-sm primary" type="submit">Save</button><button class="btn-sm" type="button" id="ct-cancel">Cancel</button><span class="muted small">Enter saves</span></div>`;
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const inc = cs.s.search?.incident;
    if (!inc || !adding) return;
    const f = Object.fromEntries(new FormData(form)) as Record<string, string>;
    try {
      if (adding.editId) await patch(`/api/incident-contacts/${adding.editId}`, f);
      else await post(`/api/incidents/${inc.id}/contacts`, { role: adding.role, ...f });
      hideForm();
      await refresh(false);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'failed', true);
    }
  };
  form.querySelector('#ct-cancel')!.addEventListener('click', hideForm);
  form.onkeydown = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); hideForm(); } };
  (form.querySelector('input[name=name]') as HTMLInputElement).focus();
  if (cur) (form.querySelector('input[name=name]') as HTMLInputElement).select();
}

function hideForm(): void {
  const form = el?.querySelector<HTMLFormElement>('#ct-form');
  if (form) { form.hidden = true; form.innerHTML = ''; }
  adding = undefined;
}

function renderLists(): void {
  if (!el || !data) return;
  const list = el.querySelector<HTMLElement>('#ct-list')!;
  const dir = el.querySelector<HTMLSelectElement>('#ct-dir')!;
  dir.innerHTML = `<option value="">${directory.length ? 'Add from station contacts…' : 'No station contacts yet (Settings → Station contacts)'}</option>${directory.map((d) => `<option value="${d.id}">${esc(CONTACT_ROLE_LABEL[d.role])}: ${esc(d.name)}</option>`).join('')}`;
  list.innerHTML = data.contacts.length
    ? data.contacts.map((c) => `<div class="ct-row ${isPrivate(c.role) ? 'private' : ''}" data-id="${c.id}">
        <div class="ct-main"><div><span class="ct-role r-${c.role}">${esc(CONTACT_ROLE_LABEL[c.role])}</span> <b>${esc(c.name)}</b></div>${c.organisation ? `<div class="muted small">${esc(c.organisation)}</div>` : ''}
          ${c.phone ? `<div class="ct-phone"><a href="tel:${esc(c.phone.replace(/[^+0-9]/g, ''))}">${esc(c.phone)}</a> <button class="mini" data-copy="${esc(c.phone)}" title="Copy">Copy</button></div>` : ''}
          ${c.reference ? `<div class="small">Ref <b>${esc(c.reference)}</b></div>` : ''}${c.notes ? `<div class="muted small">${esc(c.notes)}</div>` : ''}</div>
        <div class="ct-acts">${c.redactedAt ? '<span class="muted small">cleared</span>' : `<button class="mini" data-log="${c.id}">Log call</button><button class="mini" data-edit="${c.id}">Edit</button><button class="mini danger" data-del="${c.id}" title="Remove">×</button>`}</div>
      </div>`).join('')
    : '<p class="muted small">No contacts yet. Add the Gardaí and the next of kin first.</p>';
  list.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(b.dataset.copy!); toast('Number copied'); } catch { toast('Copy not allowed here', true); }
  }));
  list.querySelectorAll<HTMLButtonElement>('[data-edit]').forEach((b) => b.addEventListener('click', () => { const c = data!.contacts.find((x) => x.id === Number(b.dataset.edit)); if (c) showForm({ role: c.role, editId: c.id }); }));
  list.querySelectorAll<HTMLButtonElement>('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    const c = data!.contacts.find((x) => x.id === Number(b.dataset.del));
    if (!c || !(await confirmBox(`Remove ${c.name} from this incident?`, 'Remove'))) return;
    await del(`/api/incident-contacts/${c.id}`);
    await refresh(false);
  }));
  list.querySelectorAll<HTMLButtonElement>('[data-log]').forEach((b) => b.addEventListener('click', () => {
    const who = el!.querySelector<HTMLSelectElement>('#ct-who')!;
    who.value = b.dataset.log!;
    el!.querySelector<HTMLInputElement>('#ct-text')!.focus();
  }));
  // who-select keeps its choice across redraws
  const who = el.querySelector<HTMLSelectElement>('#ct-who')!;
  const keep = who.value;
  who.innerHTML = `<option value="">No contact</option>${data.contacts.filter((c) => !c.redactedAt).map((c) => `<option value="${c.id}">${esc(c.name)} · ${esc(CONTACT_ROLE_LABEL[c.role])}</option>`).join('')}`;
  who.value = data.contacts.some((c) => String(c.id) === keep) ? keep : '';
  const byId = new Map(data.contacts.map((c) => [c.id, c]));
  const arrow = { in: '←', out: '→', note: '•' } as const;
  el.querySelector<HTMLElement>('#ct-log')!.innerHTML = data.log.length
    ? [...data.log].reverse().map((l) => `<div class="ct-entry"><span class="muted small">${fmtTime(l.at)}</span> <span class="ct-arrow" title="${l.direction === 'in' ? 'They called' : l.direction === 'out' ? 'We called' : 'Note'}">${arrow[l.direction]}</span> ${l.contactId && byId.get(l.contactId) ? `<b>${esc(byId.get(l.contactId)!.name)}</b>: ` : ''}${esc(l.text)}${l.byName ? ` <span class="muted small">· ${esc(l.byName)}</span>` : ''}</div>`).join('')
    : '<p class="muted small">Log each call as you make it: it goes into the timeline and the report.</p>';
}
