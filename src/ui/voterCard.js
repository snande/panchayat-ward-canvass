// One voter's card: roll details plus the consent-gated mobile number.
//
// The number field and the save button carry the `disabled` attribute until
// the voter's consent is on record: marking the consent box records it with
// recordConsent first and only then unlocks the field; unmarking it locks and
// clears the field and revokes the consent (deleting any saved number). The
// card's state is read back with getContact on open, so a saved number shows
// again whenever the card is reopened. Everything goes through the on-device
// contact store (src/contacts/contactStore.js); nothing here uses the network.
// Every label comes from the Hindi string table.

import { el } from './dom.js';
import * as contactStore from '../contacts/contactStore.js';
import { normalisePhone } from '../contacts/contactStore.js';

const defaultContacts = {
  getContact: contactStore.getContact,
  recordConsent: contactStore.recordConsent,
  saveNumber: contactStore.saveNumber,
  revokeConsent: contactStore.revokeConsent,
};

function setDisabled(node, disabled) {
  if (disabled) node.setAttribute('disabled', '');
  else node.removeAttribute('disabled');
}

/**
 * Mount the card into container (replacing its content).
 * @param {object} entry a roll entry {serial, name, relative, age, house}; the
 *   search screen's {relativeName, houseNo} field names are accepted too
 * @param {Record<string,string>} strings the Hindi string table
 * @param {{wardId: string, contacts?: object, onClose?: Function}} opts
 *   contacts defaults to the contact store's module functions (tests pass a
 *   store from createContactStore); onClose adds a close button
 * @returns {{root, consent, phone, save, message, ready: Promise<void>,
 *   idle: () => Promise<void>, destroy: () => void}}
 */
export function mountVoterCard(container, entry, strings, opts = {}) {
  const doc = container.ownerDocument;
  const text = (key) => (strings && Object.prototype.hasOwnProperty.call(strings, key) ? strings[key] : '');
  const contacts = opts.contacts || defaultContacts;
  const wardId = opts.wardId;
  const serial = entry.serial;
  const relative = entry.relative ?? entry.relativeName ?? '';
  const house = entry.house ?? entry.houseNo ?? '';

  const root = el(doc, 'article', 'voter-card');
  root.setAttribute('lang', 'hi');
  root.setAttribute('aria-label', text('voter_card_label'));

  root.appendChild(el(doc, 'h2', 'voter-card__name', entry.name ?? ''));
  root.appendChild(el(doc, 'p', 'voter-card__relative', `${text('roll_relative')}: ${relative}`));
  const meta = [];
  if (entry.age != null && entry.age !== '') meta.push(`${text('roll_age')} ${entry.age}`);
  if (house !== '') meta.push(`${text('roll_house')} ${house}`);
  root.appendChild(el(doc, 'p', 'voter-card__meta', meta.join(' · ')));

  const consentRow = el(doc, 'label', 'voter-card__consent');
  const consent = el(doc, 'input', 'voter-card__checkbox');
  consent.setAttribute('type', 'checkbox');
  consent.checked = false;
  consentRow.appendChild(consent);
  consentRow.appendChild(el(doc, 'span', 'voter-card__consent-text', text('contact_consent_label')));
  root.appendChild(consentRow);

  const field = el(doc, 'label', 'voter-card__field');
  field.appendChild(el(doc, 'span', 'voter-card__label', text('contact_phone_label')));
  const phone = el(doc, 'input', 'voter-card__phone');
  phone.setAttribute('type', 'tel');
  phone.setAttribute('inputmode', 'numeric');
  phone.setAttribute('autocomplete', 'off');
  phone.setAttribute('maxlength', '14');
  field.appendChild(phone);
  root.appendChild(field);

  const save = el(doc, 'button', 'btn-primary voter-card__save', text('contact_save'));
  save.setAttribute('type', 'button');
  root.appendChild(save);

  const message = el(doc, 'p', 'voter-card__message');
  message.setAttribute('role', 'status');
  message.setAttribute('aria-live', 'polite');
  root.appendChild(message);

  let close = null;
  if (typeof opts.onClose === 'function') {
    close = el(doc, 'button', 'voter-card__close', text('voter_card_close'));
    close.setAttribute('type', 'button');
    root.appendChild(close);
  }

  container.replaceChildren(root);

  const state = { loaded: false, consented: false, busy: false };
  let destroyed = false;

  // The field is unlocked only while consent is on record; the consent box
  // waits for the stored state to load and for each change to finish.
  function sync() {
    setDisabled(consent, !state.loaded || state.busy);
    setDisabled(phone, !state.consented);
    setDisabled(save, !state.consented || state.busy);
  }

  function say(key, isError = false) {
    message.textContent = key ? text(key) : '';
    message.setAttribute('class', isError ? 'voter-card__message voter-card__message--error' : 'voter-card__message');
    message.setAttribute('role', isError ? 'alert' : 'status');
  }

  // Operations run one after another, in the order the user made them.
  let queue = Promise.resolve();
  function track(fn) {
    const run = queue.then(() => (destroyed ? undefined : fn()));
    queue = run.catch(() => {});
    return run;
  }

  sync();

  const ready = track(async () => {
    try {
      const contact = await contacts.getContact(wardId, serial);
      if (destroyed) return;
      state.consented = Boolean(contact);
      consent.checked = state.consented;
      phone.value = contact && contact.phone ? contact.phone : '';
      state.loaded = true;
    } catch {
      // Stay locked: without the stored state no change can be recorded.
      if (!destroyed) say('contact_load_failed', true);
    }
    if (!destroyed) sync();
  });

  function onConsentChange() {
    const want = Boolean(consent.checked);
    return track(async () => {
      if (want === state.consented) return;
      const previous = phone.value;
      state.busy = true;
      say(null);
      if (!want) {
        // Lock and clear at once; the stored record goes next.
        state.consented = false;
        phone.value = '';
        phone.removeAttribute('aria-invalid');
      }
      sync();
      try {
        if (want) {
          await contacts.recordConsent(wardId, serial);
          state.consented = true;
        } else {
          await contacts.revokeConsent(wardId, serial);
        }
      } catch {
        if (!want) {
          state.consented = true;
          phone.value = previous;
        }
        consent.checked = state.consented;
        say('contact_save_failed', true);
      }
      state.busy = false;
      if (!destroyed) sync();
    });
  }

  function onSave() {
    return track(async () => {
      if (!state.consented || state.busy) return;
      const digits = normalisePhone(phone.value);
      if (!digits) {
        phone.setAttribute('aria-invalid', 'true');
        say('contact_phone_invalid', true);
        return;
      }
      phone.removeAttribute('aria-invalid');
      state.busy = true;
      sync();
      try {
        const saved = await contacts.saveNumber(wardId, serial, digits);
        phone.value = saved && saved.phone ? saved.phone : digits;
        say('contact_saved');
      } catch {
        say('contact_save_failed', true);
      }
      state.busy = false;
      if (!destroyed) sync();
    });
  }

  function onClose() {
    opts.onClose();
  }

  consent.addEventListener('change', onConsentChange);
  save.addEventListener('click', onSave);
  if (close) close.addEventListener('click', onClose);

  return {
    root,
    consent,
    phone,
    save,
    message,
    ready,
    /** Resolves once every change made so far has been stored. */
    idle: () => queue,
    destroy() {
      destroyed = true;
      consent.removeEventListener('change', onConsentChange);
      save.removeEventListener('click', onSave);
      if (close) close.removeEventListener('click', onClose);
      if (root.parentNode === container) container.removeChild(root);
    },
  };
}
