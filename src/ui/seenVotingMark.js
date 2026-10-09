// "Seen voting" control for one voter on polling day, shown under the voter's
// contact panel or card when a voter is tapped in the ward roll
// (src/ui/rollSearch.js wires it).
//
// While the voter's mark is being read only a loading line shows. A voter
// with no mark gets one button; tapping it calls markSeen on the seen-voting
// store (src/tally/seenVotingStore.js), which keeps the mark on the device and
// queues it for the team, so it works offline. A voter already marked, on this
// phone or by a teammate, shows a "marked" badge in place of the button, so
// the same voter is never offered twice: the mark is read again whenever the
// store reports added marks, until destroy() is called. The "saved" line shows
// only when the tap made the mark: markSeen returns the voter's first mark,
// which names this worker only when this tap added it. If the mark cannot be
// read, a warning shows and the button stays (marking is safe to repeat).
//
// When the store offers teamCount(), a line under the action shows how many
// voters the team has marked as far as this phone knows. It is read again
// after every added mark, both this phone's and those a sync pull brings from
// teammates (the store reports both through onMarksChanged once they are
// stored). All text comes from the strings table.
//
// An entry struck off the roll (struck: true) is not a voter: the control
// offers no button and never calls markSeen, and an info notice says why;
// the team count line still shows.

import { el, setNotice } from './dom.js';

/**
 * Append the control to container (its other content stays).
 * @param {Element} container
 * @param {Record<string, string>} strings the Hindi string table
 * @param {{
 *   marks: {markSeen: Function, getMark: Function, teamCount?: Function, onMarksChanged?: Function},
 *   wardId: string, entry: {serial: number, struck?: boolean},
 *   workerId?: () => string | Promise<string>, log?: Function,
 * }} opts workerId names who marks the voter (defaults to 'device')
 * @returns {{root, button, badge, status, message, count: Element | null, countValue: Element | null,
 *   ready: Promise<void>, mark: () => Promise<void>, refreshCount: () => Promise<void>, destroy: () => void}}
 *   count is the team count line, null when the store has no teamCount
 */
export function mountSeenVotingMark(container, strings, opts) {
  const doc = container.ownerDocument;
  const text = (key) => (strings && Object.prototype.hasOwnProperty.call(strings, key) ? strings[key] : '');
  const { marks, wardId, entry } = opts;
  const struck = Boolean(entry && entry.struck === true);
  const workerId = typeof opts.workerId === 'function' ? opts.workerId : () => 'device';
  const log = opts.log || ((...args) => console.error(...args));

  const root = el(doc, 'section', 'panel seen-voting');
  root.setAttribute('lang', 'hi');
  if (struck) root.setAttribute('data-state', 'struck-off');
  const status = el(doc, 'p', 'notice seen-voting-status');
  status.setAttribute('aria-live', 'polite');
  const button = el(doc, 'button', 'btn-primary seen-voting-mark', text('seen_mark_action'));
  button.setAttribute('type', 'button');
  const badge = el(doc, 'p', 'badge seen-voting-badge', text('seen_marked'));
  badge.setAttribute('data-tone', 'success');
  const message = el(doc, 'p', 'notice seen-voting-message');
  message.setAttribute('aria-live', 'polite');
  root.appendChild(status);
  root.appendChild(button);
  root.appendChild(badge);
  root.appendChild(message);

  let count = null;
  let countValue = null;
  const counts = typeof marks.teamCount === 'function';
  if (counts) {
    count = el(doc, 'p', 'seen-voting-count');
    count.setAttribute('aria-live', 'polite');
    count.appendChild(el(doc, 'span', 'seen-voting-count-label', text('seen_team_count_label')));
    countValue = el(doc, 'span', 'seen-voting-count-value');
    count.appendChild(countValue);
    root.appendChild(count);
  }
  container.appendChild(root);

  // undefined: still reading; null: not marked; false: could not be read;
  // otherwise the mark.
  function showState(state) {
    if (struck) {
      button.hidden = true;
      badge.hidden = true;
      setNotice(status, text('seen_struck_off'), 'info');
      return;
    }
    const marked = Boolean(state);
    button.hidden = state === undefined || marked;
    badge.hidden = !marked;
    if (state === undefined) setNotice(status, text('seen_mark_loading'));
    else if (state === false) setNotice(status, text('seen_mark_read_failed'), 'error');
    else setNotice(status, '');
  }

  // A number, or the key of the placeholder shown instead of one.
  function showCount(value) {
    const known = Number.isSafeInteger(value) && value >= 0;
    countValue.textContent = known ? String(value) : text(value);
    countValue.setAttribute('class', known ? 'seen-voting-count-value' : 'seen-voting-count-value seen-voting-count-pending');
  }

  let countRequest = 0;
  async function refreshCount() {
    if (!counts) return;
    const request = ++countRequest;
    let value;
    try {
      value = await marks.teamCount();
    } catch (err) {
      log('team seen-voting count could not be read', err);
      value = null;
    }
    if (request !== countRequest) return;
    showCount(Number.isSafeInteger(value) && value >= 0 ? value : 'seen_team_count_failed');
  }

  // Later reads win over slower earlier ones.
  let readRequest = 0;
  async function read() {
    if (struck) return;
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
    if (busy || struck) return;
    busy = true;
    root.setAttribute('aria-busy', 'true');
    button.setAttribute('disabled', '');
    setNotice(message, '');
    try {
      const worker = await workerId();
      const marked = await marks.markSeen(wardId, entry.serial, worker);
      readRequest += 1;
      showState(marked || null);
      if (marked && marked.workerId === worker) setNotice(message, text('seen_mark_saved'), 'success');
    } catch (err) {
      log('seen-voting mark could not be saved', err);
      setNotice(message, text('seen_mark_failed'), 'error');
    } finally {
      busy = false;
      root.removeAttribute('aria-busy');
      button.removeAttribute('disabled');
    }
    await refreshCount();
  }

  button.addEventListener('click', () => { mark(); });

  showState(undefined);
  if (counts) showCount('seen_team_count_loading');
  const ready = Promise.all([read(), refreshCount()]).then(() => {});

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
      refreshCount();
    });
  }

  return { root, button, badge, status, message, count, countValue, ready, mark, refreshCount, destroy };
}
