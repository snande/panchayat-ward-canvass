// Coordinator's SMS entry screen (issue #85): paste a tally SMS received at
// the team number and add it to the team tally on this device. Nothing here
// touches the network; src/tally/smsInbox.js stores the serials encrypted.
//
// After "Add" the screen says how many of the message's serials were new and
// how many were already counted, or why the message was rejected (bad
// checksum, another candidate's team, not a tally SMS).

import { applyTallySms } from '../tally/smsInbox.js';
import { el } from './dom.js';

// Copies of the tally.smsEntry* entries in src/strings.hi.json, used when the
// caller passes no string table; test/smsEntryScreen.test.js fails if they drift.
export const FALLBACK_TEXT = {
  'tally.smsEntryTitle': 'मिला हुआ गिनती एसएमएस जोड़ें',
  'tally.smsEntryLabel': 'कार्यकर्ता से मिला गिनती का एसएमएस यहाँ चिपकाएँ',
  'tally.smsEntryAdd': 'जोड़ें',
  'tally.smsEntryNewCount': 'नए क्रमांक जोड़े गए:',
  'tally.smsEntryDuplicateCount': 'पहले से दर्ज क्रमांक:',
  'tally.smsEntryEmpty': 'पहले एसएमएस यहाँ चिपकाएँ।',
  'tally.smsEntryFailed': 'एसएमएस जोड़ा नहीं जा सका। फिर से कोशिश करें।',
  'tally.smsEntryRejectedChecksum': 'यह एसएमएस अधूरा या बदला हुआ है, इसलिए नहीं जोड़ा गया। पूरा एसएमएस फिर से चिपकाएँ।',
  'tally.smsEntryRejectedTeam': 'यह एसएमएस आपकी टीम का नहीं है, इसलिए नहीं जोड़ा गया।',
  'tally.smsEntryRejectedFormat': 'यह गिनती का एसएमएस नहीं लगता। पूरा एसएमएस बिना बदले चिपकाएँ।',
};

// decodeTallySms reasons -> string keys; 'prefix' and 'format' read the same.
const REJECTION_KEYS = {
  checksum: 'tally.smsEntryRejectedChecksum',
  team: 'tally.smsEntryRejectedTeam',
  prefix: 'tally.smsEntryRejectedFormat',
  format: 'tally.smsEntryRejectedFormat',
};

/** "नए क्रमांक जोड़े गए: 3, पहले से दर्ज क्रमांक: 2" */
export function resultText(text, newCount, duplicateCount) {
  return `${text('tally.smsEntryNewCount')} ${newCount}, ${text('tally.smsEntryDuplicateCount')} ${duplicateCount}`;
}

/**
 * @param {Element} container replaced with the entry screen
 * @param {Record<string, string> | null | undefined} strings the Hindi string table
 * @param {{
 *   teamTag: string,
 *   apply?: (text: string, opts: {teamTag: string}) => Promise<object>,
 *   log?: Function,
 * }} opts `apply` defaults to applyTallySms from src/tally/smsInbox.js
 * @returns {{root, textarea, button, message, submit: () => Promise<object | null>}}
 */
export function mountSmsEntryScreen(container, strings, opts = {}) {
  const doc = container.ownerDocument;
  const apply = opts.apply || applyTallySms;
  const log = opts.log || ((...args) => console.error(...args));
  const text = (key) => (strings && Object.prototype.hasOwnProperty.call(strings, key) ? strings[key] : FALLBACK_TEXT[key]);

  const root = el(doc, 'section', 'sms-entry');
  root.setAttribute('lang', 'hi');
  const title = el(doc, 'h2', 'sms-entry-title', text('tally.smsEntryTitle'));
  const label = el(doc, 'label', 'sms-entry-label', text('tally.smsEntryLabel'));
  label.setAttribute('for', 'sms-entry-text');
  const textarea = el(doc, 'textarea', 'sms-entry-text');
  textarea.setAttribute('id', 'sms-entry-text');
  textarea.setAttribute('lang', 'hi');
  textarea.setAttribute('rows', '4');
  textarea.setAttribute('aria-label', text('tally.smsEntryLabel'));
  const button = el(doc, 'button', 'btn-primary sms-entry-add', text('tally.smsEntryAdd'));
  button.setAttribute('type', 'button');
  const message = el(doc, 'p', 'picker-message sms-entry-message');
  message.setAttribute('aria-live', 'polite');

  root.appendChild(title);
  root.appendChild(label);
  root.appendChild(textarea);
  root.appendChild(button);
  root.appendChild(message);
  container.replaceChildren(root);

  async function submit() {
    const pasted = String(textarea.value ?? '').trim();
    if (!pasted) {
      message.textContent = text('tally.smsEntryEmpty');
      return null;
    }
    button.setAttribute('disabled', '');
    try {
      const result = await apply(pasted, { teamTag: opts.teamTag });
      if (result && result.ok) {
        message.textContent = resultText(text, result.newSerials.length, result.duplicateSerials.length);
        textarea.value = '';
      } else {
        message.textContent = text(REJECTION_KEYS[result && result.reason] || 'tally.smsEntryRejectedFormat');
      }
      return result;
    } catch (err) {
      log('tally SMS could not be applied', err);
      message.textContent = text('tally.smsEntryFailed');
      return null;
    } finally {
      button.removeAttribute('disabled');
    }
  }

  button.addEventListener('click', () => { submit(); });

  return { root, textarea, button, message, submit };
}
