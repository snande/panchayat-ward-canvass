// Consent-first phone capture for one voter (issue #44), opened by tapping a
// voter in the ward roll (src/ui/rollSearch.js).
//
// Until the voter's consent is on record the panel offers only the consent
// button; the number field appears after it. Saving a number, recording or
// revoking consent go through src/contacts/contactSync.js, which writes the
// encrypted contact store on the device and queues the change for the team,
// so every step works offline. All text comes from the strings table.

import { el } from './dom.js';

/**
 * @param {Element} container replaced with the panel
 * @param {Record<string, string>} strings the Hindi string table
 * @param {{
 *   contacts: {getContact, recordConsent, saveNumber, revokeConsent},
 *   wardId: string, entry: {serial: number, name: string},
 *   onClose?: () => void, log?: Function,
 * }} opts
 * @returns {{root, ready: Promise<void>, consentButton, phoneInput, saveButton, revokeButton, closeButton, message}}
 */
export function mountContactPanel(container, strings, opts) {
  const doc = container.ownerDocument;
  const text = (key) => (strings && Object.prototype.hasOwnProperty.call(strings, key) ? strings[key] : '');
  const { contacts, wardId, entry } = opts;
  const log = opts.log || ((...args) => console.error(...args));

  const root = el(doc, 'section', 'contact-panel');
  root.setAttribute('lang', 'hi');
  root.appendChild(el(doc, 'h2', 'contact-title', `${entry.serial}. ${entry.name}`));

  const ask = el(doc, 'p', 'contact-body', text('contact_consent_ask'));
  const consentButton = el(doc, 'button', 'btn-primary contact-consent', text('contact_consent_action'));
  consentButton.setAttribute('type', 'button');

  const form = el(doc, 'form', 'contact-form');
  form.setAttribute('novalidate', '');
  const row = el(doc, 'div', 'picker-field');
  const label = el(doc, 'label', 'picker-label', text('contact_phone'));
  label.setAttribute('for', 'contact-phone');
  const phoneInput = el(doc, 'input', 'picker-select');
  phoneInput.setAttribute('id', 'contact-phone');
  phoneInput.setAttribute('type', 'tel');
  phoneInput.setAttribute('inputmode', 'tel');
  phoneInput.setAttribute('autocomplete', 'off');
  phoneInput.setAttribute('maxlength', '16');
  row.appendChild(label);
  row.appendChild(phoneInput);
  form.appendChild(row);
  const saveButton = el(doc, 'button', 'btn-primary contact-save', text('contact_save'));
  saveButton.setAttribute('type', 'submit');
  form.appendChild(saveButton);
  const revokeButton = el(doc, 'button', 'btn-secondary contact-revoke', text('contact_revoke'));
  revokeButton.setAttribute('type', 'button');
  form.appendChild(revokeButton);

  const message = el(doc, 'p', 'picker-message contact-message');
  message.setAttribute('aria-live', 'polite');
  const closeButton = el(doc, 'button', 'btn-secondary contact-close', text('contact_close'));
  closeButton.setAttribute('type', 'button');

  root.appendChild(ask);
  root.appendChild(consentButton);
  root.appendChild(form);
  root.appendChild(message);
  root.appendChild(closeButton);
  container.replaceChildren(root);

  // Consent on record shows the number form; otherwise only the consent ask.
  function showState(contact) {
    ask.hidden = Boolean(contact);
    consentButton.hidden = Boolean(contact);
    form.hidden = !contact;
    if (contact) phoneInput.value = contact.phone || '';
  }

  let busy = false;
  let acted = false;
  async function run(action, doneKey) {
    if (busy) return;
    busy = true;
    acted = true;
    message.textContent = '';
    try {
      showState(await action());
      message.textContent = text(doneKey);
    } catch (err) {
      log('contact could not be saved', err);
      message.textContent = text('contact_failed');
    } finally {
      busy = false;
    }
  }

  consentButton.addEventListener('click', () => {
    run(() => contacts.recordConsent(wardId, entry.serial), 'contact_consent_done');
  });

  form.addEventListener('submit', (event) => {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    const phone = String(phoneInput.value || '');
    // A number is checked here first so a typo keeps what was typed.
    if (!/^(\+91|0)?\d{10}$/.test(phone.replace(/ /g, ''))) {
      message.textContent = text('contact_phone_invalid');
      return;
    }
    run(() => contacts.saveNumber(wardId, entry.serial, phone), 'contact_saved');
  });

  revokeButton.addEventListener('click', () => {
    run(async () => {
      await contacts.revokeConsent(wardId, entry.serial);
      return null;
    }, 'contact_revoked');
  });

  closeButton.addEventListener('click', () => {
    container.replaceChildren();
    if (typeof opts.onClose === 'function') opts.onClose();
  });

  showState(null);
  const ready = Promise.resolve()
    .then(() => contacts.getContact(wardId, entry.serial))
    .then((contact) => {
      // A tap made before the read finished already shows the newer state.
      if (!acted) showState(contact);
    }, (err) => {
      log('contact could not be read', err);
      message.textContent = text('contact_failed');
    });

  return { root, ready, consentButton, phoneInput, saveButton, revokeButton, closeButton, message };
}
