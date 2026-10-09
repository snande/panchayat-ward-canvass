// The ward-roll screen: the frame's default screen (src/ui/appFrame.js).
//
// It renders from one `state` field, one state at a time (DESIGN.md "States
// every surface carries"), with shared controls only:
//   empty   no ward loaded: an info notice telling the user to pick a ward;
//           opts.emptyCard (index.html's "not loaded yet" card) shows only here
//   loading the roll is being read, downloaded or decoded: a progress bar and
//           a Hindi status line (detail.phase 'download' or 'decode')
//   filled  the roll is loaded: detail.render(container) mounts the list
//           (src/ui/rollSearch.js, whose rows are .list-row lines showing
//           serial, name, relative, age, gender and house)
//   error   the download or decode failed (detail.fetchFailed tells which):
//           an error notice saying what to do, a line saying whom to call and
//           a secondary retry button that calls detail.retry
// src/roll/rollFlow.js drives the field from its fetchRoll and decode steps.
// The whom-to-call line is opts.support (config/constituency.json's
// supportContact, set by js/picker.js) or the neutral "contact your
// coordinator" line; no phone number is made up here.

import { el } from './dom.js';

export const ROLL_STATES = Object.freeze(['empty', 'loading', 'filled', 'error']);

// Copies of src/strings.hi.json entries, used when the caller passes no string
// table; test/wardRollScreen.test.js fails if they drift.
export const FALLBACK_TEXT = {
  roll_pick_ward: 'मतदाता सूची देखने के लिए ऊपर अपना ज़िला, पंचायत और वार्ड चुनें।',
  roll_loading: 'मतदाता सूची डाउनलोड हो रही है…',
  roll_decoding: 'मतदाता सूची पढ़ी जा रही है…',
  roll_progress_label: 'मतदाता सूची लोड हो रही है',
  roll_fetch_failed: 'मतदाता सूची डाउनलोड नहीं हो सकी। इंटरनेट जाँचें और फिर से कोशिश करें।',
  roll_failed: 'मतदाता सूची खोली नहीं जा सकी। फिर से कोशिश करें।',
  roll_error_contact: 'फिर भी न खुले तो अपने समन्वयक से संपर्क करें।',
  roll_retry: 'फिर से कोशिश करें',
};

/**
 * @param {Element} container the roll section the states render into
 * @param {Record<string,string>|null} strings the Hindi string table
 * @param {{emptyCard?: Element, support?: string, onState?: (state: string) => void}} [opts]
 * @returns {{state: string|null, list: object|null, setState: (state: string, detail?: object) => object|null,
 *   setSupport: (text: string) => void}}
 */
export function createWardRollScreen(container, strings, opts = {}) {
  const doc = container.ownerDocument;
  const has = (table, key) => Boolean(table) && Object.prototype.hasOwnProperty.call(table, key) && table[key];
  const text = (key) => (has(strings, key) ? strings[key] : FALLBACK_TEXT[key] || '');
  let state = null;
  let list = null;
  let support = typeof opts.support === 'string' ? opts.support.trim() : '';

  function unmountList() {
    if (list && typeof list.destroy === 'function') list.destroy();
    list = null;
  }

  function notice(className, key, tone, role) {
    const p = el(doc, 'p', `notice ${className}`, text(key));
    p.setAttribute('data-tone', tone);
    p.setAttribute('role', role);
    return p;
  }

  function renderEmpty() {
    return [notice('roll-message roll-empty', 'roll_pick_ward', 'info', 'status')];
  }

  function renderLoading(detail) {
    const box = el(doc, 'div', 'roll-loading');
    const progress = el(doc, 'div', 'progress');
    progress.setAttribute('role', 'progressbar');
    progress.setAttribute('aria-label', text('roll_progress_label'));
    progress.appendChild(el(doc, 'span', 'progress-bar'));
    box.appendChild(progress);
    box.appendChild(notice('roll-message', detail.phase === 'decode' ? 'roll_decoding' : 'roll_loading', 'info', 'status'));
    return [box];
  }

  function renderError(detail) {
    const box = el(doc, 'div', 'roll-error');
    box.appendChild(notice('roll-message', detail.fetchFailed ? 'roll_fetch_failed' : 'roll_failed', 'error', 'alert'));
    box.appendChild(el(doc, 'p', 'roll-contact', support || text('roll_error_contact')));
    const retry = el(doc, 'button', 'btn-secondary roll-retry', text('roll_retry'));
    retry.setAttribute('type', 'button');
    if (typeof detail.retry === 'function') retry.addEventListener('click', () => detail.retry());
    box.appendChild(retry);
    return [box];
  }

  /** Move to `next` and render it; for 'filled' returns the mounted list. */
  function setState(next, detail = {}) {
    if (!ROLL_STATES.includes(next)) throw new TypeError(`unknown ward-roll state: ${next}`);
    unmountList();
    if (next === 'filled') {
      container.replaceChildren();
      list = typeof detail.render === 'function' ? detail.render(container) || null : null;
    } else if (next === 'loading') {
      container.replaceChildren(...renderLoading(detail));
    } else if (next === 'error') {
      container.replaceChildren(...renderError(detail));
    } else {
      container.replaceChildren(...renderEmpty());
    }
    container.removeAttribute('hidden');
    if (opts.emptyCard) opts.emptyCard.hidden = next !== 'empty';
    state = next;
    if (typeof opts.onState === 'function') opts.onState(next);
    return list;
  }

  return {
    get state() { return state; },
    get list() { return list; },
    setState,
    /** The whom-to-call line of the error state; blank keeps the neutral line. */
    setSupport(value) {
      support = typeof value === 'string' ? value.trim() : '';
    },
  };
}
