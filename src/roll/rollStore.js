// Encrypted on-device copy of a decoded ward roll.
//
// - Only STORED_FIELDS of each entry are kept, for every entry of the roll:
//   struck-off entries are stored too, with struck: true, so the list shows
//   them struck off. The PDF bytes, EPIC numbers and page numbers are never
//   written.
// - The record carries a schema version (RECORD_VERSION). A record of an
//   older version is not read (loadStored returns null, so the roll is
//   decoded again); a version this code does not know is reported with a
//   RollRecordVersionError instead of being guessed at.
// - The entries are encrypted with WebCrypto AES-GCM (256-bit key, fresh
//   12-byte IV per write, the ward key as additional data) and stored in
//   IndexedDB.
// - The key is the shared device key (src/crypto/deviceKey.js): generated on
//   the device with extractable: false and kept in IndexedDB as a CryptoKey
//   object, so its bytes can never be read by script. The contact store
//   (src/contacts/contactStore.js), the call-assignment store
//   (src/calls/assignmentStore.js) and the official-turnout store
//   (src/tally/turnoutStore.js) use this same key and AES-GCM handling.
//
// No network access: reopening a stored ward works offline.

import {
  DB_NAME, KEYS_STORE, ROLLS_STORE, META_STORE, complete, createDbOpener, readValue,
} from '../storage/deviceDb.js';
import { createDeviceKeyLoader } from '../crypto/deviceKey.js';

export { DB_NAME, KEYS_STORE, ROLLS_STORE, META_STORE };
const LAST_WARD = 'last-ward';
// 1: live entries only, without struck. 2: every entry, with struck.
export const RECORD_VERSION = 2;
const OLD_VERSIONS = new Set([1]);

export const STORED_FIELDS = Object.freeze(['serial', 'name', 'relative', 'age', 'gender', 'house', 'struck']);

/** A stored roll record whose schema version this code does not know. */
export class RollRecordVersionError extends Error {
  constructor(version) {
    super(`stored roll record has unknown schema version ${JSON.stringify(version)}`);
    this.name = 'RollRecordVersionError';
    this.version = version;
  }
}

/** Stable storage key for a ward selection {district, samiti, panchayat, ward}. */
export function wardKeyFor(selection) {
  return [selection.district, selection.samiti, selection.panchayat, selection.ward].join('/');
}

/** Keep only STORED_FIELDS of every entry, struck-off ones included. */
export function minimiseEntries(entries) {
  if (!Array.isArray(entries)) throw new TypeError('entries must be an array');
  const out = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    if (!Number.isFinite(entry.serial)) continue;
    out.push({
      serial: entry.serial,
      name: typeof entry.name === 'string' ? entry.name : '',
      relative: typeof entry.relative === 'string' ? entry.relative : '',
      age: Number.isFinite(entry.age) ? entry.age : null,
      gender: typeof entry.gender === 'string' ? entry.gender : '',
      house: entry.house == null ? '' : String(entry.house),
      struck: entry.struck === true,
    });
  }
  return out;
}

/**
 * @param {{indexedDB?: IDBFactory, crypto?: Crypto}} [deps] defaults to the
 *   browser globals; tests pass fakes
 */
export function createRollStore({ indexedDB = globalThis.indexedDB, crypto = globalThis.crypto } = {}) {
  const encoder = new TextEncoder();
  const db = createDbOpener(indexedDB);
  // The device key: created once, non-extractable, shared by every store.
  const deviceKey = createDeviceKeyLoader({ db, crypto });

  /**
   * Encrypt and store a ward's entries; remembers it as the last opened ward.
   * @returns {Promise<object[]>} the minimised entries that were stored
   */
  async function encryptAndStore(wardKey, entries) {
    if (typeof wardKey !== 'string' || !wardKey) throw new TypeError('wardKey must be a non-empty string');
    const minimal = minimiseEntries(entries);
    const key = await deviceKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: encoder.encode(wardKey) },
      key,
      encoder.encode(JSON.stringify(minimal)),
    );
    const tx = (await db()).transaction([ROLLS_STORE, META_STORE], 'readwrite');
    const done = complete(tx);
    tx.objectStore(ROLLS_STORE).put({ v: RECORD_VERSION, iv, data }, wardKey);
    tx.objectStore(META_STORE).put(wardKey, LAST_WARD);
    await done;
    return minimal;
  }

  /**
   * Decrypt a stored ward's entries, or null when none is stored or the
   * stored record is of an older version (decode the roll again).
   * @throws {RollRecordVersionError} for a version this code does not know
   */
  async function loadStored(wardKey) {
    const record = await readValue(db, ROLLS_STORE, wardKey);
    if (!record) return null;
    if (OLD_VERSIONS.has(record.v)) return null;
    if (record.v !== RECORD_VERSION) throw new RollRecordVersionError(record.v);
    const key = await deviceKey();
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: record.iv, additionalData: encoder.encode(wardKey) },
      key,
      record.data,
    );
    return minimiseEntries(JSON.parse(new TextDecoder().decode(plain)));
  }

  /** Key of the ward stored most recently, or null. */
  async function lastWardKey() {
    const value = await readValue(db, META_STORE, LAST_WARD);
    return typeof value === 'string' ? value : null;
  }

  return { encryptAndStore, loadStored, lastWardKey };
}

let defaultStore = null;
const store = () => (defaultStore ||= createRollStore());

export const encryptAndStore = (wardKey, entries) => store().encryptAndStore(wardKey, entries);
export const loadStored = (wardKey) => store().loadStored(wardKey);
export const lastWardKey = () => store().lastWardKey();
