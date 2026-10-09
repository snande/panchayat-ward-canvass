// Voter card render (issue #138): one entry's roll line plus its booth in a
// DESIGN.md panel; a missing field reads "—", a `struck` entry carries the
// error badge and a struck-through name. Pure: stores nothing, no network.
// Its one control shares this voter's fields and the SEC footer lines through
// navigator.share or the clipboard (issue #140); a failure shows an error
// notice and never throws.

import { el, setNotice } from '../ui/dom.js';
import { SEC_FOOTER_LINES } from '../ui/secFooter.js';

/** Hindi label of each card field, in card order. #140 reuses it for share text. */
export const VOTER_CARD_LABELS = Object.freeze({
  name: 'नाम',
  relation: 'संबंध',
  age: 'उम्र',
  gender: 'लिंग',
  house: 'मकान नं.',
  epic: 'मतदाता पहचान पत्र',
  serial: 'क्रम संख्या',
  ward: 'वार्ड',
  boothName: 'मतदान केंद्र',
  boothAddress: 'मतदान केंद्र का पता',
});

/** The marker a struck-off entry carries. */
export const STRUCK_OFF_LABEL = 'हटाया गया';

/** The share button's text. */
export const VOTER_SHARE_LABEL = 'साझा करें';

/** Shown once the text is on the clipboard. */
export const VOTER_SHARE_COPIED = 'कॉपी हो गया। अब इसे किसी भी ऐप में चिपकाकर भेजें।';

/** Shown when the share is cancelled or the clipboard refuses: what to do, whom to call. */
export const VOTER_SHARE_FAILED = 'जानकारी साझा या कॉपी नहीं हो सकी। फिर से कोशिश करें, या जानकारी को देर तक दबाकर कॉपी करें। फिर भी न हो तो अपनी टीम के समन्वयक को फ़ोन करें।';

/** What a field the entry does not carry reads as. */
export const MISSING = '—';

/** A value as card text: "—" for null, undefined or blank, else its string. */
export function fieldText(value) {
  if (value == null) return MISSING;
  const text = String(value).trim();
  return text ? text : MISSING;
}

const has = (value) => fieldText(value) !== MISSING;

/** The ward number from a ward string or number, or a seat-like object. */
function wardOf(ward) {
  if (ward && typeof ward === 'object') return ward.ward ?? ward.number;
  return ward;
}

/** The card's fields as [key, text] pairs, in VOTER_CARD_LABELS order. */
export function voterCardFields(entry, ward, booth) {
  const e = entry && typeof entry === 'object' ? entry : {};
  const b = booth && typeof booth === 'object' ? booth : {};
  const relation = [e.relation, e.relative].filter(has).map((v) => String(v).trim()).join(' ');
  return [
    ['name', fieldText(e.name)],
    ['relation', fieldText(relation)],
    ['age', fieldText(e.age)],
    ['gender', fieldText(e.gender)],
    ['house', fieldText(e.house)],
    ['epic', fieldText(e.epic)],
    ['serial', fieldText(e.serial)],
    ['ward', fieldText(wardOf(ward))],
    ['boothName', fieldText(b.name)],
    ['boothAddress', fieldText(b.address)],
  ];
}

/** Share text: a "label: value" line per card field, a blank line, the SEC footer lines. */
export function voterShareText(entry, ward, booth) {
  const lines = voterCardFields(entry, ward, booth)
    .map(([key, text]) => `${VOTER_CARD_LABELS[key]}: ${text}`);
  return [...lines, '', ...SEC_FOOTER_LINES].join('\n');
}

/** Share or copy text; resolves to 'shared', 'copied' or 'failed', never rejects. */
export async function shareText(text, nav) {
  try {
    if (nav && typeof nav.share === 'function') {
      await nav.share({ text });
      return 'shared';
    }
    await nav.clipboard.writeText(text);
    return 'copied';
  } catch {
    return 'failed';
  }
}

/**
 * The voter card panel (unattached): header, the labelled fields, the share
 * button and its notice. `card.share()` runs one tap's share.
 */
export function renderVoterCard(entry, ward, booth, doc = globalThis.document, options = {}) {
  const struck = Boolean(entry && entry.struck);
  const fields = voterCardFields(entry, ward, booth);
  const name = fields[0][1];

  // A struck-off name sits in <del>, which the browser strikes through.
  const nameNode = () => (struck ? el(doc, 'del', null, name) : doc.createTextNode(name));

  const root = el(doc, 'section', 'panel voter-roll-card');
  root.setAttribute('lang', 'hi');
  if (struck) root.setAttribute('data-state', 'struck-off');

  const header = el(doc, 'div', 'panel-header');
  const heading = el(doc, 'div', 'panel-heading');
  const title = el(doc, 'h2', 'panel-title');
  title.appendChild(nameNode());
  heading.appendChild(title);
  if (struck) {
    const badge = el(doc, 'span', 'badge', STRUCK_OFF_LABEL);
    badge.setAttribute('data-tone', 'error');
    heading.appendChild(badge);
  }
  header.appendChild(heading);
  root.appendChild(header);

  const list = el(doc, 'dl', 'voter-roll-fields');
  for (const [key, text] of fields) {
    const row = el(doc, 'div', 'voter-roll-field');
    row.setAttribute('data-field', key);
    row.appendChild(el(doc, 'dt', 'voter-roll-label', VOTER_CARD_LABELS[key]));
    const value = el(doc, 'dd', 'voter-roll-value');
    value.appendChild(key === 'name' ? nameNode() : doc.createTextNode(text));
    row.appendChild(value);
    list.appendChild(row);
  }
  root.appendChild(list);

  const shareButton = el(doc, 'button', 'btn-secondary voter-share', VOTER_SHARE_LABEL);
  shareButton.setAttribute('type', 'button');
  const message = el(doc, 'p', 'notice voter-share-message');
  message.setAttribute('role', 'status');
  message.setAttribute('aria-live', 'polite');
  root.appendChild(shareButton);
  root.appendChild(message);

  // One tap shares this card's voter, and only this one.
  const text = voterShareText(entry, ward, booth);
  root.share = async () => {
    const nav = 'navigator' in options ? options.navigator : globalThis.navigator;
    const state = await shareText(text, nav);
    root.setAttribute('data-share-state', state);
    if (state === 'copied') setNotice(message, VOTER_SHARE_COPIED, 'success');
    else if (state === 'failed') setNotice(message, VOTER_SHARE_FAILED, 'error');
    else setNotice(message, '');
    return state;
  };
  shareButton.addEventListener('click', () => root.share());
  return root;
}
