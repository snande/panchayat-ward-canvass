// The polling-day tally by SMS for one ward (issue #81), opened from the ward
// roll (src/ui/rollSearch.js) for when there is no mobile data.
//
// Two panels, one per side of the SMS:
// - Send: the worker's own seen-voting marks in this ward (marks the
//   seen-voting store holds in this phone's worker id), counted under the
//   "send by SMS" button (src/ui/smsSendButton.js), which hands them to the
//   phone's SMS app for the team number. While the marks and the team are
//   being read a loading line shows; with no marks yet an empty line says how
//   to make one; without a team, or when the marks cannot be read, an error
//   says so (the latter with a retry).
// - Add: the coordinator's paste form (src/ui/smsEntryScreen.js). A pasted
//   SMS is merged into the seen-voting marks of this ward
//   (src/tally/smsMarks.js), so a voter reported by SMS and the same voter
//   marked on a phone count once, here, in the turnout screen and, after a
//   sync, on every teammate's phone. The ward's team count sits under the
//   form and is read again whenever marks are added.
//
// settings() gives {teamSmsNumber, candidateId}: the team number from the
// constituency config and the candidate code of the team this phone joined
// ('' before it joins), whose teamTag (teamTagFor in src/tally/smsCodec.js)
// both panels use. Nothing here touches the network.

import { teamTagFor } from '../tally/smsCodec.js';
import * as defaultInbox from '../tally/smsInbox.js';
import { applyTallySmsToMarks } from '../tally/smsMarks.js';
import { el, setNotice } from './dom.js';
import { renderSmsEntryScreen } from './smsEntryScreen.js';
import { renderSmsSendButton } from './smsSendButton.js';

// Copies of src/strings.hi.json entries, used when the table lacks them;
// test/smsTallyWiring.test.js fails if they drift.
export const FALLBACK_TEXT = {
  'tally.sendTitle': 'अपने निशान एसएमएस से भेजें',
  'tally.sendHelp': 'इंटरनेट न हो तो इस वार्ड में आपके चिह्नित मतदाता टीम के नंबर पर एसएमएस से भेजें। एक मतदाता कई फ़ोन से आए, तब भी एक ही गिना जाता है।',
  'tally.sendCountLabel': 'इस वार्ड में आपके चिह्नित मतदाता',
  'tally.sendLoading': 'आपके निशान पढ़े जा रहे हैं…',
  'tally.sendEmpty': 'इस वार्ड में आपने अभी किसी को चिह्नित नहीं किया। सूची में मतदाता चुनकर "मतदान किया" दबाएँ, फिर यहाँ से भेजें।',
  'tally.sendReadFailed': 'आपके निशान पढ़े नहीं जा सके। फिर से कोशिश करें।',
  'tally.sendRetry': 'फिर से कोशिश करें',
  'tally.sendTeamMissing': 'इस फ़ोन पर टीम सेट नहीं है, इसलिए एसएमएस नहीं भेजे जा सकते। पहले अपने उम्मीदवार की टीम से जुड़ें।',
  'tally.wardCountLabel': 'टीम ने इस वार्ड में मतदान करते देखा',
  seen_team_count_loading: 'गिनती हो रही है',
  seen_team_count_failed: 'गिनती अभी नहीं पढ़ी जा सकी',
};

/** A count line (DESIGN.md "Count line"): muted label, numeral on the right. */
function countLine(doc, className, label) {
  const line = el(doc, 'p', `seen-voting-count ${className}`);
  line.setAttribute('aria-live', 'polite');
  line.appendChild(el(doc, 'span', 'seen-voting-count-label', label));
  const value = el(doc, 'span', 'seen-voting-count-value');
  line.appendChild(value);
  return { line, value };
}

/**
 * Mount the view into container (replacing its content).
 * @param {Element} container
 * @param {Record<string, string>} strings the Hindi string table
 * @param {{
 *   marks: {listMarks: Function, recordSeen: Function, wardCount: Function, onMarksChanged?: Function},
 *   wardId: string,
 *   settings: () => Promise<{teamSmsNumber?: string, candidateId?: string}>,
 *   workerId?: () => string | Promise<string>,
 *   inRoll?: (serial: number) => boolean,
 *   inbox?: {applyTallySms: Function},
 *   location?: {href: string}, log?: Function,
 * }} opts workerId names this phone's worker (defaults to 'device', as for a
 *   tapped mark); inbox defaults to the device SMS inbox
 * @returns {{root, sendPanel, status, retryButton, sendHost, ownValue, wardValue,
 *   send: object | null, entry: object | null, ready: Promise<void>,
 *   reload: () => Promise<void>, destroy: () => void}} send and entry are the
 *   send button and the paste form once the settings are read
 */
