// Encrypted on-device copy of a decoded ward roll.
//
// - Only STORED_FIELDS of each entry are kept, struck-off entries included
//   (with struck: true) so the roll matches the printed PDF line for line;
//   the PDF bytes, EPIC numbers and page numbers are never written.
// - Each record carries RECORD_VERSION. A record of an older known version
//   (OLD_RECORD_VERSIONS) is never read: readStored reports it as stale, so
//   the ward is fetched and decoded again; any other version is a
//   RollRecordVersionError, never a guess.
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
// v1: live entries only, without `struck`. v2: every entry, with `struck`.
export const RECORD_VERSION = 2;
const OLD_RECORD_VERSIONS = new Set([1]);

export const STORED_FIELDS = Object.freeze(['serial', 'name', 'relative', 'age', 'gender', 'house', 'struck']);

/** A stored roll record whose schema version this build does not know. */
export class RollRecordVersionError extends Error {
  constructor(wardKey, version) {
    super(`stored roll ${wardKey} has unknown record version ${JSON.stringify(version)}`);
    this.name = 'RollRecordVersionError';
    this.wardKey = wardKey;
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
   * Read a stored ward in one read: {entries, stale}. entries is null when
   * none is stored or when the copy is of an older version, which is never
   * read; stale is true in that second case (the caller decodes the roll
   * again). Rejects with RollRecordVersionError for a version it does not
   * know.
   */
  async function readStored(wardKey) {
    const record = await readValue(db, ROLLS_STORE, wardKey);
    if (!record) return { entries: null, stale: false };
    if (OLD_RECORD_VERSIONS.has(record.v)) return { entries: null, stale: true };
    if (record.v !== RECORD_VERSION) throw new RollRecordVersionError(wardKey, record.v);
    const key = await deviceKey();
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: record.iv, additionalData: encoder.encode(wardKey) },
      key,
      record.data,
    );
    return { entries: minimiseEntries(JSON.parse(new TextDecoder().decode(plain))), stale: false };
  }

  /** A stored ward's entries, or null (none stored, or an older version). */
  async function loadStored(wardKey) {
    return (await readStored(wardKey)).entries;
  }

  /** Key of the ward stored most recently, or null. */
  async function lastWardKey() {
    const value = await readValue(db, META_STORE, LAST_WARD);
    return typeof value === 'string' ? value : null;
  }

  return { encryptAndStore, readStored, loadStored, lastWardKey };
}

let defaultStore = null;
const store = () => (defaultStore ||= createRollStore());

export const encryptAndStore = (wardKey, entries) => store().encryptAndStore(wardKey, entries);
export const loadStored = (wardKey) => store().loadStored(wardKey);
export const lastWardKey = () => store().lastWardKey();
export const readStored = (wardKey) => store().readStored(wardKey);
