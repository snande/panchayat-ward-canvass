// Voter card: one roll entry with a consent box gating the phone number.
//
// The phone input and save button stay disabled until the voter's consent is
// on record: ticking the box awaits recordConsent before unlocking them, and
// unticking it clears and locks the number, then calls revokeConsent (which
// deletes the record). State comes from the on-device contact store
// (src/contacts/contactStore.js), so the card makes no network request.

import { el } from './dom.js';
import * as contactStore from '../contacts/contactStore.js';
import { normalisePhone } from '../contacts/contactStore.js';

function setDisabled(node, disabled) {
  if (disabled) node.setAttribute('disabled', '');
  else node.removeAttribute('disabled');
}

/**
 * Mount the card for a roll entry ({serial, name, relative, age, house}).
 * opts.wardId is the contact-store ward id (wardKeyFor of the selection);
 * opts.store defaults to the contactStore module; opts.onClose, when given,
 * adds a close button that calls it.
 * @returns {{root, consent, phone, save, message, ready: Promise<void>, whenIdle: () => Promise<void>, destroy: () => void}}
 */
export function mountVoterCard(container, entry, strings, opts = {}) {
  const doc = container.ownerDocument;
  const text = (key) => (strings && Object.prototype.hasOwnProperty.call(strings, key) ? strings[key] : '');
  const store = opts.store || contactStore;
  const log = opts.log || ((...args) => console.error(...args));
  const { wardId } = opts;
  const { serial } = entry;

  const root = el(doc, 'article', 'voter-card');
  root.setAttribute('lang', 'hi');

  const head = el(doc, 'div', 'voter-card-head');
  head.appendChild(el(doc, 'h2', 'voter-card-name', `${serial}. ${entry.name ?? ''}`));
  let close = null;
  if (typeof opts.onClose === 'function') {
    close = el(doc, 'button', 'voter-card-close', text('contact_close'));
    close.setAttribute('type', 'button');
    head.appendChild(close);
  }
  root.appendChild(head);

  root.appendChild(el(doc, 'p', 'voter-card-relative', entry.relative ?? ''));
  const parts = [];
  if (entry.age != null) parts.push(`${text('roll_age')} ${entry.age}`);
  if (entry.house) parts.push(`${text('roll_house')} ${entry.house}`);
  root.appendChild(el(doc, 'p', 'voter-card-meta', parts.join(' · ')));

  const consentRow = el(doc, 'label', 'voter-card-consent');
  const consent = el(doc, 'input', 'voter-card-consent-box');
  consent.setAttribute('type', 'checkbox');
  consent.checked = false;
  consentRow.appendChild(consent);
  consentRow.appendChild(el(doc, 'span', null, text('contact_consent_label')));
  root.appendChild(consentRow);

  const field = el(doc, 'label', 'voter-card-field');
  field.appendChild(el(doc, 'span', 'voter-card-label', text('contact_phone_label')));
  const phone = el(doc, 'input', 'voter-card-phone');
  phone.setAttribute('type', 'tel');
  phone.setAttribute('inputmode', 'numeric');
  phone.setAttribute('autocomplete', 'off');
  field.appendChild(phone);
  root.appendChild(field);

  const save = el(doc, 'button', 'btn-primary voter-card-save', text('contact_save'));
  save.setAttribute('type', 'button');
  root.appendChild(save);

  const message = el(doc, 'p', 'voter-card-message');
  message.setAttribute('aria-live', 'polite');
  root.appendChild(message);

  container.appendChild(root);

  let consented = false;
  let loaded = false;
  let busy = false;
  let pending = Promise.resolve();

  function sync() {
    // While a change is in flight the box keeps showing what was asked for.
    if (!busy) consent.checked = consented;
    setDisabled(consent, !loaded || busy);
    setDisabled(phone, !consented || busy);
    setDisabled(save, !consented || busy);
  }

  function show(key, role) {
    message.textContent = text(key);
    message.setAttribute('role', role);
    message.setAttribute('class', role === 'alert' ? 'voter-card-message voter-card-message-error' : 'voter-card-message');
  }

  function clearMessage() {
    message.textContent = '';
    message.removeAttribute('role');
  }

  // Run one store operation with every control locked until it settles.
  function run(task) {
    busy = true;
    sync();
    pending = (async () => {
      try {
        await task();
      } catch (err) {
        log('contact could not be updated', err);
        show('contact_failed', 'alert');
      } finally {
        busy = false;
        sync();
      }
    })();
    return pending;
  }

  function onConsentChange() {
    const want = Boolean(consent.checked);
    if (busy || !loaded || want === consented) {
      consent.checked = consented;
      return;
    }
    clearMessage();
    if (!want) {
      // Clear and lock first, so nothing can be saved while consent is withdrawn.
      phone.value = '';
      setDisabled(phone, true);
      setDisabled(save, true);
    }
    run(async () => {
      if (want) await store.recordConsent(wardId, serial);
      else await store.revokeConsent(wardId, serial);
      consented = want;
    });
  }

  function onSave() {
    if (busy || !consented) return;
    const digits = normalisePhone(phone.value);
    if (!digits) {
      show('contact_invalid_phone', 'alert');
      return;
    }
    clearMessage();
    run(async () => {
      const saved = await store.saveNumber(wardId, serial, digits);
      phone.value = saved.phone;
      show('contact_saved', 'status');
    });
  }

  function onClose() {
    opts.onClose();
  }

  sync();
  const ready = (async () => {
    try {
      const contact = await store.getContact(wardId, serial);
      if (contact) {
        consented = true;
        phone.value = contact.phone || '';
      }
    } catch (err) {
      log('contact could not be read', err);
      show('contact_failed', 'alert');
    } finally {
      loaded = true;
      sync();
    }
  })();
  pending = ready;

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
    whenIdle: () => pending,
    destroy() {
      consent.removeEventListener('change', onConsentChange);
      save.removeEventListener('click', onSave);
      if (close) close.removeEventListener('click', onClose);
      if (root.parentNode === container) container.removeChild(root);
    },
  };
}
