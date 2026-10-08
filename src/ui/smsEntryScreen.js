// Coordinator's SMS entry screen (issue #85): the coordinator pastes a tally
// SMS received at the team number and adds it to the team's tally.
//
// - The message is merged by applyTallySms (src/tally/smsInbox.js), a set
//   union of roll serials: pasting the same message again, or messages that
//   overlap, never counts a serial twice. After an add the screen shows how
//   many of the message's serials were new and how many were already there.
// - A rejected message (not a tally SMS, damaged, or another team's) shows
//   its Hindi reason; the pasted text stays so it can be checked and fixed.
// - Without a teamTag the field and button are disabled and say why.
// - Nothing here touches the network.
// All text comes from the tally.smsEntry* entries of src/strings.hi.json.

import { applyTallySms } from '../tally/smsInbox.js';
import { el, setNotice } from './dom.js';

// Copies of the tally.smsEntry* entries in src/strings.hi.json, used when the
// caller passes no string table; test/smsEntryScreen.test.js fails if they drift.
export const FALLBACK_TEXT = {
  'tally.smsEntryTitle': 'कार्यकर्ता का एसएमएस जोड़ें',
  'tally.smsEntryLabel': 'मिला हुआ टैली एसएमएस',
  'tally.smsEntryHelp': 'कार्यकर्ता का पूरा एसएमएस यहाँ चिपकाएँ। वही एसएमएस दोबारा जोड़ने पर गिनती नहीं बढ़ती।',
  'tally.smsEntryAdd': 'जोड़ें',
  'tally.smsEntryNewCaption': 'नए क्रमांक जुड़े',
  'tally.smsEntryDuplicateCaption': 'पहले से जुड़े क्रमांक',
  'tally.smsEntryAdded': 'आपने संदेश के नए क्रमांक इस फ़ोन पर जोड़ दिए।',
  'tally.smsEntryNothingNew': 'इस संदेश के सभी क्रमांक पहले से जुड़े हैं। गिनती नहीं बदली।',
  'tally.smsEntryEmpty': 'पहले कार्यकर्ता का एसएमएस चिपकाएँ।',
  'tally.smsEntryRejectedPrefix': 'यह टैली एसएमएस नहीं है। कार्यकर्ता का पूरा संदेश चिपकाएँ।',
  'tally.smsEntryRejectedFormat': 'संदेश अधूरा या बदला हुआ है। पूरा संदेश दोबारा चिपकाएँ।',
  'tally.smsEntryRejectedChecksum': 'संदेश की जाँच मेल नहीं खाई, शायद कोई अक्षर छूट गया। पूरा संदेश दोबारा चिपकाएँ।',
  'tally.smsEntryRejectedTeam': 'यह संदेश किसी दूसरी टीम का है, इसलिए नहीं जोड़ा गया।',
  'tally.smsEntryTeamMissing': 'इस फ़ोन पर टीम सेट नहीं है, इसलिए एसएमएस नहीं जोड़े जा सकते। अपने उम्मीदवार की टीम से पूछें।',
  'tally.smsEntryFailed': 'संदेश इस फ़ोन पर सहेजा नहीं जा सका। फिर से कोशिश करें।',
};

// decodeTallySms reasons and the string that explains each one.
const REJECTION_KEYS = {
  prefix: 'tally.smsEntryRejectedPrefix',
  format: 'tally.smsEntryRejectedFormat',
  checksum: 'tally.smsEntryRejectedChecksum',
  team: 'tally.smsEntryRejectedTeam',
};

/** One result figure: a numeral over its caption. */
function figure(doc, className, caption) {
  const node = el(doc, 'div', `sms-entry-figure ${className}`);
  const value = el(doc, 'p', 'sms-entry-value');
  node.appendChild(value);
  node.appendChild(el(doc, 'p', 'sms-entry-caption', caption));
  return { node, value };
}

/**
 * Mount the SMS entry screen into container (replacing its content).
 * @param {Element} container
 * @param {{
 *   teamTag: string,
 *   strings?: Record<string, string>,
 *   applyTallySms?: typeof applyTallySms,
 *   log?: Function,
 * }} opts strings is the parsed src/strings.hi.json; applyTallySms defaults to
 *   the device inbox (tests pass one over a fake IndexedDB)
 * @returns {{root, input, button, message, result, newValue, duplicateValue,
 *   submit: () => Promise<void>}}
 */
