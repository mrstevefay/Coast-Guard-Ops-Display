import { FOUND_BY_LABEL, FOUND_LOCATIONS, OUTCOME_KINDS, OUTCOME_LABEL, type FoundBy, type IncidentOutcome, type OutcomeKind, type PlanningPointRow } from '../../../shared/types';
import { put } from '../api';
import { esc } from '../format';
import { toast } from '../m/ui';
import { closeModal, modal } from './modal';

const FOUND: OutcomeKind[] = ['found-well', 'found-injured', 'found-deceased'];
const LOCATION_LABEL: Record<string, string> = { 'Open Ground': 'Open ground', 'Travel Aid': 'Road or path', 'Linear Feature': 'Stream or ditch', Trees: 'Woods or scrub', Water: 'Water or water’s edge', Habitation: 'Building or garden', Other: 'Other' };

/**
 * How the incident ended: outcome, and if found, where, by whom and when. Asked when a tasking is
 * closed (`closing`), editable later from History. The record builds the Irish evidence base:
 * distance from the planning point and where people are found, by category.
 */
export function openOutcome(opts: { incidentId: string; points: PlanningPointRow[]; existing?: IncidentOutcome; closing?: { label: string; close: () => Promise<void> }; onSaved?: () => void }): void {
  const ex = opts.existing;
  const finds = opts.points.filter((p) => p.kind === 'find');
  const subjectFind = finds.find((p) => /^Subject found/.test(p.label ?? ''));
  const local = (iso?: string) => { const d = iso ? new Date(iso) : new Date(); const pad = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const radio = (name: string, value: string, label: string, on: boolean) => `<label class="opt"><input type="radio" name="${name}" value="${esc(value)}" ${on ? 'checked' : ''} /><span>${esc(label)}</span></label>`;
  const posOptions = [
    ...finds.map((p) => ({ v: `${p.lat},${p.lon}`, l: `${p.label ?? 'Find'} (${p.lat.toFixed(4)}, ${p.lon.toFixed(4)})` })),
    ...(ex?.lat !== undefined && ex.lon !== undefined && !finds.some((p) => Math.abs(p.lat - ex.lat!) < 1e-6) ? [{ v: `${ex.lat},${ex.lon}`, l: `As recorded (${ex.lat.toFixed(4)}, ${ex.lon.toFixed(4)})` }] : []),
  ];
  const defPos = ex?.lat !== undefined ? `${ex.lat},${ex.lon}` : subjectFind ? `${subjectFind.lat},${subjectFind.lon}` : '';
  const root = modal(`<h3>${opts.closing ? `${esc(opts.closing.label)}: how did it end?` : 'Outcome'}</h3>
    <form class="oc-form" id="oc-form">
      <div class="oc-opts">${OUTCOME_KINDS.map((k) => radio('outcome', k, OUTCOME_LABEL[k], (ex?.outcome ?? (subjectFind ? 'found-well' : '')) === k)).join('')}</div>
      <div class="oc-found" id="oc-found">
        <div class="k">Where found</div>
        <div class="oc-opts">${FOUND_LOCATIONS.map((l) => radio('locationType', l, LOCATION_LABEL[l], ex?.locationType === l)).join('')}</div>
        <div class="k">Found by</div>
        <div class="oc-opts">${(Object.keys(FOUND_BY_LABEL) as FoundBy[]).map((k) => radio('foundBy', k, FOUND_BY_LABEL[k], ex?.foundBy === k)).join('')}</div>
        <div class="oc-line"><label>When <input type="datetime-local" name="foundAt" value="${local(ex?.foundAt ?? subjectFind?.setAt)}" /></label>
          <label>Where <select name="pos"><option value="">${posOptions.length ? 'Not recorded' : 'No find reported: not recorded'}</option>${posOptions.map((o) => `<option value="${esc(o.v)}" ${o.v === defPos ? 'selected' : ''}>${esc(o.l)}</option>`).join('')}</select></label></div>
      </div>
      <label>Notes <textarea name="notes" rows="2" maxlength="1000" placeholder="Anything that would help plan the next search like this one">${esc(ex?.notes ?? '')}</textarea></label>
      <p class="muted small">Anonymised outcomes (category, age band, distance, where found) build the Irish evidence base. Names, positions and notes stay in the incident record.</p>
      <div class="modal-actions">
        <button type="button" class="btn-sm" id="oc-cancel">Cancel</button>
        ${opts.closing ? `<button type="button" class="btn-sm" id="oc-skip">${esc(opts.closing.label)} without recording</button>` : ''}
        <button type="submit" class="btn-sm ${opts.closing ? 'danger' : 'primary'}">${opts.closing ? `Record and ${esc(opts.closing.label.toLowerCase())}` : 'Save'}</button>
      </div>
    </form>`);
  const form = root.querySelector<HTMLFormElement>('#oc-form')!;
  const found = root.querySelector<HTMLElement>('#oc-found')!;
  const sync = () => { found.hidden = !FOUND.includes(String(new FormData(form).get('outcome') ?? '') as OutcomeKind); };
  form.addEventListener('change', sync);
  sync();
  root.querySelector('#oc-cancel')!.addEventListener('click', closeModal);
  root.querySelector('#oc-skip')?.addEventListener('click', async () => {
    try { await opts.closing!.close(); closeModal(); } catch (e) { toast(e instanceof Error ? e.message : 'failed', true); }
  });
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = new FormData(form);
    const outcome = String(f.get('outcome') ?? '');
    if (!outcome) return toast('Choose how it ended', true);
    const isFound = FOUND.includes(outcome as OutcomeKind);
    const [lat, lon] = String(f.get('pos') ?? '').split(',').map(Number);
    try {
      await put(`/api/incidents/${opts.incidentId}/outcome`, {
        outcome,
        notes: f.get('notes'),
        locationType: isFound ? f.get('locationType') || null : null,
        foundBy: isFound ? f.get('foundBy') || null : null,
        foundAt: isFound && f.get('foundAt') ? new Date(String(f.get('foundAt'))).toISOString() : null,
        lat: isFound && Number.isFinite(lat) ? lat : null,
        lon: isFound && Number.isFinite(lon) ? lon : null,
      });
      if (opts.closing) await opts.closing.close();
      closeModal();
      toast(opts.closing ? 'Outcome recorded' : 'Outcome saved');
      opts.onSaved?.();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'failed', true);
    }
  });
}
