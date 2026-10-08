// Polling-day turnout screen (issue #88): the coordinator types in the
// official turnout figure for the ward and sees it beside the team's final
// supporter count, as two equal large numerals.
//
// - The turnout is saved and loaded through src/tally/turnoutStore.js, so a
//   figure saved earlier comes back on re-render with no network.
// - The supporter count is only ever read from the injected
//   getSupporterCount(); this screen never counts or merges marks itself, so
//   it cannot introduce double counts.
// - An entry that is not a whole number of voters shows an error and leaves
//   the displayed turnout as it was. Until a turnout is saved, its slot shows
//   a Hindi placeholder rather than 0.
// All text comes from the turnout.* entries of src/strings.hi.json.

import { loadOfficialTurnout, parseTurnoutCount, saveOfficialTurnout } from '../tally/turnoutStore.js';
import { el, setNotice } from './dom.js';

// Copies of the turnout.* entries in src/strings.hi.json, used when the caller
// passes no string table; test/turnoutScreen.test.js fails if they drift.
export const FALLBACK_TEXT = {
  'turnout.title': 'मतदान के दिन का हिसाब',
  'turnout.inputLabel': 'आधिकारिक मतदान (कुल वोट पड़े)',
  'turnout.save': 'मतदान सहेजें',
  'turnout.officialCaption': 'आधिकारिक मतदान',
  'turnout.supporterCaption': 'हमारे समर्थक जिन्होंने वोट डाला',
  'turnout.notEntered': 'अभी दर्ज नहीं',
  'turnout.countLoading': 'गिनती हो रही है…',
  'turnout.countUnavailable': 'गिनती उपलब्ध नहीं',
  'turnout.invalid': 'मतदान की संख्या केवल अंकों में डालें, जैसे ४१२।',
  'turnout.saved': 'आधिकारिक मतदान इस फ़ोन पर सहेजा गया।',
  'turnout.saveFailed': 'मतदान सहेजा नहीं जा सका। फिर से कोशिश करें।',
};

const DEFAULT_STORE = { saveOfficialTurnout, loadOfficialTurnout };

/** One figure block: a large numeral over its caption. */
function figure(doc, caption) {
  const node = el(doc, 'div', 'turnout-figure');
  const value = el(doc, 'p', 'turnout-value');
  value.setAttribute('aria-live', 'polite');
  node.appendChild(value);
  node.appendChild(el(doc, 'p', 'turnout-caption', caption));
  return { node, value };
}

/** Show a figure, or placeholder text styled as such. */
function show(value, content, isFigure) {
  value.setAttribute('class', isFigure ? 'turnout-value' : 'turnout-value turnout-value-empty');
  value.textContent = content;
}

/**
 * Mount the turnout screen into container (replacing its content).
 * @param {Element} container
 * @param {{
 *   ward: string,
 *   getSupporterCount: () => number | Promise<number>,
 *   strings?: Record<string, string>,
 *   store?: {saveOfficialTurnout: Function, loadOfficialTurnout: Function},
 *   log?: Function,
 * }} opts strings is the parsed src/strings.hi.json; store defaults to the
 *   device turnout store (tests pass one over a fake IndexedDB)
 * @returns {{root, input, button, turnoutValue, supporterValue, message,
 *   ready: Promise<void>, save: () => Promise<void>,
 *   refreshCount: () => Promise<void>}} refreshCount reads getSupporterCount()
 *   again, e.g. after teammates' marks arrive
 */
export function renderTurnoutScreen(container, opts = {}) {
  const { ward, getSupporterCount, strings } = opts;
  if (typeof ward !== 'string' || !ward) throw new TypeError('renderTurnoutScreen: ward must be a non-empty string');
  if (typeof getSupporterCount !== 'function') throw new TypeError('renderTurnoutScreen: getSupporterCount must be a function');
  const store = opts.store || DEFAULT_STORE;
  const log = opts.log || ((...args) => console.error(...args));
  const text = (key) => (strings && Object.prototype.hasOwnProperty.call(strings, key) ? strings[key] : FALLBACK_TEXT[key]);
  const doc = container.ownerDocument;

  const root = el(doc, 'form', 'turnout-screen');
  root.setAttribute('lang', 'hi');
  root.setAttribute('novalidate', '');
  root.appendChild(el(doc, 'h2', 'turnout-title', text('turnout.title')));

  const figures = el(doc, 'div', 'turnout-figures');
  const official = figure(doc, text('turnout.officialCaption'));
  const supporters = figure(doc, text('turnout.supporterCaption'));
  show(official.value, text('turnout.notEntered'), false);
  show(supporters.value, text('turnout.countLoading'), false);
  figures.appendChild(official.node);
  figures.appendChild(supporters.node);
  root.appendChild(figures);

  const row = el(doc, 'div', 'picker-field');
  const id = `turnout-input-${ward}`;
  const label = el(doc, 'label', 'picker-label', text('turnout.inputLabel'));
  label.setAttribute('for', id);
  // type=text with a numeric keyboard: Devanagari digits are accepted too.
  const input = el(doc, 'input', 'picker-select turnout-input');
  input.setAttribute('id', id);
  input.setAttribute('type', 'text');
  input.setAttribute('inputmode', 'numeric');
  input.setAttribute('autocomplete', 'off');
  row.appendChild(label);
  row.appendChild(input);
  root.appendChild(row);

  const button = el(doc, 'button', 'btn-primary turnout-save', text('turnout.save'));
  button.setAttribute('type', 'submit');
  root.appendChild(button);

  const message = el(doc, 'p', 'notice turnout-message');
  message.setAttribute('aria-live', 'polite');
  root.appendChild(message);

  container.replaceChildren(root);

  const showTurnout = (count) => show(official.value, String(count), true);

  // Later refreshes win over slower earlier ones.
  let countRequest = 0;
  async function refreshSupporterCount() {
    const request = ++countRequest;
    let count = null;
    try {
      count = await getSupporterCount();
    } catch (err) {
      log('supporter count could not be read', err);
    }
    if (request !== countRequest) return;
    if (Number.isSafeInteger(count) && count >= 0) show(supporters.value, String(count), true);
    else show(supporters.value, text('turnout.countUnavailable'), false);
  }

  // A save that finishes before the stored figure has loaded must not be
  // overwritten by that older figure.
  let savedHere = false;
  async function loadTurnout() {
    try {
      const count = await store.loadOfficialTurnout(ward);
      if (!savedHere && count != null) showTurnout(count);
    } catch (err) {
      log('official turnout could not be loaded', err);
    }
  }

  const ready = Promise.all([loadTurnout(), refreshSupporterCount()]).then(() => {});

  let busy = false;
  async function save() {
    if (busy) return;
    const entered = input.value;
    try {
      parseTurnoutCount(entered);
    } catch {
      setNotice(message, text('turnout.invalid'), 'error');
      return;
    }
    busy = true;
    button.setAttribute('disabled', '');
    setNotice(message, '');
    try {
      const count = await store.saveOfficialTurnout(ward, entered);
      savedHere = true;
      showTurnout(count);
      input.value = '';
      setNotice(message, text('turnout.saved'), 'success');
    } catch (err) {
      log('official turnout could not be saved', err);
      setNotice(message, text('turnout.saveFailed'), 'error');
      return;
    } finally {
      busy = false;
      button.removeAttribute('disabled');
    }
    await refreshSupporterCount();
  }

  root.addEventListener('submit', (event) => {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    save();
  });

  return {
    root,
    input,
    button,
    turnoutValue: official.value,
    supporterValue: supporters.value,
    message,
    ready,
    save,
    refreshCount: refreshSupporterCount,
  };
}