export function renderSmsEntryScreen(container, opts = {}) {
  const { strings } = opts;
  const teamTag = typeof opts.teamTag === 'string' ? opts.teamTag.trim() : '';
  const apply = opts.applyTallySms || applyTallySms;
  const log = opts.log || ((...args) => console.error(...args));
  const text = (key) => (strings && Object.prototype.hasOwnProperty.call(strings, key) ? strings[key] : FALLBACK_TEXT[key]);
  const doc = container.ownerDocument;

  const root = el(doc, 'form', 'panel sms-entry-screen');
  root.setAttribute('lang', 'hi');
  root.setAttribute('novalidate', '');
  root.appendChild(el(doc, 'h2', 'panel-title sms-entry-title', text('tally.smsEntryTitle')));

  const row = el(doc, 'div', 'picker-field');
  const id = 'sms-entry-input';
  const label = el(doc, 'label', 'picker-label', text('tally.smsEntryLabel'));
  label.setAttribute('for', id);
  const help = el(doc, 'p', 'sms-entry-help', text('tally.smsEntryHelp'));
  help.setAttribute('id', `${id}-help`);
  const input = el(doc, 'textarea', 'picker-select sms-entry-input');
  input.setAttribute('id', id);
  input.setAttribute('rows', '4');
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('autocapitalize', 'off');
  input.setAttribute('spellcheck', 'false');
  input.setAttribute('aria-describedby', help.getAttribute('id'));
  row.appendChild(label);
  row.appendChild(input);
  row.appendChild(help);
  root.appendChild(row);

  const button = el(doc, 'button', 'btn-primary sms-entry-add', text('tally.smsEntryAdd'));
  button.setAttribute('type', 'submit');
  root.appendChild(button);

  const result = el(doc, 'div', 'sms-entry-result');
  const added = figure(doc, 'sms-entry-figure-new', text('tally.smsEntryNewCaption'));
  const duplicates = figure(doc, 'sms-entry-figure-duplicate', text('tally.smsEntryDuplicateCaption'));
  result.appendChild(added.node);
  result.appendChild(duplicates.node);
  result.hidden = true;
  root.appendChild(result);

  const message = el(doc, 'p', 'notice sms-entry-message');
  message.setAttribute('aria-live', 'polite');
  root.appendChild(message);

  container.replaceChildren(root);

  const view = { root, input, button, message, result, newValue: added.value, duplicateValue: duplicates.value };

  if (!teamTag) {
    input.setAttribute('disabled', '');
    button.setAttribute('disabled', '');
    setNotice(message, text('tally.smsEntryTeamMissing'), 'error');
    return { ...view, submit: async () => {} };
  }

  const fail = (key) => {
    result.hidden = true;
    setNotice(message, text(key), 'error');
  };

  let busy = false;
  async function submit() {
    if (busy) return;
    const pasted = input.value;
    if (!pasted.trim()) {
      fail('tally.smsEntryEmpty');
      return;
    }
    busy = true;
    root.setAttribute('aria-busy', 'true');
    button.setAttribute('disabled', '');
    let outcome;
    try {
      outcome = await apply(pasted, { teamTag });
    } catch (err) {
      log('tally SMS could not be added', err);
      fail('tally.smsEntryFailed');
      return;
    } finally {
      busy = false;
      root.removeAttribute('aria-busy');
      button.removeAttribute('disabled');
    }
    if (!outcome || !outcome.ok) {
      fail(REJECTION_KEYS[outcome && outcome.reason] || 'tally.smsEntryRejectedFormat');
      return;
    }
    added.value.textContent = String(outcome.newSerials.length);
    duplicates.value.textContent = String(outcome.duplicateSerials.length);
    result.hidden = false;
    input.value = '';
    if (outcome.newSerials.length) setNotice(message, text('tally.smsEntryAdded'), 'success');
    else setNotice(message, text('tally.smsEntryNothingNew'), 'info');
  }

  root.addEventListener('submit', (event) => {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    submit();
  });

  return { ...view, submit };
}
