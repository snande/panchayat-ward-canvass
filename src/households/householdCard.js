// Household card (DESIGN.md "Household card"): one `state` at a time,
// loading, empty, error (with retry) or success. A row tap calls
// deps.onOpenMember({ward, serial}). Its three sentences live only here: the
// precached string table is at the offline download budget. Read-only and
// offline; voter text is only ever text nodes.

import { getContact } from '../contacts/contactStore.js';
import { fieldText } from '../card/voterCard.js';
import { el, textFrom, setNotice } from '../ui/dom.js';

export const HOUSEHOLD_CARD_STATES = Object.freeze(['loading', 'empty', 'error', 'success']);

// Copy used where deps.strings lacks a key; tests catch drift from the table.
export const HOUSEHOLD_TEXT = Object.freeze({
  roll_house: 'मकान नं.',
  roll_age: 'उम्र',
  roll_retry: 'फिर से कोशिश करें',
  roll_error_contact: 'फिर भी न खुले तो अपने समन्वयक से संपर्क करें।',
  search_serial: 'क्रम',
  search_filter_tag: 'टैग',
  search_filter_visit: 'संपर्क की स्थिति',
  household_members: 'सदस्य',
  household_list_label: 'परिवार के सदस्य',
  household_phone: 'फ़ोन',
  household_loading: 'परिवार के सदस्यों का नंबर, टैग और संपर्क की स्थिति पढ़ी जा रही है…',
  household_empty: 'लोड किए गए वार्ड में इस नंबर का कोई मकान नहीं मिला। मकान नंबर जाँचें, या ऊपर सही वार्ड चुनकर उसकी सूची लोड करें।',
  household_failed: 'इस परिवार की जानकारी नहीं पढ़ी जा सकी। दोबारा कोशिश करें, या पेज फिर खोलें।',
});

const defaultContacts = { getContact };

/**
 * Render a household (from householdIndex.js, or null) into `container`.
 * deps: getMemberStatus(ward, serial) -> {tag, visit}, onOpenMember, contacts
 * {getContact} (default contactStore.js), strings, doc, log.
 */
export function renderHouseholdCard(container, household, deps = {}) {
  const doc = deps.doc || container.ownerDocument || globalThis.document;
  const text = textFrom(deps.strings, HOUSEHOLD_TEXT);
  const contacts = deps.contacts || defaultContacts;
  const log = deps.log || ((err) => console.error(err));
  const members = household && Array.isArray(household.members) ? household.members : [];
  const ward = household ? household.ward : null;

  const root = el(doc, 'section', 'panel household-card');
  root.setAttribute('lang', 'hi');
  const message = el(doc, 'p', 'notice household-message');
  message.setAttribute('role', 'status');
  const contactLine = el(doc, 'p', 'roll-contact household-contact', text('roll_error_contact'));
  contactLine.hidden = true;
  const retryButton = el(doc, 'button', 'btn-secondary status-retry household-retry', text('roll_retry'));
  retryButton.setAttribute('type', 'button');
  retryButton.hidden = true;
  const list = el(doc, 'ul', 'household-members');
  list.setAttribute('aria-label', text('household_list_label'));

  if (household) {
    const header = el(doc, 'div', 'panel-header');
    const heading = el(doc, 'div', 'panel-heading');
    heading.appendChild(el(doc, 'h2', 'panel-title', `${text('roll_house')} ${fieldText(household.house)}`));
    heading.appendChild(el(doc, 'p', 'panel-subtitle household-count', `${members.length} ${text('household_members')}`));
    header.appendChild(heading);
    root.appendChild(header);
  }
  root.appendChild(message);
  root.appendChild(contactLine);
  root.appendChild(retryButton);
  root.appendChild(list);
  container.replaceChildren(root);

  const view = { root, message, list, retryButton, state: 'loading', ready: null, reload };

  function setState(next) {
    view.state = next;
    root.setAttribute('data-state', next);
    if (next === 'loading') root.setAttribute('aria-busy', 'true');
    else root.removeAttribute('aria-busy');
    contactLine.hidden = next !== 'error';
    retryButton.hidden = next !== 'error';
    list.hidden = next !== 'success';
    if (next === 'loading') setNotice(message, text('household_loading'), 'info');
    else if (next === 'empty') setNotice(message, text('household_empty'), 'info');
    else if (next === 'error') setNotice(message, text('household_failed'), 'error');
    else setNotice(message, '');
    message.setAttribute('role', next === 'error' ? 'alert' : 'status');
  }

  function field(className, label, value) {
    const node = el(doc, 'span', `household-member-field ${className}`);
    node.appendChild(el(doc, 'span', 'household-member-label', label));
    node.appendChild(doc.createTextNode(' '));
    node.appendChild(el(doc, 'span', 'household-member-value', fieldText(value)));
    return node;
  }

  function renderRow(member, contact, status) {
    const item = el(doc, 'li', 'household-member-item');
    const row = el(doc, 'button', 'list-row household-member');
    row.setAttribute('type', 'button');
    row.setAttribute('data-serial', fieldText(member.serial));

    const head = el(doc, 'span', 'search-row-head household-member-head');
    head.appendChild(el(doc, 'span', 'search-serial household-member-serial', `${text('search_serial')} ${fieldText(member.serial)}`));
    head.appendChild(el(doc, 'span', 'household-member-name', fieldText(member.name)));
    row.appendChild(head);

    const meta = el(doc, 'span', 'search-row-meta household-member-meta');
    meta.appendChild(el(doc, 'span', 'household-member-relative', fieldText(member.relative)));
    meta.appendChild(el(doc, 'span', 'household-member-age', `${text('roll_age')} ${fieldText(member.age)}`));
    meta.appendChild(el(doc, 'span', 'household-member-gender', fieldText(member.gender)));
    row.appendChild(meta);

    const s = status && typeof status === 'object' ? status : {};
    const fields = el(doc, 'span', 'search-row-head household-member-fields');
    fields.appendChild(field('household-member-phone', text('household_phone'), contact && contact.phone));
    fields.appendChild(field('badge household-member-tag', text('search_filter_tag'), s.tag));
    fields.appendChild(field('badge household-member-visit', text('search_filter_visit'), s.visit ?? s.visitStatus));
    row.appendChild(fields);

    row.addEventListener('click', () => {
      if (typeof deps.onOpenMember === 'function') deps.onOpenMember({ ward, serial: member.serial });
    });
    item.appendChild(row);
    return item;
  }

  function readMember(member) {
    const status = typeof deps.getMemberStatus === 'function'
      ? Promise.resolve().then(() => deps.getMemberStatus(ward, member.serial))
      : Promise.resolve(null);
    const contact = Promise.resolve().then(() => contacts.getContact(ward, member.serial));
    return Promise.all([contact, status]);
  }

  let generation = 0;

  async function reload() {
    if (!household) {
      setState('empty');
      return;
    }
    const mine = ++generation;
    setState('loading');
    let results;
    try {
      results = await Promise.all(members.map(readMember));
    } catch (err) {
      if (mine !== generation) return;
      log(err);
      setState('error');
      return;
    }
    if (mine !== generation) return;
    list.replaceChildren(...members.map((member, i) => renderRow(member, results[i][0], results[i][1])));
    setState('success');
  }

  retryButton.addEventListener('click', () => { reload(); });

  view.ready = reload();
  return view;
}
