// Voter card render (issue #138): the full roll line of one entry plus its
// booth, the same card wherever a voter opens. A pure render: it reads only
// its arguments, builds the DESIGN.md panel and returns it. It stores nothing,
// deletes nothing and touches no network, IndexedDB or localStorage.
//
// The card shows whatever the entry and booth carry. A v1 rollStore entry has
// no relation or EPIC, and the booth arrives later from the roll decoder, so
// any field that is missing reads "—". An entry flagged `deleted` (struck off
// the roll) carries the error badge and a struck-through name, never the look
// of a live voter.
//
// The card's one control is the share button (issue #140): it hands this one
// voter's labelled fields, plus the SEC footer lines, to the phone's share
// sheet (navigator.share) or, without one, to the clipboard. It makes no
// server call, so it works offline, and the text carries no candidate, party,
// symbol or slogan. A cancelled share or a refused clipboard shows an error
// notice saying what to do and whom to call; it never throws.

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

/**
 * The card's fields as [key, text] pairs, in VOTER_CARD_LABELS order.
 * @param {object} [entry] a roll entry: serial, name, relation, relative, age, gender, house, epic, deleted
 * @param {string|number|{ward?: string|number}} [ward]
 * @param {{name?: string, address?: string}} [booth]
 * @returns {Array<[string, string]>}
 */
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

/**
 * One voter's details as share text: a "label: value" line per card field, in
 * card order and with the card's labels ("—" for a missing field), then a
 * blank line and the SEC footer lines (source, not an official SEC app, the
 * printed roll prevails).
 * @param {object} [entry]
 * @param {string|number|{ward?: string|number}} [ward]
 * @param {{name?: string, address?: string}} [booth]
 * @returns {string}
 */
export function voterShareText(entry, ward, booth) {
  const lines = voterCardFields(entry, ward, booth)
    .map(([key, text]) => `${VOTER_CARD_LABELS[key]}: ${text}`);
  return [...lines, '', ...SEC_FOOTER_LINES].join('\n');
}

/**
 * Share text through the phone's share sheet, or copy it when there is none.
 * Resolves to 'shared', 'copied' or 'failed'; never rejects.
 * @param {string} text
 * @param {Navigator} [nav]
 * @returns {Promise<'shared'|'copied'|'failed'>}
 */
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
 * Build the voter card: a DESIGN.md panel whose header names the voter, whose
 * body is a definition list of the ten labelled fields, and whose one control
 * is the share button with its notice below.
 * @param {object} entry the roll entry
 * @param {string|number|{ward?: string|number}} ward the ward number
 * @param {{name?: string, address?: string}} booth the polling booth
 * @param {Document} [doc] the document to build in (defaults to the page's)
 * @param {{navigator?: Navigator}} [options] the navigator to share through
 *   (defaults to the page's, read at tap time)
 * @returns {Element} the card, not attached anywhere; `card.share()` runs one
 *   tap's share and resolves to its state
 */
export function renderVoterCard(entry, ward, booth, doc = globalThis.document, options = {}) {
  const struck = Boolean(entry && entry.deleted);
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
