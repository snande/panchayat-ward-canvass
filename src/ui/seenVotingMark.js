// "Seen voting" control for one voter on polling day, shown under the voter's
// contact panel or card when a voter is tapped in the ward roll
// (src/ui/rollSearch.js wires it).
//
// While the voter's mark is being read only a loading line shows. A voter
// with no mark gets one button; tapping it saves the mark through the
// seen-voting store (src/tally/seenVotingStore.js), which keeps it on the
// device and queues it for the team, so it works offline. A voter already
// marked, on this phone or by a teammate, shows that instead of the button,
// so the same voter is never offered twice: the mark is read again whenever
// the store reports added marks, until destroy() is called. The "saved" line
// shows only when the tap added a mark. If the mark cannot be read, a warning
// shows and the button stays (marking is safe to repeat). All text comes from
// the strings table.

import { el, setNotice } from './dom.js';

/**
 * Append the control to container (its other content stays).
 * @param {Element} container
 * @param {Record<string, string>} strings the Hindi string table
 * @param {{
 *   marks: {recordSeen: Function, getMark: Function, onMarksChanged?: Function},
 *   wardId: string, entry: {serial: number},
 *   workerId?: () => string | Promise<string>, log?: Function,
 * }} opts workerId names who marks the voter (defaults to 'device')
 * @returns {{root, button, status, message, ready: Promise<void>, mark: () => Promise<void>,
 *   destroy: () => void}}
 */
export function mountSeenVotingMark(container, strings, opts) {
  const doc = container.ownerDocument;
  const text = (key) => (strings && Object.prototype.hasOwnProperty.call(strings, key) ? strings[key] : '');
  const { marks, wardId, entry } = opts;
  const workerId = typeof opts.workerId === 'function' ? opts.workerId : () => 'device';
  const log = opts.log || ((...args) => console.error(...args));

  const root = el(doc, 'section', 'panel seen-voting');
  root.setAttribute('lang', 'hi');
  const status = el(doc, 'p', 'notice seen-voting-status');
  status.setAttribute('aria-live', 'polite');
  const button = el(doc, 'button', 'btn-primary seen-voting-mark', text('seen_mark_action'));
  button.setAttribute('type', 'button');
  const message = el(doc, 'p', 'notice seen-voting-message');
  message.setAttribute('aria-live', 'polite');
  root.appendChild(status);
  root.appendChild(button);
  root.appendChild(message);
  container.appendChild(root);

  // undefined: still reading; null: not marked; false: could not be read;
  // otherwise the mark.
  function showState(state) {
    button.hidden = state === undefined || Boolean(state);
    if (state === undefined) setNotice(status, text('seen_mark_loading'));
    else if (state === false) setNotice(status, text('seen_mark_read_failed'), 'error');
    else if (state) setNotice(status, text('seen_marked'), 'success');
    else setNotice(status, '');
  }

  // Later reads win over slower earlier ones.
  let readRequest = 0;
  async function read() {
    const request = ++readRequest;
    let state;
    try {
      state = (await marks.getMark(wardId, entry.serial)) || null;
    } catch (err) {
      log('seen-voting mark could not be read', err);
      state = false;
    }
    if (request === readRequest) showState(state);
  }

  let busy = false;
  async function mark() {
    if (busy) return;
    busy = true;
    button.setAttribute('disabled', '');
    setNotice(message, '');
    try {
      const result = await marks.recordSeen(wardId, entry.serial, await workerId());
      readRequest += 1;
      showState(result.mark);
      if (result.added) setNotice(message, text('seen_mark_saved'), 'success');
    } catch (err) {
      log('seen-voting mark could not be saved', err);
      setNotice(message, text('seen_mark_failed'), 'error');
    } finally {
      busy = false;
      button.removeAttribute('disabled');
    }
  }

  button.addEventListener('click', () => { mark(); });

  showState(undefined);
  const ready = read();

  // The mark may arrive from a teammate while this is open. A control that
  // has left the page stops listening.
  let unsubscribe = null;
  function destroy() {
    if (unsubscribe) unsubscribe();
    unsubscribe = null;
  }
  if (typeof marks.onMarksChanged === 'function') {
    unsubscribe = marks.onMarksChanged(() => {
      if (root.parentNode !== container) {
        destroy();
        return;
      }
      read();
    });
  }

  return { root, button, status, message, ready, mark, destroy };
}
