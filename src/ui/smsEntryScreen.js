// Coordinator's SMS entry screen (issue #85): the coordinator pastes a tally
// SMS received at the team number and adds it to the team's tally.
//
// - The message is merged by applyTallySms (src/tally/smsInbox.js), a set
//   union of roll serials: pasting the same message again, or messages that
//   overlap, never counts a serial twice. After an add the screen shows how
//   many of the message's serials were new and how many were already there.
// - When the outcome lists outsideSerials (serials not in the ward's roll or
//   struck off it, left out of the count), an error says so and the pasted text stays.
// - A rejected message (not a tally SMS, damaged, or another team's) shows
//   its Hindi reason; the pasted text stays so it can be checked and fixed.
// - Without a teamTag the field and button are disabled and say why.
// - With opts.saveSmsNumber, a field above the paste form holds the team's
//   SMS number (issue #103), the number workers' tally SMS go to. Saving it
//   hands it to saveSmsNumber (src/team/teamSmsNumber.js keeps it encrypted
//   and shares it with the team); a value that is not a phone number is
//   refused with a Hindi reason. It is disabled without a teamTag too.
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
  'tally.smsEntryOutsideWard': 'इस संदेश के कुछ क्रमांक इस वार्ड की सूची में नहीं हैं या सूची से हटाए गए हैं, इसलिए वे नहीं गिने गए। देखें कि एसएमएस इसी वार्ड का है।',
  'tally.smsEntryNumberLabel': 'टीम का एसएमएस नंबर',
  'tally.smsEntryNumberHelp': 'कार्यकर्ता अपने निशान इसी नंबर पर एसएमएस से भेजते हैं। देश कोड के साथ लिखें, जैसे +91 98765 43210। यह नंबर सिर्फ़ आपकी टीम के फ़ोनों पर रहता है।',
  'tally.smsEntryNumberSave': 'नंबर सहेजें',
  'tally.smsEntryNumberSaved': 'नंबर सहेज लिया। इंटरनेट मिलते ही यह टीम के सभी फ़ोनों पर पहुँच जाएगा।',
  'tally.smsEntryNumberInvalid': 'यह फ़ोन नंबर नहीं लगता। देश कोड के साथ पूरा नंबर लिखें, जैसे +91 98765 43210।',
  'tally.smsEntryNumberFailed': 'नंबर इस फ़ोन पर सहेजा नहीं जा सका। फिर से कोशिश करें।',
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
 *   smsNumber?: string,
 *   saveSmsNumber?: (value: string) => Promise<string>,
 *   log?: Function,
 * }} opts strings is the parsed src/strings.hi.json; applyTallySms defaults to
 *   the device inbox (tests pass one over a fake IndexedDB); smsNumber is the
 *   team's SMS number as stored, and saveSmsNumber stores a new one (throwing
 *   a TypeError for a value that is not a phone number) and resolves with it
 * @returns {{root, input, button, message, result, newValue, duplicateValue,
 *   numberInput, numberButton, numberMessage, submit: () => Promise<void>,
 *   saveNumber: () => Promise<void>, showSmsNumber: (number: string) => void}}
 *   the number* fields are null without saveSmsNumber
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

  const saveSmsNumber = typeof opts.saveSmsNumber === 'function' ? opts.saveSmsNumber : null;
  let numberInput = null;
  let numberButton = null;
  let numberMessage = null;
  if (saveSmsNumber) {
    const numberRow = el(doc, 'div', 'picker-field sms-entry-number');
    const numberId = 'sms-entry-number';
    const numberLabel = el(doc, 'label', 'picker-label', text('tally.smsEntryNumberLabel'));
    numberLabel.setAttribute('for', numberId);
    const numberHelp = el(doc, 'p', 'sms-entry-help', text('tally.smsEntryNumberHelp'));
    numberHelp.setAttribute('id', `${numberId}-help`);
    numberInput = el(doc, 'input', 'picker-select sms-entry-number-input');
    numberInput.setAttribute('id', numberId);
    numberInput.setAttribute('type', 'tel');
    numberInput.setAttribute('inputmode', 'tel');
    numberInput.setAttribute('autocomplete', 'off');
    numberInput.setAttribute('aria-describedby', numberHelp.getAttribute('id'));
    numberInput.value = typeof opts.smsNumber === 'string' ? opts.smsNumber : '';
    numberButton = el(doc, 'button', 'btn-secondary sms-entry-number-save', text('tally.smsEntryNumberSave'));
    // Not a submit button: the form's submit adds a pasted SMS.
    numberButton.setAttribute('type', 'button');
    numberMessage = el(doc, 'p', 'notice sms-entry-number-message');
    numberMessage.setAttribute('aria-live', 'polite');
    numberRow.appendChild(numberLabel);
    numberRow.appendChild(numberInput);
    numberRow.appendChild(numberHelp);
    numberRow.appendChild(numberButton);
    numberRow.appendChild(numberMessage);
    root.appendChild(numberRow);
  }

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

  const view = {
    root, input, button, message, result, newValue: added.value, duplicateValue: duplicates.value,
    numberInput, numberButton, numberMessage,
  };

  // The number last stored, shown in the field unless it is being edited.
  let shownNumber = numberInput ? numberInput.value : '';
  function showSmsNumber(number) {
    if (!numberInput || typeof number !== 'string') return;
    if (numberInput.value === shownNumber) numberInput.value = number;
    shownNumber = number;
  }

  if (!teamTag) {
    input.setAttribute('disabled', '');
    button.setAttribute('disabled', '');
    if (numberInput) {
      numberInput.setAttribute('disabled', '');
      numberButton.setAttribute('disabled', '');
    }
    setNotice(message, text('tally.smsEntryTeamMissing'), 'error');
    return { ...view, submit: async () => {}, saveNumber: async () => {}, showSmsNumber };
  }

  let savingNumber = false;
  async function saveNumber() {
    if (!saveSmsNumber || savingNumber) return;
    savingNumber = true;
    numberButton.setAttribute('disabled', '');
    try {
      const stored = await saveSmsNumber(numberInput.value);
      shownNumber = stored;
      numberInput.value = stored;
      setNotice(numberMessage, text('tally.smsEntryNumberSaved'), 'success');
    } catch (err) {
      if (err instanceof TypeError) {
        setNotice(numberMessage, text('tally.smsEntryNumberInvalid'), 'error');
      } else {
        log('team SMS number could not be saved', err);
        setNotice(numberMessage, text('tally.smsEntryNumberFailed'), 'error');
      }
    } finally {
      savingNumber = false;
      numberButton.removeAttribute('disabled');
    }
  }

  if (numberInput) {
    numberButton.addEventListener('click', () => { saveNumber(); });
    // Enter in the number field saves the number rather than submitting the
    // paste form.
    numberInput.addEventListener('keydown', (event) => {
      if (!event || event.key !== 'Enter') return;
      if (typeof event.preventDefault === 'function') event.preventDefault();
      saveNumber();
    });
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
    if (Array.isArray(outcome.outsideSerials) && outcome.outsideSerials.length) {
      setNotice(message, text('tally.smsEntryOutsideWard'), 'error');
      return;
    }
    input.value = '';
    if (outcome.newSerials.length) setNotice(message, text('tally.smsEntryAdded'), 'success');
    else setNotice(message, text('tally.smsEntryNothingNew'), 'info');
  }

  root.addEventListener('submit', (event) => {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    submit();
  });

  return { ...view, submit, saveNumber, showSmsNumber };
}
