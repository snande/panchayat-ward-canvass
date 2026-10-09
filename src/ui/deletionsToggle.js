// The supplementary-deletions toggle above the ward roll: entries tagged
// supplement: 'deletion' are hidden unless it is on. One state at a time
// (DESIGN.md "States every surface carries"), shared controls only:
//   filled  a .choice row (DESIGN.md "Checkbox / toggle", 48 px) with the
//           number of supplementary deletions
//   empty   info notice: no supplementary roll is published; not an error
//   error   a supplement failed (the roll still shows): error notice to
//           retry, whom to call, and a secondary retry
// It only hides and shows rows; it deletes nothing.

import { el, textFrom } from './dom.js';

export const TOGGLE_STATES = Object.freeze(['filled', 'empty', 'error']);

// Copies of src/strings.hi.json entries, used when the caller passes no string
// table; test/deletionsToggle.test.js fails if they drift.
export const FALLBACK_TEXT = {
  supp_show_deletions: 'पूरक सूची में हटाए गए नाम दिखाएँ',
  supp_no_deletions: 'इस वार्ड की कोई पूरक सूची प्रकाशित नहीं हुई है, इसलिए हटाए गए नाम नहीं हैं।',
  supp_failed: 'पूरक सूची डाउनलोड नहीं हो सकी। मूल सूची दिख रही है। फिर से कोशिश करें।',
  roll_error_contact: 'फिर भी न खुले तो अपने समन्वयक से संपर्क करें।',
  roll_retry: 'फिर से कोशिश करें',
};

/**
 * @param {Element} container where the toggle goes (its content is replaced)
 * @param {Record<string,string>|null} strings the Hindi string table
 * @param {{state: 'filled'|'empty'|'error', deletions?: number, checked?: boolean,
 *   onChange?: (checked: boolean) => void, onRetry?: () => void, support?: string}} opts
 * @returns {{root: Element, state: string, input: Element|null, retry: Element|null}}
 */
export function mountDeletionsToggle(container, strings, opts) {
  const doc = container.ownerDocument;
  const text = textFrom(strings, FALLBACK_TEXT);
  const state = opts && opts.state;
  if (!TOGGLE_STATES.includes(state)) throw new TypeError(`unknown deletions-toggle state: ${state}`);
  const root = el(doc, 'div', 'roll-supplement');
  root.setAttribute('data-state', state);
  let input = null;
  let retry = null;

  if (state === 'filled') {
    const row = el(doc, 'label', 'choice roll-deletions-toggle');
    input = el(doc, 'input', 'choice-input');
    input.setAttribute('type', 'checkbox');
    input.checked = opts.checked === true;
    const count = Number.isFinite(opts.deletions) ? opts.deletions : 0;
    row.appendChild(input);
    row.appendChild(el(doc, 'span', null, `${text('supp_show_deletions')} (${count})`));
    input.addEventListener('change', () => {
      if (typeof opts.onChange === 'function') opts.onChange(input.checked === true);
    });
    root.appendChild(row);
  } else if (state === 'empty') {
    const p = el(doc, 'p', 'notice roll-supplement-empty', text('supp_no_deletions'));
    p.setAttribute('data-tone', 'info');
    p.setAttribute('role', 'status');
    root.appendChild(p);
  } else {
    const p = el(doc, 'p', 'notice roll-supplement-error', text('supp_failed'));
    p.setAttribute('data-tone', 'error');
    p.setAttribute('role', 'alert');
    root.appendChild(p);
    const support = typeof opts.support === 'string' ? opts.support.trim() : '';
    root.appendChild(el(doc, 'p', 'roll-contact', support || text('roll_error_contact')));
    retry = el(doc, 'button', 'btn-secondary roll-supplement-retry', text('roll_retry'));
    retry.setAttribute('type', 'button');
    retry.addEventListener('click', () => {
      if (typeof opts.onRetry === 'function') opts.onRetry();
    });
    root.appendChild(retry);
  }

  container.replaceChildren(root);
  return { root, state, input, retry };
}
