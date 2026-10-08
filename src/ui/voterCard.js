// Voter card (issue #42): one roll entry with a consent checkbox that gates
// the phone-number field. Opened by tapping a result in the search screen
// (src/ui/rollSearch.js wires it).
//
// The phone input and save button carry the `disabled` attribute until the
// voter's consent is on record. Marking consent first awaits recordConsent and
// only then unlocks the field. Unmarking asks for a second, explicit yes (it
// deletes the number), then calls revokeConsent, clears the number and locks
// the field again. Everything goes through the contact store on the device,
// so the card never touches the network. All text comes from the strings
// table. The layout is the shared panel of DESIGN.md, the same as the contact
// panel (src/ui/contactPanel.js).

import { normalisePhone } from '../contacts/contactStore.js';
import { el, panelHeader, setNotice, voterMeta } from './dom.js';

/**
 * @param {Element} container replaced with the card
 * @param {Record<string, string>} strings the Hindi string table
 * @param {{
 *   contacts: {getContact, recordConsent, saveNumber, revokeConsent},
 *   wardId: string, entry: {serial: number, name: string, relative?: string, age?: number, house?: string},
 *   onClose?: () => void, log?: Function,
 * }} opts
 * @returns {{root, ready: Promise<void>, consentInput, phoneInput, saveButton, closeButton,
 *   confirmBox, confirmRevokeButton, cancelRevokeButton, retryButton, message, reload: () => Promise<void>}}
 */
export function mountVoterCard(container, strings, opts) {
  const doc = container.ownerDocument;
  const text = (key) => (strings && Object.prototype.hasOwnProperty.call(strings, key) ? strings[key] : '');
  const { contacts, wardId, entry } = opts;
  const log = opts.log || ((...args) => console.error(...args));

  const root = el(doc, 'section', 'panel voter-card');
  root.setAttribute('lang', 'hi');
  const { header, closeButton } = panelHeader(doc, {
    title: entry.name, titleClass: 'voter-card-name',
    subtitle: voterMeta(entry, text), closeText: text('contact_close'), closeClass: 'contact-close',
  });
  root.appendChild(header);

  // Inputs sit inside their labels, so no element ids are needed.
  const consentRow = el(doc, 'label', 'choice voter-card-consent');
  const consentInput = el(doc, 'input', 'choice-input voter-card-consent-input');
  consentInput.setAttribute('type', 'checkbox');
  consentInput.checked = false;
  consentRow.appendChild(consentInput);
  consentRow.appendChild(el(doc, 'span', 'voter-card-consent-text', text('contact_consent_label')));

  const form = el(doc, 'form', 'voter-card-form');
  form.setAttribute('novalidate', '');
  const field = el(doc, 'label', 'picker-field');
  field.appendChild(el(doc, 'span', 'picker-label', text('contact_phone')));
  const phoneInput = el(doc, 'input', 'picker-select field-phone voter-card-phone');
  phoneInput.setAttribute('type', 'tel');
  phoneInput.setAttribute('inputmode', 'tel');
  phoneInput.setAttribute('autocomplete', 'off');
  phoneInput.setAttribute('maxlength', '16');
  field.appendChild(phoneInput);
  form.appendChild(field);
  const saveButton = el(doc, 'button', 'btn-primary voter-card-save', text('contact_save'));
  saveButton.setAttribute('type', 'submit');
  form.appendChild(saveButton);

  // The second step of unmarking: nothing is deleted until "yes" is tapped.
  const confirmBox = el(doc, 'div', 'alert contact-confirm');
  confirmBox.setAttribute('data-tone', 'error');
  confirmBox.setAttribute('role', 'alertdialog');
  confirmBox.appendChild(el(doc, 'p', 'contact-body', text('contact_revoke_confirm')));
  const confirmRevokeButton = el(doc, 'button', 'btn-danger contact-revoke-yes', text('contact_revoke_yes'));
  confirmRevokeButton.setAttribute('type', 'button');
  const cancelRevokeButton = el(doc, 'button', 'btn-secondary contact-revoke-no', text('contact_revoke_no'));
  cancelRevokeButton.setAttribute('type', 'button');
  confirmBox.appendChild(confirmRevokeButton);
  confirmBox.appendChild(cancelRevokeButton);
  confirmBox.hidden = true;

  const message = el(doc, 'p', 'notice contact-message');
  message.setAttribute('aria-live', 'polite');
  const retryButton = el(doc, 'button', 'btn-secondary voter-card-retry', text('roll_retry'));
  retryButton.setAttribute('type', 'button');
  retryButton.hidden = true;

  root.appendChild(consentRow);
  root.appendChild(form);
  root.appendChild(confirmBox);
  root.appendChild(message);
  root.appendChild(retryButton);
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
    confirmBox.hidden = true;
  }

  setLocked(true);
  consentInput.setAttribute('disabled', '');

  let busy = false;
  async function run(action, doneKey) {
    if (busy) return;
    busy = true;
    root.setAttribute('aria-busy', 'true');
    setNotice(message, '');
    try {
      showState(await action());
      setNotice(message, text(doneKey), 'success');
    } catch (err) {
      log('contact could not be saved', err);
      // Put the card back to what is really stored.
      try {
        showState((await contacts.getContact(wardId, entry.serial)) || null);
      } catch (readErr) {
        log('contact could not be read', readErr);
        showState(null);
        consentInput.setAttribute('disabled', '');
        retryButton.hidden = false;
      }
      setNotice(message, text('contact_failed'), 'error');
    } finally {
      busy = false;
      root.removeAttribute('aria-busy');
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
      // Keep the consent and the number until the explicit yes.
      consentInput.checked = true;
      setNotice(message, '');
      confirmBox.hidden = false;
    }
  });

  confirmRevokeButton.addEventListener('click', () => {
    run(async () => {
      await contacts.revokeConsent(wardId, entry.serial);
      return null;
    }, 'contact_revoked');
  });

  cancelRevokeButton.addEventListener('click', () => {
    confirmBox.hidden = true;
  });

  form.addEventListener('submit', (event) => {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    if (phoneInput.hasAttribute('disabled')) return;
    const phone = String(phoneInput.value || '');
    // The store's own rule, so a typo keeps what was typed and saves nothing.
    if (normalisePhone(phone) === null) {
      setNotice(message, text('contact_phone_invalid'), 'error');
      if (typeof phoneInput.focus === 'function') phoneInput.focus();
      return;
    }
    run(() => contacts.saveNumber(wardId, entry.serial, phone), 'contact_saved');
  });

  closeButton.addEventListener('click', () => {
    container.replaceChildren();
    if (typeof opts.onClose === 'function') opts.onClose();
  });

  // Read the stored state. A failed read keeps the card locked, with the
  // consent box off, and offers a retry.
  function reload() {
    retryButton.hidden = true;
    setNotice(message, text('contact_loading'));
    return Promise.resolve()
      .then(() => contacts.getContact(wardId, entry.serial))
      .then((contact) => {
        showState(contact || null);
        consentInput.removeAttribute('disabled');
        setNotice(message, '');
      }, (err) => {
        log('contact could not be read', err);
        setNotice(message, text('contact_failed'), 'error');
        retryButton.hidden = false;
      });
  }
  retryButton.addEventListener('click', () => { reload(); });

  const ready = reload();

  return {
    root, ready, consentInput, phoneInput, saveButton, closeButton,
    confirmBox, confirmRevokeButton, cancelRevokeButton, retryButton, message, reload,
  };
}
