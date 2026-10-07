// Encrypted, consent-gated phone numbers of voters, kept on the device.
//
// - A phone number can only be saved for a voter whose consent was recorded
//   first; revoking consent deletes the voter's record.
// - Each record in the `contacts` object store is {wardId, serial, iv, ct},
//   keyed by `${wardId}:${serial}`. Only the ward and serial are in clear;
//   `ct` is the WebCrypto AES-GCM encryption (the shared 256-bit device key,
//   fresh 12-byte IV per write, the record key as additional data) of
//   JSON.stringify({phone, consentAt}). No roll field (name, relative,
//   house...) is ever stored here.
// - The first saved number asks the browser to keep the data
//   (navigator.storage.persist()) so it is not evicted while offline.
//
// No network access: every operation works offline, with `fetch` undefined.

import { CONTACTS_STORE, complete, createDbOpener, readValue, request } from '../storage/deviceDb.js';
import { createDeviceKeyLoader } from '../crypto/deviceKey.js';

/**
 * Storage key of a voter's contact record. wardId never contains ':' and
 * serial is a whole number, so distinct voters never share a key.
 */
export function contactKeyFor(wardId, serial) {
  return `${wardId}:${serial}`;
}

/**
 * Normalise a mobile number to its 10 digits: spaces and a leading +91 or 0
 * are stripped. Returns null for anything else, including a number type
 * (which cannot keep a leading 0 or +91).
 */
export function normalisePhone(phone) {
  if (typeof phone !== 'string') return null;
  let digits = phone.replace(/ /g, '');
  if (digits.startsWith('+91')) digits = digits.slice(3);
  else if (digits.startsWith('0')) digits = digits.slice(1);
  return /^\d{10}$/.test(digits) ? digits : null;
}

/** Validate a voter reference; returns the serial as a number (5 and '5' are one voter). */
function voterSerial(wardId, serial) {
  if (typeof wardId !== 'string' || !wardId || wardId.includes(':')) {
    throw new TypeError('wardId must be a non-empty string without ":"');
  }
  const n = typeof serial === 'string' && /^\d+$/.test(serial) ? Number(serial) : serial;
  if (!Number.isSafeInteger(n) || n < 0) throw new TypeError('serial must be a whole number');
  return n;
}

/**
 * @param {{indexedDB?: IDBFactory, crypto?: Crypto, storage?: StorageManager | null}} [deps]
 *   defaults to the browser globals (`storage` to navigator.storage); tests pass fakes
 */
