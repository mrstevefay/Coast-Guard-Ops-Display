import { pushAlerts } from '../push';
import { btn, toast, wireActions } from '../ui';

const WHAT = 'A notification when a callout is raised or stood down, and when your team is given a target. It backs up your pager; it does not replace it.';
const INSTALL = 'On iPhone and iPad, alerts work once the app is on your Home Screen: tap <b>Share</b>, then <b>Add to Home Screen</b>, and open the app from there.';

/** Status page: a one-off offer to turn alerts on (until answered on this phone). */
export function alertsOffer(): string {
  if (!pushAlerts.shouldOffer) return '';
  const install = pushAlerts.state === 'needs-install';
  return `<section class="card alerts-offer">
    <h2>Callout alerts on this phone</h2>
    <p>${install ? INSTALL : WHAT}</p>
    <div class="btn-row">${install ? '' : `<button class="btn primary" data-action="alerts-on" ${pushAlerts.busy ? 'disabled' : ''}>Turn on alerts</button>`}${btn('Not now', 'alerts-dismiss', 'ghost small')}</div>
  </section>`;
}

/** More page: where alerts stand on this phone, with on, off and a test. */
export function alertsCard(): string {
  const s = pushAlerts.state;
  const body =
    s === 'on' ? `<p><span class="badge-s green">on</span> This phone gets callout alerts.</p><div class="btn-row">${btn('Send a test alert', 'alerts-test', 'primary')}${btn('Turn off', 'alerts-off', 'ghost')}</div>`
    : s === 'off' ? `<p>${WHAT}</p><div class="btn-row"><button class="btn primary" data-action="alerts-on" ${pushAlerts.busy ? 'disabled' : ''}>Turn on alerts</button></div>`
    : s === 'needs-install' ? `<p>${INSTALL} Then come back here and turn alerts on.</p>`
    : s === 'blocked' ? '<p class="note warn">Alerts are blocked for this app. Allow notifications for it in the phone’s settings, then reopen the app.</p>'
    : '<p class="note muted">This browser cannot show alerts. Use Chrome on Android, or the app on your Home Screen on iPhone.</p>';
  return `<section class="card" id="alerts"><h2>Callout alerts</h2>${body}</section>`;
}

export function wireAlerts(root: HTMLElement): void {
  wireActions(root, {
    'alerts-on': async () => {
      const problem = await pushAlerts.enable();
      toast(problem ?? (pushAlerts.state === 'on' ? 'Alerts are on for this phone' : 'Alerts not turned on'), Boolean(problem));
    },
    'alerts-off': async () => {
      await pushAlerts.disable();
      toast('Alerts turned off for this phone');
    },
    'alerts-test': async () => {
      const r = await pushAlerts.test();
      toast(r.sent ? 'Test alert sent: it should arrive in a few seconds' : 'The test could not be sent. Turn alerts off and on again.', !r.sent);
    },
    'alerts-dismiss': () => pushAlerts.dismiss(),
  });
}
