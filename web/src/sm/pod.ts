import { POD_LEVELS } from '../../../shared/searchtheory';
import type { Target, TargetCoverage } from '../../../shared/types';
import { get } from '../api';
import { esc } from '../format';
import { toast } from '../m/ui';
import { closeModal, modal } from './modal';

/**
 * Ask how thorough a finished search was: four plain levels, with what the team's tracks
 * suggest when there are any. The answer is the probability of detection (POD).
 */
export async function askPod(t: Target, save: (pod: number) => Promise<void>): Promise<void> {
  let cov: TargetCoverage | undefined;
  if (t.kind === 'area' && t.teamId) cov = await get<{ coverage: TargetCoverage }>(`/api/targets/${t.id}/coverage`).then((r) => r.coverage).catch(() => undefined);
  const hint = cov && cov.trackM > 0
    ? `<p class="small">The team walked <b>${(cov.trackM / 1000).toFixed(1)} km</b> inside it at ${cov.sweepEachSideM} m each side: coverage ${cov.coverage}, which suggests about <b>${Math.round(cov.pod * 100)} %</b>.</p>`
    : '<p class="small muted">No tracks inside this area to go on: use the team leader’s judgement.</p>';
  const root = modal(`<h3>${esc(t.name)}: how thorough was it?</h3>
    <p class="muted small">The chance this search would have found the person if they were there. It moves probability to the areas not yet searched.</p>
    ${hint}
    <div class="pod-levels">${POD_LEVELS.map((l) => `<button type="button" class="btn-sm ${cov && Math.abs(cov.pod - l.pod) < 0.1 ? 'primary' : ''}" data-pod="${l.pod}"><b>${esc(l.label)}</b><small>${Math.round(l.pod * 100)} %</small></button>`).join('')}</div>
    ${cov && cov.trackM > 0 ? `<button type="button" class="btn-sm" data-pod="${cov.pod}">Use the track estimate, ${Math.round(cov.pod * 100)} %</button>` : ''}
    <div class="modal-actions"><button type="button" class="btn-sm" id="pod-cancel">Cancel</button></div>`);
  root.querySelector('#pod-cancel')!.addEventListener('click', closeModal);
  root.querySelectorAll<HTMLButtonElement>('[data-pod]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      await save(Number(b.dataset.pod));
      closeModal();
      toast(`${t.name} searched, POD ${Math.round(Number(b.dataset.pod) * 100)} %`);
    } catch (e) {
      b.disabled = false;
      toast(e instanceof Error ? e.message : 'failed', true);
    }
  }));
}
