// "Seen voting" control for one voter on polling day, shown under the voter's
// contact panel or card when a voter is tapped in the ward roll
// (src/ui/rollSearch.js wires it).
//
// While the voter's mark is being read only a loading line shows. A voter
// with no mark gets one button; tapping it saves the mark through the
// seen-voting store (src/tally/seenVotingStore.js), which keeps it on the
// device and queues it for the team, so it works offline. A voter already
// marked, on this phone or by a teammate, shows that instead of the button,
// so the same voter is never offered twice. All text comes from the strings
// table.

import { el } from './dom.js';

/**
 * Append the control to container (its other content stays).
 * @param {Element} container
 * @param {Record<string, string>} strings the Hindi string table
 * @param {{
 *   marks: {markSeen: Function, getMark: Function},
 *   wardId: string, entry: {serial: number},
 *   workerId?: () => string | Promise<string>, log?: Function,
 * }} opts workerId names who marks the voter (defaults to 'device')
 * @returns {{root, button, status, message, ready: Promise<void>, mark: () => Promise<void>}}
 */
export function mountSeenVotingMark(container, strings, opts) {
  const doc = container.ownerDocument;
  const text = (key) => (strings && Object.prototype.hasOwnProperty.call(strings, key) ? strings[key] : '');
  const { marks, wardId, entry } = opts;
  const workerId = typeof opts.workerId === 'function' ? opts.workerId : () => 'device';
  const log = opts.log || ((...args) => console.error(...args));

  const root = el(doc, 'section', 'seen-voting');
  root.setAttribute('lang', 'hi');
  const status = el(doc, 'p', 'contact-body seen-voting-status');
  status.setAttribute('aria-live', 'polite');
  const button = el(doc, 'button', 'btn-primary seen-voting-mark', text('seen_mark_action'));
  button.setAttribute('type', 'button');
  const message = el(doc, 'p', 'picker-message seen-voting-message');
  message.setAttribute('aria-live', 'polite');
  root.appendChild(status);
  root.appendChild(button);
  root.appendChild(message);
  container.appendChild(root);

  // undefined: still reading; null: not marked; otherwise the mark.
  function showState(mark) {
    button.hidden = mark !== null;
    status.textContent = mark === undefined ? text('seen_mark_loading') : mark ? text('seen_marked') : '';
  }

  let busy = false;
  async function mark() {
    if (busy) return;
    busy = true;
    button.setAttribute('disabled', '');
    message.textContent = '';
    try {
      showState(await marks.markSeen(wardId, entry.serial, await workerId()));
      message.textContent = text('seen_mark_saved');
    } catch (err) {
      log('seen-voting mark could not be saved', err);
      message.textContent = text('seen_mark_failed');
    } finally {
      busy = false;
      button.removeAttribute('disabled');
    }
  }

  button.addEventListener('click', () => { mark(); });

  showState(undefined);
  const ready = Promise.resolve()
    .then(() => marks.getMark(wardId, entry.serial))
    .then((found) => showState(found || null), (err) => {
      log('seen-voting mark could not be read', err);
      showState(null);
    });

  return { root, button, status, message, ready, mark };
}