export function createContactStore({
  indexedDB = globalThis.indexedDB,
  crypto = globalThis.crypto,
  storage,
} = {}) {
  const encoder = new TextEncoder();
  const db = createDbOpener(indexedDB);
  const deviceKey = createDeviceKeyLoader({ db, crypto });
  let persistRequested = false;

  async function encrypt(id, payload) {
    const key = await deviceKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: encoder.encode(id) },
      key,
      encoder.encode(JSON.stringify(payload)),
    );
    return { iv, ct };
  }

  async function decrypt(id, record) {
    const key = await deviceKey();
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: record.iv, additionalData: encoder.encode(id) },
      key,
      record.ct,
    );
    const { phone, consentAt } = JSON.parse(new TextDecoder().decode(plain));
    return { phone: typeof phone === 'string' ? phone : null, consentAt };
  }

  async function load(wardId, serial) {
    const id = contactKeyFor(wardId, serial);
    const record = await readValue(db, CONTACTS_STORE, id);
    if (!record) return null;
    return { wardId, serial, ...(await decrypt(id, record)) };
  }

  async function write(wardId, serial, payload, { requireExisting }) {
    const id = contactKeyFor(wardId, serial);
    const { iv, ct } = await encrypt(id, payload);
    const tx = (await db()).transaction(CONTACTS_STORE, 'readwrite');
    const done = complete(tx);
    const store = tx.objectStore(CONTACTS_STORE);
    // Consent may have been revoked while encrypting: never resurrect it.
    const present = requireExisting ? Boolean(await request(store.get(id))) : true;
    if (present) store.put({ wardId, serial, iv, ct }, id);
    await done;
    if (!present) throw new Error('consent was revoked; the number was not saved');
  }

  function requestPersistence() {
    if (persistRequested) return;
    persistRequested = true;
    const manager = storage !== undefined ? storage : globalThis.navigator?.storage;
    if (!manager || typeof manager.persist !== 'function') return;
    try {
      Promise.resolve(manager.persist()).catch(() => {});
    } catch {
      // Persistence is best effort; the number is already saved.
    }
  }

  /**
   * Record the voter's consent (no number yet). Consent already on record is
   * kept as it is, with its original timestamp and any saved number.
   * @returns {Promise<{wardId, serial, phone: string | null, consentAt: string}>}
   */
  async function recordConsent(wardId, serial) {
    const n = voterSerial(wardId, serial);
    const existing = await load(wardId, n);
    if (existing) return existing;
    const consentAt = new Date().toISOString();
    await write(wardId, n, { phone: null, consentAt }, { requireExisting: false });
    return { wardId, serial: n, phone: null, consentAt };
  }

  /**
   * Save the voter's mobile number. Rejects, writing nothing, when the number
   * is not a 10-digit mobile number or no consent is on record.
   */
  async function saveNumber(wardId, serial, phone) {
    const n = voterSerial(wardId, serial);
    const digits = normalisePhone(phone);
    if (!digits) throw new TypeError('phone must be a 10-digit mobile number');
    const existing = await load(wardId, n);
    if (!existing) throw new Error('no consent recorded for this voter; the number was not saved');
    await write(wardId, n, { phone: digits, consentAt: existing.consentAt }, { requireExisting: true });
    requestPersistence();
    return { wardId, serial: n, phone: digits, consentAt: existing.consentAt };
  }

  /** The voter's number and consent timestamp, or null when no consent is on record. */
  async function getContact(wardId, serial) {
    return load(wardId, voterSerial(wardId, serial));
  }

  /** Revoke the voter's consent: their record, with any number, is deleted. */
  async function revokeConsent(wardId, serial) {
    const n = voterSerial(wardId, serial);
    const tx = (await db()).transaction(CONTACTS_STORE, 'readwrite');
    const done = complete(tx);
    tx.objectStore(CONTACTS_STORE).delete(contactKeyFor(wardId, n));
    await done;
  }

  /**
   * Store a voter's consent as a teammate's device recorded it (it arrives
   * through src/contacts/contactSync.js): its consent timestamp and number,
   * or null for none, replace what this device holds.
   */
  async function putSyncedContact(wardId, serial, { phone = null, consentAt } = {}) {
    const n = voterSerial(wardId, serial);
    if (typeof consentAt !== 'string' || !consentAt) throw new TypeError('consentAt must be a timestamp string');
    const digits = phone === null ? null : normalisePhone(phone);
    if (phone !== null && !digits) throw new TypeError('phone must be a 10-digit mobile number');
    await write(wardId, n, { phone: digits, consentAt }, { requireExisting: false });
    if (digits) requestPersistence();
    return { wardId, serial: n, phone: digits, consentAt };
  }

  return { recordConsent, saveNumber, getContact, revokeConsent, putSyncedContact };
}

let defaultStore = null;
const store = () => (defaultStore ||= createContactStore());

export const recordConsent = async (wardId, serial) => store().recordConsent(wardId, serial);
export const saveNumber = async (wardId, serial, phone) => store().saveNumber(wardId, serial, phone);
export const getContact = async (wardId, serial) => store().getContact(wardId, serial);
export const revokeConsent = async (wardId, serial) => store().revokeConsent(wardId, serial);
export const putSyncedContact = async (wardId, serial, contact) => store().putSyncedContact(wardId, serial, contact);
