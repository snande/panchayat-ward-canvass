// Consent and phone numbers shared with the candidate's team (issue #44).
//
// Every change made through this module is written to the encrypted contact
// store (src/contacts/contactStore.js) first and then queued for the team in
// the sync engine's encrypted outbox (src/sync/syncEngine.js), so it works in
// airplane mode and reaches the team on the next sync after the phone is back
// online.
//
// - A voter's sync record has id `contact:${wardId}:${serial}`, updatedAt
//   the ISO time of the change, and data {wardId, serial, phone, consentAt,
//   revoked}. A revoked consent travels as a record with revoked: true and no
//   number, so teammates' devices delete their copy too.
// - Records pulled from the team (only this candidate's team: the sync
//   engine drops anything the team key cannot open, and it hands over only
//   records newer than this device's own) are applied to the contact store
//   by applyRemote(): a revocation deletes the voter's record, anything else
//   replaces it with the teammate's consent time and number.

import * as defaultContacts from './contactStore.js';
import { contactKeyFor, normalisePhone } from './contactStore.js';
import { enqueue, onRemoteRecords } from '../sync/syncEngine.js';

export const CONTACT_RECORD_PREFIX = 'contact:';

/** Sync record id of a voter's consent. */
export function contactRecordId(wardId, serial) {
  return CONTACT_RECORD_PREFIX + contactKeyFor(wardId, serial);
}

// A pulled record -> {wardId, serial, phone, consentAt, revoked}, or null
// when it is not a well-formed contact record.
function contactFromRecord(record) {
  if (!record || typeof record.id !== 'string' || !record.id.startsWith(CONTACT_RECORD_PREFIX)) return null;
  const data = record.data;
  if (!data || typeof data !== 'object') return null;
  const { wardId, serial } = data;
  if (typeof wardId !== 'string' || !Number.isSafeInteger(serial) || serial < 0) return null;
  if (contactRecordId(wardId, serial) !== record.id) return null;
  if (data.revoked === true) return { wardId, serial, phone: null, consentAt: null, revoked: true };
  if (typeof data.consentAt !== 'string' || !data.consentAt) return null;
  const phone = data.phone === null || data.phone === undefined ? null : normalisePhone(data.phone);
  if (data.phone != null && !phone) return null;
  return { wardId, serial, phone, consentAt: data.consentAt, revoked: false };
}

/**
 * @param {{
 *   contacts?: {recordConsent, saveNumber, getContact, revokeConsent, putSyncedContact},
 *   engine?: {enqueue: Function, onRemoteRecords: Function},
 *   now?: () => string, log?: Function,
 * }} [deps] defaults to the device's contact store and sync engine; tests pass their own
 */
export function createContactSync({
  contacts = defaultContacts,
  engine = { enqueue, onRemoteRecords },
  now = () => new Date().toISOString(),
  log = (...args) => console.error(...args),
} = {}) {
  // The change is already saved on the device; a failure to queue it is
  // logged rather than reported as a failed save.
  async function share(contact, revoked = false) {
    const data = revoked
      ? { wardId: contact.wardId, serial: contact.serial, phone: null, consentAt: null, revoked: true }
      : { wardId: contact.wardId, serial: contact.serial, phone: contact.phone, consentAt: contact.consentAt, revoked: false };
    try {
      await engine.enqueue({ id: contactRecordId(contact.wardId, contact.serial), updatedAt: now(), data });
    } catch (err) {
      log('contact change could not be queued for the team', err);
    }
  }

  /** contactStore.recordConsent, then queued for the team. */
  async function recordConsent(wardId, serial) {
    const contact = await contacts.recordConsent(wardId, serial);
    await share(contact);
    return contact;
  }

  /** contactStore.saveNumber, then queued for the team. */
  async function saveNumber(wardId, serial, phone) {
    const contact = await contacts.saveNumber(wardId, serial, phone);
    await share(contact);
    return contact;
  }

  /** contactStore.revokeConsent, then queued for the team so their copies go too. */
  async function revokeConsent(wardId, serial) {
    await contacts.revokeConsent(wardId, serial);
    const n = typeof serial === 'string' ? Number(serial) : serial;
    await share({ wardId, serial: n }, true);
  }

  async function getContact(wardId, serial) {
    return contacts.getContact(wardId, serial);
  }

  /** Apply records pulled from the team; other record types are ignored. Returns how many applied. */
  async function applyRemote(records) {
    let applied = 0;
    for (const record of records || []) {
      const contact = contactFromRecord(record);
      if (!contact) continue;
      try {
        if (contact.revoked) await contacts.revokeConsent(contact.wardId, contact.serial);
        else await contacts.putSyncedContact(contact.wardId, contact.serial, contact);
        applied += 1;
      } catch (err) {
        log('a synced contact could not be stored', err);
      }
    }
    return applied;
  }

  /** Apply every later pull to the contact store; returns an unsubscribe function. */
  function listen() {
    return engine.onRemoteRecords(applyRemote);
  }

  return { recordConsent, saveNumber, revokeConsent, getContact, applyRemote, listen };
}
