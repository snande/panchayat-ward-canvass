// Voter card (issue #42): one roll entry with a consent checkbox that gates
// the phone-number field. Opened by tapping a result in the search screen
// (src/ui/rollSearch.js wires it).
//
// The phone input and save button carry the `disabled` attribute until the
// voter's consent is on record. Marking consent first awaits recordConsent and
// only then unlocks the field; unmarking calls revokeConsent, clears the
// number and locks the field again. Everything goes through the contact store
// on the device, so the card never touches the network. All text comes from
// the strings table.

import { el } from './dom.js';

const PHONE_PATTERN = /^(\+91|0)?\d{10}$/;

/**
 * @param {Element} container replaced with the card
 * @param {Record<string, string>} strings the Hindi string table
 * @param {{
 *   contacts: {getContact, recordConsent, saveNumber, revokeConsent},
 *   wardId: string, entry: {serial: number, name: string, relative?: string, age?: number, house?: string},
 *   onClose?: () => void, log?: Function,
 * }} opts
 * @returns {{root, ready: Promise<void>, consentInput, phoneInput, saveButton, closeButton, message}}
 */
export function mountVoterCard(container, strings, opts) {
  const doc = container.ownerDocument;
  const text = (key) => (strings && Object.prototype.hasOwnProperty.call(strings, key) ? strings[key] : '');
  const { contacts, wardId, entry } = opts;
  const log = opts.log || ((...args) => console.error(...args));

  const root = el(doc, 'section', 'voter-card');
  root.setAttribute('lang', 'hi');
  root.appendChild(el(doc, 'h2', 'voter-card-name', entry.name));
  const meta = [];
  if (entry.relative) meta.push(entry.relative);
  if (entry.age != null) meta.push(`${text('roll_age')} ${entry.age}`);
  if (entry.house) meta.push(`${text('roll_house')} ${entry.house}`);
  root.appendChild(el(doc, 'p', 'voter-card-meta', meta.join(' · ')));

  const consentRow = el(doc, 'label', 'voter-card-consent');
  const consentInput = el(doc, 'input', 'voter-card-consent-input');
  consentInput.setAttribute('type', 'checkbox');
  consentInput.setAttribute('id', 'voter-card-consent');
  consentInput.checked = false;
  consentRow.setAttribute('for', 'voter-card-consent');
  consentRow.appendChild(consentInput);
  consentRow.appendChild(el(doc, 'span', 'voter-card-consent-text', text('contact_consent_label')));

  const form = el(doc, 'form', 'voter-card-form');
  form.setAttribute('novalidate', '');
  const field = el(doc, 'div', 'picker-field');
  const label = el(doc, 'label', 'picker-label', text('contact_phone'));
  label.setAttribute('for', 'voter-card-phone');
  const phoneInput = el(doc, 'input', 'picker-select voter-card-phone');
  phoneInput.setAttribute('id', 'voter-card-phone');
  phoneInput.setAttribute('type', 'tel');
  phoneInput.setAttribute('inputmode', 'tel');
  phoneInput.setAttribute('autocomplete', 'off');
  phoneInput.setAttribute('maxlength', '16');
  field.appendChild(label);
  field.appendChild(phoneInput);
  form.appendChild(field);
  const saveButton = el(doc, 'button', 'btn-primary voter-card-save', text('contact_save'));
  saveButton.setAttribute('type', 'submit');
  form.appendChild(saveButton);

  const message = el(doc, 'p', 'picker-message contact-message');
  message.setAttribute('aria-live', 'polite');
  const closeButton = el(doc, 'button', 'btn-secondary contact-close', text('contact_close'));
  closeButton.setAttribute('type', 'button');

  root.appendChild(consentRow);
  root.appendChild(form);
  root.appendChild(message);
  root.appendChild(closeButton);
  container.replaceChildren(root);

  function setLocked(locked) {
    for (const node of [phoneInput, saveButton]) {
      if (locked) node.setAttribute('disabled', '');
      else node.removeAttribute('disabled');
    }
  }

  // contact: the stored record, or null while consent is not on record.
  function showState(contact) {
    consentInput.checked = Boolean(contact);
    phoneInput.value = contact ? contact.phone || '' : '';
    setLocked(!contact);
  }

  setLocked(true);
  consentInput.setAttribute('disabled', '');

  let busy = false;
  async function run(action, doneKey) {
    if (busy) return;
    busy = true;
    message.textContent = '';
    try {
      showState(await action());
      message.textContent = text(doneKey);
    } catch (err) {
      log('contact could not be saved', err);
      // Put the card back to what is really stored.
      try {
        showState((await contacts.getContact(wardId, entry.serial)) || null);
      } catch (readErr) {
        log('contact could not be read', readErr);
      }
      message.textContent = text('contact_failed');
    } finally {
      busy = false;
    }
  }

  consentInput.addEventListener('change', () => {
    if (busy) {
      consentInput.checked = !consentInput.checked;
      return;
    }
    if (consentInput.checked) {
      // Unlock only after the consent is on record.
      run(() => contacts.recordConsent(wardId, entry.serial), 'contact_consent_done');
    } else {
      setLocked(true);
      run(async () => {
        await contacts.revokeConsent(wardId, entry.serial);
        return null;
      }, 'contact_revoked');
    }
  });

  form.addEventListener('submit', (event) => {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    if (phoneInput.hasAttribute('disabled')) return;
    const phone = String(phoneInput.value || '');
    if (!PHONE_PATTERN.test(phone.replace(/ /g, ''))) {
      message.textContent = text('contact_phone_invalid');
      return;
    }
    run(() => contacts.saveNumber(wardId, entry.serial, phone), 'contact_saved');
  });

  closeButton.addEventListener('click', () => {
    container.replaceChildren();
    if (typeof opts.onClose === 'function') opts.onClose();
  });

  message.textContent = text('contact_loading');
  const ready = Promise.resolve()
    .then(() => contacts.getContact(wardId, entry.serial))
    .then((contact) => {
      showState(contact || null);
      consentInput.removeAttribute('disabled');
      message.textContent = '';
    }, (err) => {
      log('contact could not be read', err);
      message.textContent = text('contact_failed');
    });

  return { root, ready, consentInput, phoneInput, saveButton, closeButton, message };
}
