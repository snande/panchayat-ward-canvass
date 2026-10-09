// Voter card render (issue #138): the full roll line of one entry plus its
// booth, the same card wherever a voter opens. A pure render: it reads only
// its arguments, builds the DESIGN.md panel and returns it. It stores nothing,
// deletes nothing and touches no network, IndexedDB or localStorage.
//
// The card shows whatever the entry and booth carry. A v1 rollStore entry has
// no relation or EPIC, and the booth arrives later from the roll decoder, so
// any field that is missing reads "—". An entry flagged `struck` (struck off
// the roll) carries the error badge and a struck-through name, never the look
// of a live voter.

import { el } from '../ui/dom.js';

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
 * @param {object} [entry] a roll entry: serial, name, relation, relative, age, gender, house, epic, struck
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
 * Build the voter card: a DESIGN.md panel whose header names the voter and
 * whose body is a definition list of the ten labelled fields.
 * @param {object} entry the roll entry
 * @param {string|number|{ward?: string|number}} ward the ward number
 * @param {{name?: string, address?: string}} booth the polling booth
 * @param {Document} [doc] the document to build in (defaults to the page's)
 * @returns {Element} the card, not attached anywhere
 */
export function renderVoterCard(entry, ward, booth, doc = globalThis.document) {
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
  return root;
}