export function mountSmsTally(container, strings, opts) {
  const doc = container.ownerDocument;
  const { marks, wardId } = opts;
  const text = (key) => (strings && Object.prototype.hasOwnProperty.call(strings, key) ? strings[key] : FALLBACK_TEXT[key]);
  const workerId = typeof opts.workerId === 'function' ? opts.workerId : () => 'device';
  const inbox = opts.inbox || defaultInbox;
  const log = opts.log || ((...args) => console.error(...args));

  const root = el(doc, 'div', 'sms-tally');
  root.setAttribute('lang', 'hi');

  const sendPanel = el(doc, 'section', 'panel sms-tally-send');
  sendPanel.appendChild(el(doc, 'h2', 'panel-title sms-tally-title', text('tally.sendTitle')));
  sendPanel.appendChild(el(doc, 'p', 'sms-tally-help', text('tally.sendHelp')));
  const status = el(doc, 'p', 'notice sms-tally-status');
  status.setAttribute('aria-live', 'polite');
  sendPanel.appendChild(status);
  const retryButton = el(doc, 'button', 'btn-secondary sms-tally-retry', text('tally.sendRetry'));
  retryButton.setAttribute('type', 'button');
  retryButton.hidden = true;
  sendPanel.appendChild(retryButton);
  const sendHost = el(doc, 'div', 'sms-tally-send-host');
  sendHost.hidden = true;
  sendPanel.appendChild(sendHost);
  const own = countLine(doc, 'sms-tally-own-count', text('tally.sendCountLabel'));
  own.line.hidden = true;
  sendPanel.appendChild(own.line);
  root.appendChild(sendPanel);

  const entryHost = el(doc, 'div', 'sms-tally-entry');
  root.appendChild(entryHost);
  const ward = countLine(doc, 'sms-tally-ward-count', text('tally.wardCountLabel'));

  container.replaceChildren(root);

  const view = {
    root, sendPanel, status, retryButton, sendHost, ownValue: own.value, wardValue: ward.value, send: null, entry: null,
  };

  // A number, or the key of the placeholder shown instead of one.
  function showCount(value, key) {
    const known = Number.isSafeInteger(value) && value >= 0;
    ward.value.textContent = known ? String(value) : text(key);
    ward.value.setAttribute('class', known ? 'seen-voting-count-value' : 'seen-voting-count-value seen-voting-count-pending');
  }

  let wardRequest = 0;
  async function refreshWardCount() {
    const request = ++wardRequest;
    let value = null;
    try {
      value = await marks.wardCount(wardId);
    } catch (err) {
      log('ward seen-voting count could not be read', err);
    }
    if (request === wardRequest) showCount(value, 'seen_team_count_failed');
  }

  // The serials the send button packs: this worker's marks in this ward.
  let ownSerials = [];
  let settings = null;
  let worker = null;

  // undefined: still reading; false: could not be read; otherwise the list.
  function showSend(serials) {
    const ready = Array.isArray(serials);
    const teamMissing = settings && !settings.teamTag;
    retryButton.hidden = serials !== false;
    sendHost.hidden = !ready || teamMissing || serials.length === 0;
    own.line.hidden = !ready || teamMissing || serials.length === 0;
    if (ready) own.value.textContent = String(serials.length);
    if (serials === undefined) setNotice(status, text('tally.sendLoading'));
    else if (serials === false) setNotice(status, text('tally.sendReadFailed'), 'error');
    else if (teamMissing) setNotice(status, text('tally.sendTeamMissing'), 'error');
    else if (serials.length === 0) setNotice(status, text('tally.sendEmpty'));
    else setNotice(status, '');
  }

  // Later reads win over slower earlier ones.
  let ownRequest = 0;
  async function refreshOwn() {
    const request = ++ownRequest;
    let serials;
    try {
      if (worker === null) worker = await workerId();
      const all = await marks.listMarks();
      serials = all
        .filter((mark) => mark.wardId === wardId && mark.workerId === worker && mark.serial >= 1)
        .map((mark) => mark.serial);
    } catch (err) {
      log('this worker\'s seen-voting marks could not be read', err);
      serials = false;
    }
    if (request !== ownRequest) return;
    if (serials !== false) ownSerials = serials;
    showSend(serials);
  }

  function mountForms() {
    const config = { teamSmsNumber: settings.teamSmsNumber, teamTag: settings.teamTag, workerId: worker };
    view.send = renderSmsSendButton(sendHost, {
      getSerials: () => ownSerials, config, strings, location: opts.location, log,
    });
    view.entry = renderSmsEntryScreen(entryHost, {
      teamTag: settings.teamTag,
      strings,
      log,
      applyTallySms: (pasted, { teamTag }) => applyTallySmsToMarks(pasted, {
        teamTag, wardId, inRoll: opts.inRoll, inbox, marks,
      }),
    });
    view.entry.root.appendChild(ward.line);
  }

  async function load() {
    showSend(undefined);
    if (!settings) {
      try {
        const read = (await opts.settings()) || {};
        worker = await workerId();
        settings = {
          teamSmsNumber: typeof read.teamSmsNumber === 'string' ? read.teamSmsNumber : '',
          teamTag: teamTagFor(read.candidateId),
        };
      } catch (err) {
        log('SMS tally settings could not be read', err);
        showSend(false);
        return;
      }
      mountForms();
    }
    await Promise.all([refreshOwn(), refreshWardCount()]);
  }

  retryButton.addEventListener('click', () => { load(); });

  showCount(null, 'seen_team_count_loading');
  const ready = load();

  // Marks added while this is open (a pasted SMS, a teammate's sync) update
  // both counts. A view that has left the page stops listening.
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
      if (!settings) return;
      refreshOwn();
      refreshWardCount();
    });
  }

  return { ...view, get send() { return view.send; }, get entry() { return view.entry; }, ready, reload: load, destroy };
}
